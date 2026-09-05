import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { runStatusCommand } from "../../dist/cli/status-command.js";
import {
  deriveRunActivity,
  inspectStatus,
} from "../../dist/orchestration/status.js";

const T0 = "2026-08-30T00:00:00.000Z";

function run(overrides = {}) {
  return {
    run_id: "run_1",
    network_id: "net",
    business_key: "net@1",
    status: "UNKNOWN",
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    created_at: T0,
    started_at: T0,
    finished_at: null,
    updated_at: T0,
    resolved_profile_snapshot: { profile: "prod" },
    ...overrides,
  };
}

function repositoryFixture(overrides = {}) {
  const writes = [];
  const runs = [
    { value: run(), revision: 1 },
    { value: run({ run_id: "run_2", business_key: "net@2" }), revision: 1 },
  ];
  return {
    writes,
    async getRun(runId) {
      return runs.find(({ value }) => value.run_id === runId);
    },
    async getRunByBusinessKey(_profile, _networkId, businessKey) {
      return (
        runs.find(({ value }) => value.business_key === businessKey) ?? null
      );
    },
    async listRuns() {
      return runs;
    },
    async getInvocations() {
      return [
        {
          value: {
            invocation_id: "invoke_1",
            mode: "RESUME",
            status: "UNKNOWN",
            result_code: overrides.invocationResultCode ?? "LEASE_EXPIRED",
            started_at: T0,
          },
          revision: 1,
        },
      ];
    },
    async getNodeStates() {
      return [
        {
          value: {
            node_id: "unknown_node",
            status: "UNKNOWN",
            status_reason: overrides.nodeResultCode ?? "result unavailable",
            idempotent: false,
            latest_attempt_no: 1,
            active_attempt_id: null,
            revision: 2,
          },
          revision: 2,
        },
        {
          value: {
            node_id: "active_node",
            status: "RUNNING",
            status_reason: null,
            idempotent: true,
            latest_attempt_no: 1,
            active_attempt_id: "attempt_2",
            revision: 2,
          },
          revision: 2,
        },
      ];
    },
    async getAttempts() {
      return [
        {
          value: {
            node_attempt_id: "attempt_1",
            node_id: "unknown_node",
            attempt_no: 1,
            status: "UNKNOWN",
            result_code: overrides.nodeResultCode ?? "NO_EXECUTION_RESULT",
            state_revision_before: 1,
          },
          revision: 1,
        },
        {
          value: {
            node_attempt_id: "attempt_2",
            node_id: "active_node",
            attempt_no: 1,
            status: "RUNNING",
            result_code: "PENDING",
            state_revision_before: 1,
          },
          revision: 1,
        },
      ];
    },
    async getResolutions() {
      return [];
    },
    async getCancelRequest() {
      return overrides.cancelRequest ?? null;
    },
    async upsertNodeState(value) {
      writes.push(value);
      throw new Error("status must not write");
    },
    async updateRunAggregate(value) {
      writes.push(value);
      throw new Error("status must not write");
    },
    async appendOperationAudit(value) {
      writes.push(value);
      throw new Error("status must not write");
    },
  };
}

test("holdはcancel state 4通りで終端/非終端のlist/detail双方に必須", async () => {
  for (const state of ["REQUESTED", "ACCEPTED", "RELEASED", null]) {
    for (const terminal of [false, true]) {
      const cancelRequest =
        state === null
          ? null
          : {
              value: {
                run_id: "run_1",
                state,
                requested_by: "operator",
                requested_at: T0,
              },
              revision: 1,
            };
      for (const detail of [false, true]) {
        const repository = repositoryFixture({ cancelRequest });
        if (terminal) {
          const original = repository.getRun;
          repository.getRun = async (id) => {
            const found = await original(id);
            return {
              ...found,
              value: { ...found.value, status: "FAILED", finished_at: T0 },
            };
          };
          repository.listRuns = async () => [
            { value: run({ status: "FAILED", finished_at: T0 }), revision: 1 },
          ];
        }
        const output = await inspectStatus(
          {
            networkId: "net",
            profile: "prod",
            ...(detail ? { runId: "run_1" } : {}),
          },
          {
            repository,
            lockReader: {
              async getNetworkLock() {
                return null;
              },
            },
          },
        );
        assert.deepEqual(
          output.runs[0].hold,
          state === "REQUESTED" || state === "ACCEPTED"
            ? { state, requested_by: "operator", requested_at: T0 }
            : null,
        );
        assert.ok(Object.hasOwn(output.runs[0], "hold"));
      }
    }
  }
});

test("shared status-activity vectors cover every activity and lease boundary", () => {
  const vectors = JSON.parse(
    readFileSync(
      new globalThis.URL(
        "../fixtures/status-activity/vectors.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const nowMs = Date.parse("2026-08-31T01:00:00Z");
  for (const vector of vectors) {
    const owner = vector.lock?.owner_belongs ? "invoke_1" : "invoke_other";
    const lock =
      vector.lock === null
        ? null
        : {
            record_id: "lock_1",
            owner_invocation_id: owner,
            owner_instance_id: "host",
            heartbeat_at: T0,
            lease_expires_at: new Date(
              nowMs + vector.lock.lease_relative_seconds * 1000,
            ).toISOString(),
            revision: 1,
          };
    assert.equal(
      deriveRunActivity({
        status: vector.status,
        startedAt: vector.started_at,
        invocationIds: ["invoke_1"],
        lock,
        cancelState: vector.cancel_state,
        nowMs,
      }),
      vector.expected,
      vector.name,
    );
  }
  assert.deepEqual(
    new Set(vectors.map(({ expected }) => expected)),
    new Set([null, "STOPPED", "LIVE", "IDLE", "INTERRUPTED"]),
  );
});

function lockReader(value) {
  return {
    async getNetworkLock() {
      return value;
    },
  };
}

test("specified Run detail is read-only and includes recovery identifiers and active Attempt", async () => {
  const repository = repositoryFixture();
  const output = await inspectStatus(
    { networkId: "net", profile: "prod", runId: "run_1" },
    {
      repository,
      lockReader: lockReader({
        record_id: "10",
        owner_invocation_id: "invoke_owner",
        owner_instance_id: "host-1",
        heartbeat_at: T0,
        lease_expires_at: "2026-08-30T00:00:59.000Z",
        revision: 4,
        lease_token: "must-never-leak",
      }),
      now: () => new Date("2026-08-30T00:02:00.000Z"),
    },
  );
  assert.equal(output.lock.stale_candidate, true);
  assert.equal(output.runs[0].invocations[0].invocation_id, "invoke_1");
  assert.deepEqual(output.runs[0].node_states[1].active_attempt, {
    node_attempt_id: "attempt_2",
    attempt_no: 1,
    status: "RUNNING",
    result_code: "PENDING",
  });
  assert.deepEqual(output.runs[0].node_states[0].latest_attempt, {
    node_attempt_id: "attempt_1",
    attempt_no: 1,
    status: "UNKNOWN",
    result_code: "NO_EXECUTION_RESULT",
  });
  assert.deepEqual(output.runs[0].recovery_identifiers.resolve_node, [
    { run_id: "run_1", node_id: "unknown_node" },
  ]);
  assert.equal(repository.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(output), /lease_token|must-never-leak/);
});

test("stale_candidateはDATETIMEの分精度切り捨て上限を加味する", async () => {
  const cases = [
    ["2026-08-30T00:01:01.000Z", false],
    ["2026-08-30T00:00:59.000Z", true],
    ["2026-08-30T00:03:00.000Z", false],
  ];

  for (const [leaseExpiresAt, expected] of cases) {
    const output = await inspectStatus(
      { networkId: "net", profile: "prod" },
      {
        repository: repositoryFixture(),
        lockReader: lockReader({
          record_id: "10",
          owner_invocation_id: "invoke_owner",
          owner_instance_id: "host-1",
          heartbeat_at: T0,
          lease_expires_at: leaseExpiresAt,
          revision: 4,
        }),
        now: () => new Date("2026-08-30T00:02:00.000Z"),
      },
    );
    assert.equal(output.lock.stale_candidate, expected, leaseExpiresAt);
  }
});

test("list mode returns summaries and represents an absent lock as null", async () => {
  const output = await inspectStatus(
    { networkId: "net", profile: "prod" },
    { repository: repositoryFixture(), lockReader: lockReader(null) },
  );
  assert.equal(output.lock, null);
  assert.deepEqual(
    output.runs.map(({ run_id }) => run_id),
    ["run_1", "run_2"],
  );
  assert.equal(output.runs[0].node_states, undefined);
});

test("status CLI validates exclusive selectors, duplicates, and unknown options", async (context) => {
  const stderr = [];
  context.mock.method(process.stderr, "write", (value) => {
    stderr.push(String(value));
    return true;
  });
  const dependencies = {
    repository: repositoryFixture(),
    lockReader: lockReader(null),
  };
  assert.equal(
    await runStatusCommand(
      ["net", "--profile", "prod", "--run-id", "r", "--business-key", "b"],
      dependencies,
    ),
    1,
  );
  assert.equal(
    await runStatusCommand(
      ["net", "--profile", "prod", "--profile", "prod"],
      dependencies,
    ),
    1,
  );
  assert.equal(
    await runStatusCommand(
      ["net", "--profile", "prod", "--bogus"],
      dependencies,
    ),
    1,
  );
  assert.match(stderr.join(""), /mutually exclusive/);
  assert.match(stderr.join(""), /specified more than once/);
  assert.match(stderr.join(""), /unknown option/);
});

test("JSON and text modes render from the same status result", async (context) => {
  const stdout = [];
  context.mock.method(process.stdout, "write", (value) => {
    stdout.push(String(value));
    return true;
  });
  const dependencies = {
    repository: repositoryFixture(),
    lockReader: lockReader(null),
  };
  assert.equal(
    await runStatusCommand(
      ["net", "--profile", "prod", "--json"],
      dependencies,
    ),
    0,
  );
  const json = JSON.parse(stdout.pop());
  assert.equal(json.runs[0].run_id, "run_1");
  assert.equal(
    await runStatusCommand(["net", "--profile", "prod"], dependencies),
    0,
  );
  assert.match(stdout.pop(), /run_id: run_1/);
});

test("status --jsonは入力失敗のInvocation/Attempt result codeを識別できる", async (context) => {
  const stdout = [];
  context.mock.method(process.stdout, "write", (value) => {
    stdout.push(String(value));
    return true;
  });
  for (const code of ["INPUT_FILE_MISSING", "INPUT_FILE_MUTATED"]) {
    assert.equal(
      await runStatusCommand(
        ["net", "--profile", "prod", "--run-id", "run_1", "--json"],
        {
          repository: repositoryFixture({
            invocationResultCode: code,
            nodeResultCode: code,
          }),
          lockReader: lockReader(null),
        },
      ),
      0,
    );
    const detail = JSON.parse(stdout.pop()).runs[0];
    assert.equal(detail.invocations[0].result_code, code);
    assert.equal(detail.node_states[0].status_reason, code);
    assert.equal(detail.node_states[0].latest_attempt.result_code, code);
  }
});
