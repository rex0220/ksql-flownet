import assert from "node:assert/strict";
import test from "node:test";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import { recordJobUnlock } from "../../dist/orchestration/job-lock-audit.js";
import { reconcileRun } from "../../dist/orchestration/reconciliation.js";
import {
  resolveNode,
  ResolveNodeError,
} from "../../dist/orchestration/resolve-node.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";

const at = "2026-08-30T12:00:00.000Z";

function run() {
  return {
    run_id: "run_12",
    network_id: "network_12",
    business_key: "network_12@one",
    max_active_runs: 1,
    status: "UNKNOWN",
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: null,
    definition_schema_version: 1,
    definition_sha256: "d".repeat(64),
    source_bundle_sha256: "b".repeat(64),
    source_bundle_attachment: "file-key",
    resolved_profile_snapshot: {
      profile: "prod",
      base_url: "https://example.test",
      guest_space_id: null,
      timezone: "Asia/Tokyo",
      apps: {},
      limits: {
        max_api_calls: null,
        max_read_rows: null,
        batch_timeout_sec: null,
      },
    },
    resolved_profile_sha256: "p".repeat(64),
    ksql_flow_version: "3.74.0",
    engine_version: "3.74.0",
    dialect: 1,
    created_at: at,
    started_at: at,
    finished_at: null,
    updated_at: at,
  };
}

async function seeded(status = "UNKNOWN", idempotent = false) {
  const repository = new InMemoryPersistenceRepository();
  await repository.createRun(run());
  const waiting = await repository.upsertNodeState({
    expected_revision: null,
    value: {
      node_state_id: "state_12",
      node_state_key: nodeStateKey("run_12", "node_12"),
      run_id: "run_12",
      node_id: "node_12",
      job_id: "job_12",
      status: "WAITING",
      latest_attempt_no: 0,
      active_attempt_id: null,
      revision: 1,
      idempotent,
      trigger_rule: "all_success",
      blocked_by: [],
      status_reason: null,
      started_at: null,
      finished_at: null,
      updated_at: at,
    },
  });
  const attempt = await repository.createAttempt({
    node_state: waiting,
    node_attempt_id: "attempt_12",
    invocation_id: "invoke_12",
  });
  const running = await repository.upsertNodeState({
    expected_revision: waiting.revision,
    value: {
      ...waiting.value,
      status: "RUNNING",
      latest_attempt_no: 1,
      active_attempt_id: "attempt_12",
      started_at: at,
    },
  });
  const terminalAttempt = await repository.finalizeAttempt(
    "attempt_12",
    attempt.revision,
    {
      status,
      result_code: status === "UNKNOWN" ? "RESULT_UNKNOWN" : "SQL_ERROR",
      runner_execution_started_at: at,
      execution_id: "exec_12",
      finished_at: at,
      duration_sec: 1,
      error_message: null,
      read_count: 1,
      written_count: 1,
      last_successful_chunk_no: 1,
      last_written_key: "key",
    },
  );
  await repository.upsertNodeState({
    expected_revision: running.revision,
    value: {
      ...running.value,
      status,
      active_attempt_id: null,
      finished_at: at,
    },
  });
  return { repository, terminalAttempt };
}

function resolutionInput(repository, overrides = {}) {
  return {
    repository,
    runId: "run_12",
    nodeId: "node_12",
    outcome: "SUCCESS",
    resolutionType: "NODE_MANUAL_COMPLETION_CONFIRMED",
    reason: "manual reconciliation completed",
    evidenceRef: "reconciliation://incident/12",
    servicePrincipal: "svc-flownet-prod",
    requestedBy: "operator@example.test",
    approvedBy: "supervisor@example.test",
    stopConfirmedBy: "operator@example.test",
    stopEvidenceRef: "incident://stop/12",
    now: () => new Date(at),
    ...overrides,
  };
}

test("acceptance 16: target status outside UNKNOWN/non-idempotent FAILED is rejected", async () => {
  const { repository } = await seeded("FAILED", true);
  await assert.rejects(resolveNode(resolutionInput(repository)), (error) => {
    assert.ok(error instanceof ResolveNodeError);
    assert.equal(error.code, "NODE_NOT_RESOLVABLE");
    return true;
  });
});

test("D-18: compensation cannot resolve to SUCCESS", async () => {
  const { repository } = await seeded();
  await assert.rejects(
    resolveNode(
      resolutionInput(repository, {
        resolutionType: "NODE_COMPENSATION_COMPLETED",
      }),
    ),
    (error) => error.code === "COMPENSATION_CANNOT_SUCCEED",
  );
});

test("D-04/D-13/D-18: manual completion appends full audit, preserves Attempt, and makes State SUCCESS", async () => {
  const { repository, terminalAttempt } = await seeded();
  const before = JSON.parse(JSON.stringify(terminalAttempt));
  const result = await resolveNode(resolutionInput(repository));

  assert.equal(result.nodeState.value.status, "SUCCESS");
  assert.equal(result.nodeState.value.revision, 4);
  assert.deepEqual(
    (await repository.getAttempts("run_12"))[0],
    before,
    "the original Attempt must remain byte-for-byte unchanged",
  );
  assert.deepEqual(result.resolution.value, {
    event_type: "ATTEMPT_RESOLVED",
    resolution_type: "NODE_MANUAL_COMPLETION_CONFIRMED",
    attempt_id: "attempt_12",
    resolved_outcome: "SUCCESS",
    reason: "manual reconciliation completed",
    evidence_ref: "reconciliation://incident/12",
    service_principal: "svc-flownet-prod",
    requested_by: "operator@example.test",
    approved_by: "supervisor@example.test",
    stop_confirmed_by: "operator@example.test",
    stop_evidence_ref: "incident://stop/12",
    resolved_at: at,
  });
  assert.equal(
    result.nodeState.value.status === "SUCCESS",
    true,
    "all_success dependency evaluation can now admit downstream work",
  );
});

test("D-13: non-idempotent SUCCESS requires a separately recorded approver", async () => {
  const { repository } = await seeded();
  await assert.rejects(
    resolveNode(
      resolutionInput(repository, {
        approvedBy: "operator@example.test",
      }),
    ),
    (error) => error.code === "DISTINCT_APPROVER_REQUIRED",
  );
  assert.deepEqual(await repository.getResolutions("run_12"), []);
});

test("non-idempotent FAILED Resolution can be repaired by reconciliation after the append", async () => {
  const { repository } = await seeded("FAILED", false);
  await repository.appendResolution({
    event_type: "ATTEMPT_RESOLVED",
    resolution_type: "NODE_MANUAL_COMPLETION_CONFIRMED",
    attempt_id: "attempt_12",
    resolved_outcome: "SUCCESS",
    reason: "manual completion",
    evidence_ref: "evidence://12",
    service_principal: "svc",
    requested_by: "operator",
    approved_by: "supervisor",
    stop_confirmed_by: "operator",
    stop_evidence_ref: "stop://12",
    resolved_at: at,
  });
  await reconcileRun(repository, "run_12");
  assert.equal(
    (await repository.getNodeStates("run_12"))[0].value.status,
    "SUCCESS",
  );
});

test("D-26: LOCK_RECOVERY_RESULT is linked in OPERATION_AUDIT without a lock mutator", async () => {
  const { repository } = await seeded();
  const result = {
    kind: "LOCK_RECOVERY_RESULT",
    formatVersion: 1,
    jobKey: "prod:job_12",
    recordId: "497",
    outcome: "RELEASED",
    before: {
      batchId: "batch-12",
      startedAt: at,
      host: "runner-12",
    },
    executedAt: at,
  };
  const audit = await recordJobUnlock({
    repository,
    runId: "run_12",
    nodeId: "node_12",
    result,
    reason: "old owner was confirmed stopped",
    evidenceRef: "incident://unlock/12",
    servicePrincipal: "svc-flownet-prod",
    requestedBy: "operator@example.test",
    stopConfirmedBy: "supervisor@example.test",
    now: () => new Date(at),
    uuid: () => "event-12",
  });
  assert.deepEqual(audit, {
    event_id: "job_unlock_event-12",
    event_type: "JOB_LOCK_FORCE_UNLOCK_RECORDED",
    run_id: "run_12",
    node_id: "node_12",
    job_id: "job_12",
    service_principal: "svc-flownet-prod",
    requested_by: "operator@example.test",
    stop_confirmed_by: "supervisor@example.test",
    reason: "old owner was confirmed stopped",
    evidence_ref: "incident://unlock/12",
    recorded_at: at,
    lock_recovery_result: result,
  });
  assert.equal(repository.operationAudits.length, 1);
});

test("D-26: malformed or unrelated lock results are rejected before audit append", async () => {
  const { repository } = await seeded();
  const base = {
    repository,
    runId: "run_12",
    nodeId: "node_12",
    reason: "reason",
    evidenceRef: "evidence://12",
    servicePrincipal: "svc",
    requestedBy: "operator",
    stopConfirmedBy: "operator",
  };
  await assert.rejects(
    recordJobUnlock({
      ...base,
      result: { kind: "LOCK_RECOVERY_RESULT", formatVersion: 2 },
    }),
    (error) => error.code === "INVALID_LOCK_RECOVERY_RESULT",
  );
  await assert.rejects(
    recordJobUnlock({
      ...base,
      result: {
        kind: "LOCK_RECOVERY_RESULT",
        formatVersion: 1,
        jobKey: "prod:another_job",
        recordId: null,
        outcome: "NOT_FOUND",
        before: null,
        executedAt: at,
      },
    }),
    (error) => error.code === "JOB_KEY_MISMATCH",
  );
  assert.equal(repository.operationAudits.length, 0);
});
