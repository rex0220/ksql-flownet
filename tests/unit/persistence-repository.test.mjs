import assert from "node:assert/strict";
import test from "node:test";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";
import { RepositoryError } from "../../dist/persistence/repository.js";
import { isAllowedNodeStateTransition } from "../../dist/persistence/state-transition.js";

const statuses = [
  "WAITING",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
  "CANCELLED",
  "UNKNOWN",
];
const allowed = new Set([
  "WAITING>WAITING",
  "WAITING>RUNNING",
  "WAITING>BLOCKED",
  "RUNNING>RUNNING",
  "RUNNING>WAITING",
  "RUNNING>SUCCESS",
  "RUNNING>FAILED",
  "RUNNING>CANCELLED",
  "RUNNING>UNKNOWN",
  "SUCCESS>SUCCESS",
  "SUCCESS>WAITING",
  "FAILED>FAILED",
  "FAILED>WAITING",
  "BLOCKED>BLOCKED",
  "BLOCKED>WAITING",
  "SKIPPED>SKIPPED",
  "CANCELLED>CANCELLED",
  "CANCELLED>WAITING",
  "UNKNOWN>UNKNOWN",
  "UNKNOWN>SUCCESS",
  "UNKNOWN>FAILED",
  "UNKNOWN>CANCELLED",
]);

function makeRun(overrides = {}) {
  return {
    run_id: "run_1",
    network_id: "net",
    business_key: "net@1",
    max_active_runs: 1,
    status: "CREATED",
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: null,
    definition_schema_version: 1,
    definition_sha256: "sha256:def",
    source_bundle_sha256: "sha256:bundle",
    source_bundle_attachment: "file-key",
    resolved_profile_snapshot: {
      profile: "prod",
      base_url: "https://example.cybozu.com",
      guest_space_id: null,
      timezone: "Asia/Tokyo",
      apps: { data: 1 },
      limits: {
        max_api_calls: 5000,
        max_read_rows: 200000,
        batch_timeout_sec: 3600,
      },
    },
    resolved_profile_sha256: "sha256:profile",
    ksql_flow_version: "1",
    engine_version: "3",
    dialect: 1,
    created_at: "2026-08-30T00:00:00Z",
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-30T00:00:00Z",
    ...overrides,
  };
}

function makeState(status = "WAITING", overrides = {}) {
  return {
    node_state_id: "state_1",
    node_state_key: nodeStateKey("run_1", "node_1"),
    run_id: "run_1",
    node_id: "node_1",
    job_id: "job_1",
    status,
    latest_attempt_no: 0,
    active_attempt_id: null,
    revision: 1,
    idempotent: true,
    trigger_rule: "all_success",
    blocked_by: [],
    status_reason: null,
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-30T00:00:00Z",
    ...overrides,
  };
}

test("仕様§5.3の全status対について許可・禁止を固定する", () => {
  for (const from of statuses)
    for (const to of statuses) {
      assert.equal(
        isAllowedNodeStateTransition(from, to),
        allowed.has(`${from}>${to}`),
        `${from} -> ${to}`,
      );
    }
});

test("fake: run business key検索とaggregate revision競合", async () => {
  const repository = new InMemoryPersistenceRepository();
  const created = await repository.createRun(makeRun());
  assert.equal(
    (await repository.getRunByBusinessKey("prod", "net", "net@1")).value.run_id,
    "run_1",
  );
  const updated = await repository.updateRunAggregate(
    "run_1",
    created.revision,
    {
      status: "RUNNING",
      started_at: "2026-08-30T00:00:01Z",
      finished_at: null,
      updated_at: "2026-08-30T00:00:01Z",
    },
  );
  assert.equal(updated.revision, 2);
  await assert.rejects(
    repository.updateRunAggregate("run_1", created.revision, {
      status: "FAILED",
      started_at: null,
      finished_at: null,
      updated_at: "2026-08-30T00:00:02Z",
    }),
    (error) =>
      error instanceof RepositoryError && error.code === "REVISION_CONFLICT",
  );
});

test("fake: 同一Node State snapshotからの同時採番は片方だけ成功し他方fail-closed", async () => {
  const repository = new InMemoryPersistenceRepository();
  const state = await repository.upsertNodeState({
    value: makeState(),
    expected_revision: null,
  });
  const results = await Promise.allSettled([
    repository.createAttempt({
      node_state: state,
      node_attempt_id: "attempt_a",
      invocation_id: "invoke_a",
    }),
    repository.createAttempt({
      node_state: state,
      node_attempt_id: "attempt_b",
      invocation_id: "invoke_b",
    }),
  ]);
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "ATTEMPT_NUMBER_CONFLICT");
  const winner = results.find(({ status }) => status === "fulfilled").value;
  assert.equal(winner.value.attempt_no, 1);
  assert.equal(winner.value.state_revision_before, state.revision);
});

test("fake: Attempt lifecycleは開始時刻を一度だけ設定しterminal後の変更を拒否", async () => {
  const repository = new InMemoryPersistenceRepository();
  const state = await repository.upsertNodeState({
    value: makeState(),
    expected_revision: null,
  });
  const attempt = await repository.createAttempt({
    node_state: state,
    node_attempt_id: "attempt_1",
    invocation_id: "invoke_1",
  });
  const started = await repository.setAttemptExecutionStarted(
    "attempt_1",
    attempt.revision,
    { execution_started_at: "2026-08-30T00:00:01Z" },
  );
  const terminal = await repository.finalizeAttempt(
    "attempt_1",
    started.revision,
    {
      status: "SUCCESS",
      result_code: "OK",
      runner_execution_started_at: "2026-08-30T00:00:02Z",
      execution_id: "exec_1",
      finished_at: "2026-08-30T00:00:03Z",
      duration_sec: 2,
      error_message: null,
      read_count: 1,
      written_count: 1,
      last_successful_chunk_no: 1,
      last_written_key: "K1",
    },
  );
  assert.equal(terminal.value.status, "SUCCESS");
  await assert.rejects(
    repository.finalizeAttempt("attempt_1", terminal.revision, {
      ...terminal.value,
      status: "FAILED",
      finished_at: "2026-08-30T00:00:04Z",
    }),
    (error) =>
      error instanceof RepositoryError && error.code === "ATTEMPT_TERMINAL",
  );
  await assert.rejects(
    repository.setAttemptExecutionStarted("attempt_1", terminal.revision, {
      execution_started_at: "2026-08-30T00:00:05Z",
    }),
    (error) =>
      error instanceof RepositoryError && error.code === "ATTEMPT_TERMINAL",
  );
});

test("fake: 禁止遷移と非冪等resumeを安定codeで拒否する", async () => {
  const repository = new InMemoryPersistenceRepository();
  const waiting = await repository.upsertNodeState({
    value: makeState(),
    expected_revision: null,
  });
  await assert.rejects(
    repository.upsertNodeState({
      value: makeState("SUCCESS"),
      expected_revision: waiting.revision,
    }),
    (error) =>
      error instanceof RepositoryError &&
      error.code === "INVALID_STATE_TRANSITION",
  );
  const failedRepository = new InMemoryPersistenceRepository();
  const initial = await failedRepository.upsertNodeState({
    value: makeState(),
    expected_revision: null,
  });
  const running = await failedRepository.upsertNodeState({
    value: makeState("RUNNING"),
    expected_revision: initial.revision,
  });
  const failed = await failedRepository.upsertNodeState({
    value: makeState("FAILED", { idempotent: false }),
    expected_revision: running.revision,
  });
  await assert.rejects(
    failedRepository.upsertNodeState({
      value: makeState("WAITING", { idempotent: false }),
      expected_revision: failed.revision,
    }),
    (error) =>
      error instanceof RepositoryError &&
      error.code === "INVALID_STATE_TRANSITION",
  );
});
