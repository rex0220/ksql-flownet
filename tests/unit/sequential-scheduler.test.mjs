import assert from "node:assert/strict";
import test from "node:test";

import { buildBundle } from "../../dist/bundle/index.js";
import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import { runSequentialScheduler } from "../../dist/orchestration/sequential-scheduler.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";

const T0 = "2026-08-30T00:00:00.000Z";

function yaml(nodes) {
  const lines = [
    "schema_version: 1",
    "network_id: scheduler_test",
    "business_key_policy:",
    "  type: explicit",
    "max_active_runs: 1",
    "network_lock:",
    "  lease_duration_sec: 3",
    "  heartbeat_interval_sec: 1",
    "nodes:",
  ];
  for (const node of nodes) {
    lines.push(
      `  - id: ${node.id}`,
      `    job_id: job_${node.id}`,
      `    sql: jobs/${node.id}.sql`,
      `    depends_on: [${node.dependsOn.join(", ")}]`,
      "    trigger_rule: all_success",
      `    idempotent: ${node.idempotent ?? true}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function inspected(node) {
  return {
    nodeId: node.id,
    jobId: `job_${node.id}`,
    nondeterministicCodes: [],
    approvedExceptions: [],
    inspection: {
      formatVersion: 1,
      kind: "JOB_INSPECTION",
      jobId: `job_${node.id}`,
      fileName: `${node.id}.sql`,
      dialect: 1,
      statementCount: 1,
      dependsOn: [],
      timeoutSec: null,
      diagnostics: [],
      nondeterministicElements: [],
    },
  };
}

function bundle(nodes) {
  return buildBundle({
    networkYamlBytes: Buffer.from(yaml(nodes)),
    jobs: nodes.map((node) => ({
      path: `jobs/${node.id}.sql`,
      sqlBytes: Buffer.from(`-- @ksql name: job_${node.id}\nSELECT 1;\n`),
      inspectedNode: inspected(node),
    })),
  }).zipBytes;
}

function run(status = "CREATED") {
  return {
    run_id: "run_1",
    network_id: "scheduler_test",
    business_key: "scheduler_test@one",
    max_active_runs: 1,
    status,
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: "2026-08-01T00:00:00Z",
    definition_schema_version: 1,
    definition_sha256: "a".repeat(64),
    source_bundle_sha256: "b".repeat(64),
    source_bundle_attachment: "bundle.zip",
    resolved_profile_snapshot: {
      profile: "prod",
      base_url: "https://example.test",
      guest_space_id: null,
      timezone: "UTC",
      apps: {},
      limits: { max_api_calls: 1, max_read_rows: 1, batch_timeout_sec: 1 },
    },
    resolved_profile_sha256: "c".repeat(64),
    ksql_flow_version: "1",
    engine_version: "1",
    dialect: 1,
    created_at: T0,
    started_at: status === "CREATED" ? null : T0,
    finished_at: null,
    updated_at: T0,
  };
}

function invocation(mode) {
  return {
    invocation_id: "invoke_1",
    run_id: "run_1",
    mode,
    requested_by: "tester",
    host: "host",
    started_at: T0,
    finished_at: null,
    status: "RUNNING",
    result_code: "PENDING",
    selected_node_ids: [],
    preserved_node_ids: [],
    blocked_node_ids: [],
    reason: "test",
  };
}

async function seed(nodes, options = {}) {
  const repository = new InMemoryPersistenceRepository();
  const seededRun = await repository.createRun(run(options.runStatus));
  const seededInvocation = await repository.createInvocation(
    invocation(options.mode ?? "NEW"),
  );
  for (const node of nodes) {
    let state = await repository.upsertNodeState({
      expected_revision: null,
      value: {
        node_state_id: `state_${node.id}`,
        node_state_key: nodeStateKey("run_1", node.id),
        run_id: "run_1",
        node_id: node.id,
        job_id: `job_${node.id}`,
        status: "WAITING",
        latest_attempt_no: 0,
        active_attempt_id: null,
        revision: 1,
        idempotent: node.idempotent ?? true,
        trigger_rule: "all_success",
        blocked_by: [],
        status_reason: null,
        started_at: null,
        finished_at: null,
        updated_at: T0,
      },
    });
    const desired = options.initial?.[node.id];
    if (desired && desired !== "WAITING") {
      if (desired === "BLOCKED") {
        await repository.upsertNodeState({
          expected_revision: state.revision,
          value: { ...state.value, status: desired },
        });
      } else {
        state = await repository.upsertNodeState({
          expected_revision: state.revision,
          value: { ...state.value, status: "RUNNING" },
        });
        await repository.upsertNodeState({
          expected_revision: state.revision,
          value: { ...state.value, status: desired },
        });
      }
    }
  }
  return { repository, seededRun, seededInvocation };
}

function heldMonitor(overrides = {}) {
  let final = false;
  return {
    canStartNewNode: () => !final,
    canPersistResults: () => !final || final,
    confirmLeaseForFinalWrite: async () => {
      final = true;
      return true;
    },
    requiresNetworkLeaseInterruptedFinalization: () => final,
    tick: async () => true,
    ...overrides,
  };
}

function fakeExecutor(repository, outcomes, calls, concurrency) {
  return {
    async execute(input) {
      concurrency.active += 1;
      concurrency.max = Math.max(concurrency.max, concurrency.active);
      calls.push(input.nodeState.value.node_id);
      await new Promise((resolve) => setImmediate(resolve));
      const configured = outcomes[input.nodeState.value.node_id] ?? "SUCCESS";
      const authorized = await input.authorizeResultPersistence();
      if (!authorized) {
        concurrency.active -= 1;
        const error = new Error("lease interrupted");
        error.code = "NETWORK_LEASE_INTERRUPTED";
        throw error;
      }
      const started = await repository.setAttemptExecutionStarted(
        input.attemptId,
        input.attempt.revision,
        { execution_started_at: input.executionStartedAt },
      );
      const lockConflict = configured === "LOCK_CONFLICT";
      const attemptStatus = lockConflict ? "CANCELLED" : configured;
      const resultCode = lockConflict
        ? "PREPARE_FAILED"
        : configured === "SUCCESS"
          ? "OK"
          : configured;
      const attempt = await repository.finalizeAttempt(
        input.attemptId,
        started.revision,
        {
          status: attemptStatus,
          result_code: resultCode,
          runner_execution_started_at: lockConflict
            ? null
            : input.executionStartedAt,
          execution_id: lockConflict
            ? null
            : `exec_${input.nodeState.value.node_id}`,
          finished_at: T0,
          duration_sec: 0,
          error_message: null,
          read_count: 0,
          written_count: 0,
          last_successful_chunk_no: null,
          last_written_key: null,
        },
      );
      const stateStatus = lockConflict ? "WAITING" : configured;
      const nodeState = await repository.upsertNodeState({
        expected_revision: input.nodeState.revision,
        value: {
          ...input.nodeState.value,
          status: stateStatus,
          active_attempt_id: null,
          status_reason: resultCode,
          finished_at: lockConflict ? null : T0,
        },
      });
      concurrency.active -= 1;
      return {
        classification: { kind: "VALID_RESULT", attemptOutcome: configured },
        process: {},
        attempt,
        nodeState,
        invocationResultCode: lockConflict ? "LOCK_CONFLICT" : null,
      };
    },
  };
}

async function execute(nodes, options = {}) {
  const seeded = await seed(nodes, options);
  const calls = [];
  const closeCalls = [];
  const concurrency = { active: 0, max: 0 };
  const summary = await runSequentialScheduler({
    run: seeded.seededRun,
    invocation: seeded.seededInvocation,
    bundleBytes: bundle(nodes),
    repository: seeded.repository,
    attemptExecutor: fakeExecutor(
      seeded.repository,
      options.outcomes ?? {},
      calls,
      concurrency,
    ),
    leaseMonitor: options.monitor ?? heldMonitor(),
    profile: "prod",
    configPath: "C:\\secure\\config.json",
    close: async (value) => {
      closeCalls.push(value);
      if (value.persistInvocation !== false)
        await seeded.repository.finalizeInvocation(
          "invoke_1",
          seeded.seededInvocation.revision,
          {
            status: value.status,
            result_code: value.resultCode,
            finished_at: T0,
            selected_node_ids: value.selectedNodeIds,
            preserved_node_ids: value.preservedNodeIds,
            blocked_node_ids: value.blockedNodeIds,
          },
        );
    },
  });
  return { ...seeded, summary, calls, closeCalls, concurrency };
}

test("3ノード直列成功は安定順かつ同時AttemptなしでSUCCESSになる", async () => {
  const nodes = [
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
  ];
  const result = await execute(nodes);
  assert.deepEqual(result.calls, ["a", "b", "c"]);
  assert.equal(result.concurrency.max, 1);
  assert.equal(result.summary.aggregateStatus, "SUCCESS");
  assert.equal(result.summary.invocationStatus, "SUCCESS");
});

test("中央FAILEDは下流BLOCKED、集約FAILEDになる（受入1）", async () => {
  const nodes = [
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
  ];
  const result = await execute(nodes, { outcomes: { b: "FAILED" } });
  assert.deepEqual(result.calls, ["a", "b"]);
  assert.equal(result.summary.nodeResults[2].status, "BLOCKED");
  assert.equal(result.summary.aggregateStatus, "FAILED");
});

test("複数開始点と分岐・合流は定義順tie-breakerで決定的に走る", async () => {
  const nodes = [
    { id: "left", dependsOn: [] },
    { id: "right", dependsOn: [] },
    { id: "left_child", dependsOn: ["left"] },
    { id: "join", dependsOn: ["left_child", "right"] },
  ];
  const result = await execute(nodes);
  assert.deepEqual(result.calls, ["left", "right", "left_child", "join"]);
});

test("resumeはUNKNOWN子孫だけBLOCKEDにし独立系統を継続、集約UNKNOWN（受入7/17）", async () => {
  const nodes = [
    { id: "unknown", dependsOn: [] },
    { id: "child", dependsOn: ["unknown"] },
    { id: "independent", dependsOn: [] },
  ];
  const result = await execute(nodes, {
    mode: "RESUME",
    runStatus: "UNKNOWN",
    initial: { unknown: "UNKNOWN", child: "BLOCKED" },
  });
  assert.deepEqual(result.calls, ["independent"]);
  assert.equal(result.summary.nodeResults[1].status, "BLOCKED");
  assert.equal(result.summary.aggregateStatus, "UNKNOWN");
  assert.deepEqual(result.summary.preservedNodeIds, []);
});

test("CANCELLEDはall_successを満たさず下流BLOCKED、独立系統は継続する（受入7）", async () => {
  const nodes = [
    { id: "cancelled", dependsOn: [], idempotent: false },
    { id: "child", dependsOn: ["cancelled"] },
    { id: "independent", dependsOn: [] },
  ];
  const result = await execute(nodes, {
    mode: "RESUME",
    runStatus: "CANCELLED",
    initial: { cancelled: "CANCELLED", child: "BLOCKED" },
  });
  assert.deepEqual(result.calls, ["independent"]);
  assert.equal(result.summary.nodeResults[1].status, "BLOCKED");
  assert.equal(result.summary.aggregateStatus, "FAILED");
});

test("resumeはSUCCESSを保持し、冪等FAILEDだけ再試行する", async () => {
  const nodes = [
    { id: "preserved", dependsOn: [] },
    { id: "retry", dependsOn: ["preserved"] },
  ];
  const result = await execute(nodes, {
    mode: "RESUME",
    runStatus: "FAILED",
    initial: { preserved: "SUCCESS", retry: "FAILED" },
  });
  assert.deepEqual(result.calls, ["retry"]);
  assert.deepEqual(result.summary.preservedNodeIds, ["preserved"]);
  assert.equal(result.summary.aggregateStatus, "SUCCESS");
  assert.equal((await result.repository.getAttempts("run_1")).length, 1);
});

test("LOCK_CONFLICTは番号を保持してWAITINGへ戻し、独立ノードを継続する（受入24）", async () => {
  const nodes = [
    { id: "locked", dependsOn: [] },
    { id: "dependent", dependsOn: ["locked"] },
    { id: "independent", dependsOn: [] },
  ];
  const result = await execute(nodes, {
    outcomes: { locked: "LOCK_CONFLICT" },
  });
  assert.deepEqual(result.calls, ["locked", "independent"]);
  const states = await result.repository.getNodeStates("run_1");
  const locked = states.find(({ value }) => value.node_id === "locked").value;
  assert.equal(locked.status, "WAITING");
  assert.equal(locked.latest_attempt_no, 1);
  const attempt = (await result.repository.getAttempts("run_1"))[0].value;
  assert.equal(attempt.status, "CANCELLED");
  assert.equal(attempt.result_code, "PREPARE_FAILED");
});

test("drain回復時だけ結果保存しInvocationをNETWORK_LEASE_INTERRUPTEDで終端する", async () => {
  let final = false;
  const monitor = heldMonitor({
    canStartNewNode: () => true,
    canPersistResults: () => final,
    confirmLeaseForFinalWrite: async () => {
      final = true;
      return true;
    },
    requiresNetworkLeaseInterruptedFinalization: () => final,
  });
  const result = await execute([{ id: "a", dependsOn: [] }], { monitor });
  assert.equal(result.summary.invocationStatus, "CANCELLED");
  assert.equal(
    result.summary.invocationResultCode,
    "NETWORK_LEASE_INTERRUPTED",
  );
  assert.equal(
    (await result.repository.getAttempts("run_1"))[0].value.status,
    "SUCCESS",
  );
});

test("drain未回復時はsubprocess結果を状態へ保存せずreconciliationへ送る", async () => {
  const monitor = heldMonitor({
    canStartNewNode: () => true,
    canPersistResults: () => false,
    confirmLeaseForFinalWrite: async () => false,
    requiresNetworkLeaseInterruptedFinalization: () => false,
  });
  const seeded = await seed([{ id: "a", dependsOn: [] }]);
  const closeCalls = [];
  await assert.rejects(
    runSequentialScheduler({
      run: seeded.seededRun,
      invocation: seeded.seededInvocation,
      bundleBytes: bundle([{ id: "a", dependsOn: [] }]),
      repository: seeded.repository,
      attemptExecutor: fakeExecutor(seeded.repository, {}, [], {
        active: 0,
        max: 0,
      }),
      leaseMonitor: monitor,
      profile: "prod",
      configPath: "C:\\secure\\config.json",
      close: async (value) => closeCalls.push(value),
    }),
    /lease interrupted/i,
  );
  const attempt = (await seeded.repository.getAttempts("run_1"))[0].value;
  const state = (await seeded.repository.getNodeStates("run_1"))[0].value;
  assert.equal(attempt.status, "RUNNING");
  assert.equal(state.status, "RUNNING");
  assert.equal(closeCalls[0].persistInvocation, false);
});

test("旧token相当のfencing拒否ではRun集約とInvocationを書かない（受入19）", async () => {
  let first = true;
  const monitor = heldMonitor({
    tick: async () => {
      if (first) {
        first = false;
        return false;
      }
      return false;
    },
    canPersistResults: () => false,
  });
  const seeded = await seed([{ id: "a", dependsOn: [] }]);
  const closeCalls = [];
  await assert.rejects(
    runSequentialScheduler({
      run: seeded.seededRun,
      invocation: seeded.seededInvocation,
      bundleBytes: bundle([{ id: "a", dependsOn: [] }]),
      repository: seeded.repository,
      attemptExecutor: { execute: async () => assert.fail("must not execute") },
      leaseMonitor: monitor,
      profile: "prod",
      configPath: "C:\\secure\\config.json",
      close: async (value) => closeCalls.push(value),
    }),
    /network lease/i,
  );
  assert.equal((await seeded.repository.getRun("run_1")).revision, 1);
  assert.equal(closeCalls[0].persistInvocation, false);
});

test("scheduler例外でもInvocation終端とlock closeを必ず呼ぶ", async () => {
  const seeded = await seed([{ id: "a", dependsOn: [] }]);
  const closeCalls = [];
  await assert.rejects(
    runSequentialScheduler({
      run: seeded.seededRun,
      invocation: seeded.seededInvocation,
      bundleBytes: bundle([{ id: "a", dependsOn: [] }]),
      repository: seeded.repository,
      attemptExecutor: {
        execute: async () => {
          throw new Error("boom");
        },
      },
      leaseMonitor: heldMonitor(),
      profile: "prod",
      configPath: "C:\\secure\\config.json",
      close: async (value) => closeCalls.push(value),
    }),
    /boom/,
  );
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].status, "FAILED");
  assert.equal(closeCalls[0].resultCode, "SCHEDULER_FAILED");
});
