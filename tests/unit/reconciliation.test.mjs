import assert from "node:assert/strict";
import test from "node:test";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import {
  reconcileRun,
  ReconciliationRequiredError,
} from "../../dist/orchestration/reconciliation.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";

const T0 = "2026-08-30T00:00:00Z";

function run(overrides = {}) {
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
      apps: {},
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
    created_at: T0,
    started_at: null,
    finished_at: null,
    updated_at: T0,
    ...overrides,
  };
}

function state(nodeId, overrides = {}) {
  return {
    node_state_id: `state_${nodeId}`,
    node_state_key: nodeStateKey("run_1", nodeId),
    run_id: "run_1",
    node_id: nodeId,
    job_id: `job_${nodeId}`,
    status: "WAITING",
    latest_attempt_no: 0,
    active_attempt_id: null,
    revision: 1,
    idempotent: true,
    trigger_rule: "all_success",
    blocked_by: [],
    status_reason: null,
    started_at: null,
    finished_at: null,
    updated_at: T0,
    ...overrides,
  };
}

class CapturingRepository extends InMemoryPersistenceRepository {
  audits = [];
  async appendOperationAudit(value) {
    this.audits.push(globalThis.structuredClone(value));
    return super.appendOperationAudit(value);
  }
}

async function setup(nodeIds = ["n1"], runOverrides = {}) {
  const repository = new CapturingRepository();
  await repository.createRun(run(runOverrides));
  const states = new Map();
  for (const nodeId of nodeIds) {
    states.set(
      nodeId,
      await repository.upsertNodeState({
        value: state(nodeId),
        expected_revision: null,
      }),
    );
  }
  return { repository, states };
}

async function startAttempt(repository, current, attemptId) {
  const attempt = await repository.createAttempt({
    node_state: current,
    node_attempt_id: attemptId,
    invocation_id: "invoke_1",
  });
  const running = await repository.upsertNodeState({
    value: {
      ...current.value,
      status: "RUNNING",
      latest_attempt_no: current.value.latest_attempt_no + 1,
      active_attempt_id: attemptId,
    },
    expected_revision: current.revision,
  });
  return { attempt, running };
}

async function finish(repository, attempt, status = "SUCCESS") {
  return repository.finalizeAttempt(
    attempt.value.node_attempt_id,
    attempt.revision,
    {
      status,
      result_code: status === "SUCCESS" ? "OK" : status,
      runner_execution_started_at: T0,
      execution_id: "exec_1",
      finished_at: "2026-08-30T00:01:00Z",
      duration_sec: 60,
      error_message: null,
      read_count: 1,
      written_count: 1,
      last_successful_chunk_no: 1,
      last_written_key: "K1",
    },
  );
}

test("D-09正常系: 整合済みWAITING StateとCREATED Runは書き込まない", async () => {
  const { repository } = await setup();
  assert.deepEqual(await reconcileRun(repository, "run_1"), {
    repaired: [],
    inconsistencies: [],
    aggregateUpdated: false,
  });
  assert.equal(repository.audits.length, 0);
});

test("D-09検査1: RUNNING Stateのactive_attempt_id欠落はfail-closed", async () => {
  const { repository, states } = await setup();
  const waiting = states.get("n1");
  await repository.upsertNodeState({
    value: { ...waiting.value, status: "RUNNING" },
    expected_revision: waiting.revision,
  });
  await assert.rejects(reconcileRun(repository, "run_1"), (error) => {
    assert.ok(error instanceof ReconciliationRequiredError);
    assert.equal(error.code, "RECONCILIATION_REQUIRED");
    assert.equal(
      error.result.inconsistencies[0].code,
      "ACTIVE_ATTEMPT_ID_MISSING",
    );
    assert.match(error.message, /ACTIVE_ATTEMPT_ID_MISSING/);
    return true;
  });
});

test("D-09検査2/3: terminal Attempt後のRUNNING Stateをrevision付き修復し監査する", async () => {
  const { repository, states } = await setup();
  const { attempt } = await startAttempt(
    repository,
    states.get("n1"),
    "attempt_1",
  );
  await finish(repository, attempt, "SUCCESS");
  const result = await reconcileRun(repository, "run_1");
  assert.equal(result.aggregateUpdated, true);
  assert.deepEqual(
    result.repaired.map(({ type }) => type),
    ["TERMINAL_ATTEMPT_APPLIED", "RUN_AGGREGATE_RECOMPUTED"],
  );
  const repairedState = (await repository.getNodeStates("run_1"))[0];
  assert.equal(repairedState.value.status, "SUCCESS");
  assert.equal(repairedState.value.active_attempt_id, null);
  assert.equal(repairedState.value.revision, 3);
  assert.equal(repository.audits[0].event_type, "RECONCILIATION_REPAIR");
  assert.equal(repository.audits[0].target_type, "NODE_STATE");
  assert.deepEqual(repository.audits[0].before, {
    status: "RUNNING",
    active_attempt_id: "attempt_1",
    revision: 2,
  });
  assert.deepEqual(repository.audits[0].after, {
    status: "SUCCESS",
    active_attempt_id: null,
    revision: 3,
  });
  assert.match(repository.audits[0].basis, /unique active attempt/);
  assert.match(repository.audits[0].occurred_at, /^2026-|^20\d\d-/);
});

test("D-09検査2: terminal State + RUNNING Attemptはfail-closed", async () => {
  const { repository, states } = await setup();
  const { running } = await startAttempt(
    repository,
    states.get("n1"),
    "attempt_1",
  );
  await repository.upsertNodeState({
    value: { ...running.value, status: "SUCCESS" },
    expected_revision: running.revision,
  });
  await assert.rejects(reconcileRun(repository, "run_1"), (error) => {
    assert.ok(
      error.result.inconsistencies.some(
        ({ code }) => code === "STATE_TERMINAL_ATTEMPT_RUNNING",
      ),
    );
    return true;
  });
});

test("D-09検査3: terminal同士でactiveだけ残ったStateは一意にクリアする", async () => {
  const { repository, states } = await setup();
  const { attempt, running } = await startAttempt(
    repository,
    states.get("n1"),
    "attempt_1",
  );
  await finish(repository, attempt, "FAILED");
  await repository.upsertNodeState({
    value: {
      ...running.value,
      status: "FAILED",
      active_attempt_id: "attempt_1",
    },
    expected_revision: running.revision,
  });
  const result = await reconcileRun(repository, "run_1");
  assert.ok(
    result.repaired.some(({ type }) => type === "TERMINAL_ATTEMPT_APPLIED"),
  );
  assert.equal(
    (await repository.getNodeStates("run_1"))[0].value.active_attempt_id,
    null,
  );
});

test("D-09検査4: 1ノード複数RUNNING Attemptは全IDを列挙してfail-closed", async () => {
  const { repository, states } = await setup();
  const first = await startAttempt(repository, states.get("n1"), "attempt_1");
  const waitingAgain = await repository.upsertNodeState({
    value: {
      ...first.running.value,
      status: "WAITING",
      active_attempt_id: null,
    },
    expected_revision: first.running.revision,
  });
  await startAttempt(repository, waitingAgain, "attempt_2");
  await assert.rejects(reconcileRun(repository, "run_1"), (error) => {
    const item = error.result.inconsistencies.find(
      ({ code }) => code === "MULTIPLE_RUNNING_ATTEMPTS",
    );
    assert.deepEqual(item.attemptIds, ["attempt_1", "attempt_2"]);
    return true;
  });
});

test("D-09検査5: UNKNOWN Resolutionの一意outcomeをStateへ反映する", async () => {
  const { repository, states } = await setup();
  const { attempt, running } = await startAttempt(
    repository,
    states.get("n1"),
    "attempt_1",
  );
  const terminal = await finish(repository, attempt, "UNKNOWN");
  await repository.upsertNodeState({
    value: { ...running.value, status: "UNKNOWN", active_attempt_id: null },
    expected_revision: running.revision,
  });
  await repository.appendResolution({
    event_type: "ATTEMPT_RESOLVED",
    attempt_id: terminal.value.node_attempt_id,
    resolved_outcome: "SUCCESS",
    evidence_ref: "evidence://1",
    service_principal: "svc",
    requested_by: "user",
    approved_by: "approver",
    resolved_at: "2026-08-30T00:02:00Z",
  });
  const result = await reconcileRun(repository, "run_1");
  assert.ok(
    result.repaired.some(({ type }) => type === "ATTEMPT_RESOLUTION_APPLIED"),
  );
  assert.equal(
    (await repository.getNodeStates("run_1"))[0].value.status,
    "SUCCESS",
  );
  assert.ok(
    repository.audits.some(
      ({ repair_type, basis }) =>
        repair_type === "ATTEMPT_RESOLUTION_APPLIED" &&
        basis.includes("uniquely resolved"),
    ),
  );
});

test("D-09検査5: 矛盾する複数Resolutionはfail-closed", async () => {
  const { repository, states } = await setup();
  const { attempt, running } = await startAttempt(
    repository,
    states.get("n1"),
    "attempt_1",
  );
  const terminal = await finish(repository, attempt, "UNKNOWN");
  await repository.upsertNodeState({
    value: { ...running.value, status: "UNKNOWN", active_attempt_id: null },
    expected_revision: running.revision,
  });
  const base = {
    event_type: "ATTEMPT_RESOLVED",
    attempt_id: terminal.value.node_attempt_id,
    evidence_ref: "evidence://1",
    service_principal: "svc",
    requested_by: "user",
    approved_by: "approver",
  };
  await repository.appendResolution({
    ...base,
    resolved_outcome: "SUCCESS",
    resolved_at: "2026-08-30T00:02:00Z",
  });
  await repository.appendResolution({
    ...base,
    resolved_outcome: "FAILED",
    resolved_at: "2026-08-30T00:03:00Z",
  });
  await assert.rejects(reconcileRun(repository, "run_1"), (error) => {
    assert.ok(
      error.result.inconsistencies.some(
        ({ code }) => code === "CONFLICTING_ATTEMPT_RESOLUTIONS",
      ),
    );
    return true;
  });
});

test("D-09 revision系列: 判定材料なしと逆転をfail-closedにする", async () => {
  for (const injected of [null, 3]) {
    const { repository, states } = await setup();
    await startAttempt(repository, states.get("n1"), "attempt_1");
    const original = repository.getAttempts.bind(repository);
    repository.getAttempts = async (runId) =>
      (await original(runId)).map((item) => ({
        ...item,
        value: { ...item.value, state_revision_before: injected },
      }));
    await assert.rejects(reconcileRun(repository, "run_1"), (error) => {
      assert.ok(
        error.result.inconsistencies.some(
          ({ code }) =>
            code ===
            (injected === null
              ? "REVISION_SERIES_UNDETERMINED"
              : "REVISION_SERIES_INVERTED"),
        ),
      );
      return true;
    });
  }
});

test("D-09検査6: 不一致aggregateだけを決定表からrevision付き修復する", async () => {
  const { repository } = await setup(["n1"], { status: "RUNNING" });
  const result = await reconcileRun(repository, "run_1");
  assert.equal(result.aggregateUpdated, true);
  assert.equal((await repository.getRun("run_1")).value.status, "CREATED");
  assert.equal(repository.audits[0].repair_type, "RUN_AGGREGATE_RECOMPUTED");
  assert.deepEqual(repository.audits[0].before, {
    status: "RUNNING",
    revision: 1,
  });
  assert.deepEqual(repository.audits[0].after, {
    status: "CREATED",
    revision: 2,
  });
});

test("D-09混在: 修復可能分と監査を保持し全不整合を列挙して停止する", async () => {
  const { repository, states } = await setup(["repairable", "broken"]);
  const repairable = await startAttempt(
    repository,
    states.get("repairable"),
    "attempt_ok",
  );
  await finish(repository, repairable.attempt, "SUCCESS");
  const broken = states.get("broken");
  await repository.upsertNodeState({
    value: { ...broken.value, status: "RUNNING" },
    expected_revision: broken.revision,
  });
  await assert.rejects(reconcileRun(repository, "run_1"), (error) => {
    assert.equal(error.code, "RECONCILIATION_REQUIRED");
    assert.ok(
      error.result.repaired.some(
        ({ targetId }) => targetId === "state_repairable",
      ),
    );
    assert.ok(
      error.result.inconsistencies.some(({ nodeId }) => nodeId === "broken"),
    );
    assert.ok(
      repository.audits.some(
        ({ target_id }) => target_id === "state_repairable",
      ),
    );
    return true;
  });
  assert.equal(
    (await repository.getNodeStates("run_1")).find(
      ({ value }) => value.node_id === "repairable",
    ).value.status,
    "SUCCESS",
  );
});
