import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pollRequests } from "../../dist/requests/request-poller.js";

const NOW = "2026-09-02T03:00:00.000Z";

function request(overrides = {}) {
  return {
    id: "101",
    revision: 1,
    creatorCode: "operator@example.test",
    createdAt: "2026-09-02T02:00:00Z",
    requestType: "START",
    runId: "",
    networkId: "net-a",
    businessKey: "manual-key",
    scheduledFor: null,
    rerunFromNode: null,
    reason: "start approved job",
    requestState: "REQUESTED",
    claimedAt: null,
    claimedHost: null,
    claimHeartbeatAt: null,
    resultCode: null,
    resultMessage: null,
    ...overrides,
  };
}

function definition(context, { policy = "explicit", idempotent = "true" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "flownet-start-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "network.yaml");
  const policyYaml =
    policy === "explicit"
      ? "  type: explicit"
      : '  type: scheduled_period\n  period: month\n  timezone: Asia/Tokyo\n  format: "{network_id}@{yyyy}-{MM}"';
  const idempotentLine =
    idempotent === "omitted" ? "" : `    idempotent: ${idempotent}\n`;
  writeFileSync(
    path,
    `schema_version: 1
network_id: net-a
business_key_policy:
${policyYaml}
network_lock:
  lease_duration_sec: 3
  heartbeat_interval_sec: 1
nodes:
  - id: one
    job_id: job_one
    sql: one.sql
    depends_on: []
    trigger_rule: all_success
${idempotentLine}`,
  );
  return path;
}

const processResult = (overrides = {}) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

async function runCase(context, {
  requestValue = request(),
  requestedRecords,
  acceptedRecords = [],
  networkOptions,
  networks,
  output,
  startNetwork,
  statusFor,
} = {}) {
  const definitionPath = definition(context, networkOptions);
  const configuredNetworks =
    networks ?? [
      { networkId: "net-a", definitionPath, appStart: true },
    ];
  const calls = [];
  const results = [];
  const store = {
    async listRequested() {
      return { valid: requestedRecords ?? [requestValue], invalid: [], skipped: 0 };
    },
    async listAccepted() {
      return acceptedRecords;
    },
    async rejectInvalid() {},
    async claim(value) {
      return {
        ...value,
        revision: value.revision + 1,
        requestState: "ACCEPTED",
        claimedAt: NOW,
        claimedHost: "poller-a",
        claimHeartbeatAt: NOW,
      };
    },
    async heartbeat(value) {
      return value;
    },
    async writeResult(value, result) {
      results.push({ value, result });
    },
  };
  const child = {
    async status(network, selector) {
      calls.push({ method: "status", network, selector });
      return statusFor?.(network, selector) ?? null;
    },
    async runNetwork() {
      throw new Error("RERUN child must not be used for START");
    },
    async cancelRun() {
      throw new Error("cancel child must not be used for START");
    },
    async startNetwork(network, value, input) {
      calls.push({ method: "startNetwork", network, value, input });
      if (startNetwork) return startNetwork(network, value, input);
      return {
        output: output ?? {
          outcome: "NEW",
          run_id: "run-new",
          invocation_id: "invoke-new",
          aggregate_status: "SUCCESS",
          invocation_result_code: "OK",
          blocked_run_ids: [],
        },
        process: processResult(),
      };
    },
  };
  await pollRequests({
    store,
    child,
    config: {
      networks: configuredNetworks,
      heartbeatIntervalMs: 100,
      staleAfterMs: 900_000,
      stalePrecisionAllowanceMs: 60_000,
    },
    host: "poller-a",
    now: () => new Date(NOW),
  });
  return { calls, results, result: results[0]?.result, definitionPath };
}

test("S01 allowlist未掲載", async (context) => {
  const actual = await runCase(context, { networks: [] });
  assert.equal(actual.result.code, "NETWORK_NOT_ALLOWED");
  assert.match(actual.result.message, /NOT_IN_ALLOWLIST/u);
  assert.equal(actual.calls.length, 0);
});

test("S02 app_start無効", async (context) => {
  const definitionPath = definition(context);
  const actual = await runCase(context, {
    networks: [{ networkId: "net-a", definitionPath, appStart: false }],
  });
  assert.equal(actual.result.code, "NETWORK_NOT_ALLOWED");
  assert.match(actual.result.message, /APP_START_DISABLED/u);
  assert.equal(actual.calls.length, 0);
});

test("S03 非冪等(false・未指定)", async (context) => {
  for (const idempotent of ["false", "omitted"]) {
    const actual = await runCase(context, { networkOptions: { idempotent } });
    assert.equal(actual.result.code, "NETWORK_NOT_IDEMPOTENT");
    assert.equal(actual.calls.length, 0);
  }
});

test("S04 run_id記入", async (context) => {
  const actual = await runCase(context, {
    requestValue: request({ runId: "run-existing" }),
  });
  assert.equal(actual.result.code, "RUN_ID_NOT_ALLOWED");
  assert.equal(actual.calls.length, 0);
});

test("S05 explicit + business_key", async (context) => {
  const actual = await runCase(context);
  assert.equal(actual.result.state, "DONE");
  assert.equal(actual.result.code, "OK");
  assert.deepEqual(actual.calls[0].input, { businessKey: "manual-key" });
});

test("S06 explicit + scheduled_for含む", async (context) => {
  const actual = await runCase(context, {
    requestValue: request({ scheduledFor: "2026-08-01T00:00:00Z" }),
  });
  assert.equal(actual.result.code, "KEY_POLICY_MISMATCH");
  assert.equal(actual.calls.length, 0);
});

test("S07 scheduled_period + scheduled_for単独", async (context) => {
  const actual = await runCase(context, {
    networkOptions: { policy: "scheduled" },
    requestValue: request({ businessKey: null, scheduledFor: "2026-07-31T15:00:00Z" }),
  });
  assert.deepEqual(actual.calls[0].input, {
    scheduledFor: "2026-07-31T15:00:00.000Z",
  });
  assert.equal(actual.result.state, "DONE");
});

test("S08 scheduled_period correction", async (context) => {
  const actual = await runCase(context, {
    networkOptions: { policy: "scheduled" },
    requestValue: request({ businessKey: "correction-1", scheduledFor: "2026-07-31T15:00:00Z" }),
  });
  assert.deepEqual(actual.calls[0].input, {
    scheduledFor: "2026-07-31T15:00:00.000Z",
    businessKey: "correction-1",
  });
  assert.equal(actual.result.state, "DONE");
});

test("S09 scheduled_period + business_key単独", async (context) => {
  const actual = await runCase(context, { networkOptions: { policy: "scheduled" } });
  assert.equal(actual.result.code, "AS_OF_UNDEFINED");
  assert.equal(actual.calls.length, 0);
});

test("S10 両方欠落", async (context) => {
  const actual = await runCase(context, {
    requestValue: request({ businessKey: null, scheduledFor: null }),
  });
  assert.equal(actual.result.code, "KEY_POLICY_MISMATCH");
  assert.equal(actual.calls.length, 0);
});

test("S11 不正日時(日付のみ・offsetなし・実在しない日時)", async (context) => {
  for (const scheduledFor of ["2026-08-01", "2026-08-01T00:00:00", "2026-02-30T00:00:00Z"]) {
    const actual = await runCase(context, {
      networkOptions: { policy: "scheduled" },
      requestValue: request({ businessKey: null, scheduledFor }),
    });
    assert.equal(actual.result.code, "INVALID_TIMESTAMP_FORMAT");
    assert.equal(actual.calls.length, 0);
  }
});

test("S12 同一キーSUCCESS", async (context) => {
  const actual = await runCase(context, {
    output: {
      outcome: "NOOP", run_id: "run-success", invocation_id: null,
      aggregate_status: "SUCCESS", invocation_result_code: "NOOP_ALREADY_SUCCESS",
    },
  });
  assert.equal(actual.result.state, "DONE");
  assert.equal(actual.result.code, "NOOP_ALREADY_SUCCESS");
  assert.match(actual.result.message, /既存Run #run-success.*スキップ.*補正/u);
});

test("S13 同一キー未完了", async (context) => {
  const actual = await runCase(context, {
    output: {
      outcome: "REJECTED", run_id: null, invocation_id: null,
      aggregate_status: null, invocation_result_code: "RUN_ALREADY_EXISTS",
      blocked_run_ids: ["run-active"],
    },
  });
  assert.equal(actual.result.state, "REJECTED");
  assert.equal(actual.result.code, "RUN_ALREADY_EXISTS");
  assert.match(actual.result.message, /#run-active.*RERUN/u);
});

test("S14 別キー未完了max超過", async (context) => {
  const actual = await runCase(context, {
    output: {
      outcome: "REJECTED", run_id: null, invocation_id: null,
      aggregate_status: null, invocation_result_code: "MAX_ACTIVE_RUNS",
      blocked_run_ids: ["run-blocker"],
    },
  });
  assert.equal(actual.result.code, "MAX_ACTIVE_RUNS");
  assert.equal(actual.result.message, "未完了Run #run-blockerがあるため起動できません。失敗Runのやり直しはRERUNを、整理できない場合は二次対応者へ");
});

test("S15 上限通過後の別キーlock競合", async (context) => {
  const actual = await runCase(context, {
    output: {
      outcome: "REJECTED", run_id: null, invocation_id: null,
      aggregate_status: null, invocation_result_code: "LOCK_CONFLICT",
      blocked_run_ids: [],
    },
  });
  assert.equal(actual.result.code, "LOCK_CONFLICT");
  assert.match(actual.result.message, /時間をおいて再起票/u);
  assert.doesNotMatch(actual.result.message, /MAX_ACTIVE_RUNS|二次対応者/u);
});

test("START staleはnetwork直接解決と再導出business keyでstatus照合し非LIVEだけ終端する", async (context) => {
  const stale = request({
    requestState: "ACCEPTED",
    revision: 2,
    claimedAt: "2026-09-02T02:00:00Z",
    claimedHost: "old-poller",
    claimHeartbeatAt: "2026-09-02T02:00:00Z",
  });
  const actual = await runCase(context, {
    requestedRecords: [],
    acceptedRecords: [stale],
    statusFor(_network, selector) {
      assert.deepEqual(selector, { businessKey: "manual-key" });
      return {
        network_id: "net-a",
        profile: "prod",
        lock: null,
        runs: [{
          run_id: "run-started",
          business_key: "manual-key",
          status: "FAILED",
          resume_allowed: true,
          lifecycle_status: "ACTIVE",
          created_at: NOW,
          started_at: NOW,
          finished_at: NOW,
          updated_at: NOW,
          activity: "STOPPED",
        }],
      };
    },
  });
  assert.equal(actual.results.length, 1);
  assert.equal(actual.result.code, "STALE");
  assert.equal(actual.calls.filter(({ method }) => method === "startNetwork").length, 0);
});

test("START staleはstatus取得不能・キー再導出不能・複数一致をfail-closedで更新しない", async (context) => {
  const stale = request({
    requestState: "ACCEPTED",
    revision: 2,
    claimedAt: "2026-09-02T02:00:00Z",
    claimedHost: "old-poller",
    claimHeartbeatAt: "2026-09-02T02:00:00Z",
  });
  for (const variant of ["none", "multiple", "key-invalid"]) {
    const actual = await runCase(context, {
      requestedRecords: [],
      acceptedRecords: [variant === "key-invalid" ? { ...stale, businessKey: null } : stale],
      statusFor() {
        if (variant === "none") return null;
        const row = {
          run_id: "run-started", business_key: "manual-key", status: "FAILED",
          resume_allowed: true, lifecycle_status: "ACTIVE", created_at: NOW,
          started_at: NOW, finished_at: NOW, updated_at: NOW,
        };
        return { network_id: "net-a", profile: "prod", lock: null, runs: [row, { ...row, run_id: "run-duplicate" }] };
      },
    });
    assert.equal(actual.results.length, 0);
  }
});
