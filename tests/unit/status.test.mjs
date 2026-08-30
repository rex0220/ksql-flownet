import assert from "node:assert/strict";
import test from "node:test";

import { runStatusCommand } from "../../dist/cli/status-command.js";
import { inspectStatus } from "../../dist/orchestration/status.js";

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

function repositoryFixture() {
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
            result_code: "LEASE_EXPIRED",
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
            status_reason: "result unavailable",
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
            state_revision_before: 1,
          },
          revision: 1,
        },
      ];
    },
    async getResolutions() {
      return [];
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
