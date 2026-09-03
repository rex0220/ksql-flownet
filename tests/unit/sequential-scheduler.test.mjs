import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildBundle } from "../../dist/bundle/index.js";
import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import {
  retryBrakeForNode,
  runSequentialScheduler,
} from "../../dist/orchestration/sequential-scheduler.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";
import { serializeInputBaseline } from "../../dist/io/input-baseline.js";
import { RepositoryError } from "../../dist/persistence/repository.js";
import {
  KintoneApiError,
  KintoneTransportError,
} from "../../dist/persistence/kintone/client.js";

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
    if (node.inputs) {
      lines.push("    inputs:");
      for (const [name, pattern] of Object.entries(node.inputs))
        lines.push(`      ${name}: ${pattern}`);
    }
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

function invocation(mode, selectedNodeIds = []) {
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
    selected_node_ids: selectedNodeIds,
    preserved_node_ids: [],
    blocked_node_ids: [],
    reason: "test",
  };
}

async function seed(nodes, options = {}) {
  const repository = new InMemoryPersistenceRepository();
  const operationAudits = [];
  const appendOperationAudit = repository.appendOperationAudit.bind(repository);
  repository.appendOperationAudit = async (audit) => {
    operationAudits.push(globalThis.structuredClone(audit));
    return appendOperationAudit(audit);
  };
  const seededRun = await repository.createRun(run(options.runStatus));
  const seededInvocation = await repository.createInvocation(
    invocation(options.mode ?? "NEW", options.selectedNodeIds ?? []),
  );
  for (const [index, status] of (
    options.abandonedInvocationStatuses ?? []
  ).entries()) {
    await repository.createInvocation({
      ...invocation("RESUME"),
      invocation_id: `invoke_old_${index + 1}`,
      status,
    });
  }
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
    if (options.successfulAttemptNodeIds?.includes(node.id)) {
      const attempt = await repository.createAttempt({
        node_state: state,
        node_attempt_id: `old_attempt_${node.id}`,
        invocation_id: "invoke_1",
      });
      state = await repository.upsertNodeState({
        expected_revision: state.revision,
        value: {
          ...state.value,
          status: "RUNNING",
          latest_attempt_no: attempt.value.attempt_no,
          active_attempt_id: attempt.value.node_attempt_id,
        },
      });
      const baseline = options.successfulAttemptBaselines?.[node.id];
      const preparedAttempt =
        baseline === undefined
          ? attempt
          : await repository.setAttemptInputBaseline(
              attempt.value.node_attempt_id,
              attempt.revision,
              { error_message: baseline },
            );
      const started = await repository.setAttemptExecutionStarted(
        attempt.value.node_attempt_id,
        preparedAttempt.revision,
        { execution_started_at: T0 },
      );
      await repository.finalizeAttempt(
        attempt.value.node_attempt_id,
        started.revision,
        {
          status: "SUCCESS",
          result_code: "OK",
          runner_execution_started_at: T0,
          execution_id: `old_exec_${node.id}`,
          finished_at: T0,
          duration_sec: 0,
          error_message: baseline ?? null,
          read_count: 1,
          written_count: 1,
          last_successful_chunk_no: null,
          last_written_key: null,
        },
      );
      state = await repository.upsertNodeState({
        expected_revision: state.revision,
        value: {
          ...state.value,
          status: "SUCCESS",
          active_attempt_id: null,
          finished_at: T0,
        },
      });
    }
    const desired = options.initial?.[node.id];
    if (
      desired === "WAITING" &&
      options.successfulAttemptNodeIds?.includes(node.id)
    ) {
      await repository.upsertNodeState({
        expected_revision: state.revision,
        value: {
          ...state.value,
          status: "WAITING",
          finished_at: null,
        },
      });
    }
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
    const runningOwner = options.runningAttempts?.[node.id];
    if (runningOwner) {
      const currentState = (await repository.getNodeStates("run_1")).find(
        ({ value }) => value.node_id === node.id,
      );
      const attempt = await repository.createAttempt({
        node_state: currentState,
        node_attempt_id: `running_attempt_${node.id}`,
        invocation_id: runningOwner,
      });
      await repository.upsertNodeState({
        expected_revision: currentState.revision,
        value: {
          ...currentState.value,
          status: "RUNNING",
          latest_attempt_no: attempt.value.attempt_no,
          active_attempt_id: attempt.value.node_attempt_id,
          started_at: T0,
        },
      });
      await repository.setAttemptExecutionStarted(
        attempt.value.node_attempt_id,
        attempt.revision,
        { execution_started_at: T0 },
      );
    }
  }
  return { repository, seededRun, seededInvocation, operationAudits };
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
  await options.afterSeed?.(seeded);
  const calls = [];
  const closeCalls = [];
  const concurrency = { active: 0, max: 0 };
  const summary = await runSequentialScheduler({
    run: seeded.seededRun,
    invocation: seeded.seededInvocation,
    bundleBytes: bundle(nodes),
    repository: seeded.repository,
    ...(options.jobLogReader === undefined
      ? {}
      : { jobLogReader: options.jobLogReader }),
    attemptExecutor: fakeExecutor(
      seeded.repository,
      options.outcomes ?? {},
      calls,
      concurrency,
    ),
    leaseMonitor: options.monitor ?? heldMonitor(),
    profile: "prod",
    configPath: "C:\\secure\\config.json",
    ...(options.ioRoot === undefined ? {} : { ioRoot: options.ioRoot }),
    close: async (value) => {
      options.onClose?.();
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
            ...(value.reason === undefined ? {} : { reason: value.reason }),
          },
        );
    },
  });
  return { ...seeded, summary, calls, closeCalls, concurrency };
}

test("到達nodeのinput不在はspawnせずAttempt/StateをFAILEDへ確定する", async (context) => {
  const ioRoot = mkdtempSync(join(tmpdir(), "ksql-flownet-scheduler-io-"));
  mkdirSync(join(ioRoot, "in"));
  context.after(() => rmSync(ioRoot, { recursive: true, force: true }));
  const result = await execute(
    [{ id: "a", dependsOn: [], inputs: { sales: "missing.csv" } }],
    { ioRoot },
  );
  assert.deepEqual(result.calls, []);
  const attempts = await result.repository.getAttempts("run_1");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].value.status, "FAILED");
  assert.equal(attempts[0].value.result_code, "INPUT_FILE_MISSING");
  assert.equal(attempts[0].value.execution_started_at, null);
  const states = await result.repository.getNodeStates("run_1");
  assert.equal(states[0].value.status, "FAILED");
  assert.equal(result.summary.invocationResultCode, "INPUT_FILE_MISSING");
});

test("baseline応答消失は再GET一致時だけ続行する", async (context) => {
  const ioRoot = mkdtempSync(join(tmpdir(), "ksql-flownet-baseline-"));
  mkdirSync(join(ioRoot, "in"));
  writeFileSync(join(ioRoot, "in", "sales.csv"), "id,name\n1,A\n");
  context.after(() => rmSync(ioRoot, { recursive: true, force: true }));
  let writes = 0;
  const result = await execute(
    [{ id: "a", dependsOn: [], inputs: { sales: "sales.csv" } }],
    {
      ioRoot,
      afterSeed({ repository }) {
        const original = repository.setAttemptInputBaseline.bind(repository);
        repository.setAttemptInputBaseline = async (...args) => {
          writes += 1;
          await original(...args);
          throw new RepositoryError("AMBIGUOUS_WRITE", "response lost");
        };
      },
    },
  );
  assert.equal(writes, 1);
  assert.deepEqual(result.calls, ["a"]);
});

test("baseline revision競合の再GETが不一致ならfail-closedにする", async (context) => {
  const ioRoot = mkdtempSync(join(tmpdir(), "ksql-flownet-baseline-conflict-"));
  mkdirSync(join(ioRoot, "in"));
  writeFileSync(join(ioRoot, "in", "sales.csv"), "id\n1\n");
  context.after(() => rmSync(ioRoot, { recursive: true, force: true }));
  await assert.rejects(
    execute([{ id: "a", dependsOn: [], inputs: { sales: "sales.csv" } }], {
      ioRoot,
      afterSeed({ repository }) {
        const original = repository.setAttemptInputBaseline.bind(repository);
        repository.setAttemptInputBaseline = async (attemptId, revision) => {
          await original(attemptId, revision, {
            error_message: serializeInputBaseline([
              { name: "sales", sha256: "f".repeat(64), bytes: 1 },
            ]),
          });
          throw new RepositoryError("REVISION_CONFLICT", "lost race");
        };
      },
    }),
    /could not be uniquely confirmed/,
  );
});

test("通常resumeはSUCCESS importを照合せず、rerun-from選択時はMUTATEDで止める", async (context) => {
  const ioRoot = mkdtempSync(join(tmpdir(), "ksql-flownet-rerun-input-"));
  mkdirSync(join(ioRoot, "in"));
  writeFileSync(join(ioRoot, "in", "sales.csv"), "changed");
  context.after(() => rmSync(ioRoot, { recursive: true, force: true }));
  const original = "original";
  const baseline = serializeInputBaseline([
    {
      name: "sales",
      sha256: createHash("sha256").update(original).digest("hex"),
      bytes: Buffer.byteLength(original),
    },
  ]);
  const nodes = [{ id: "a", dependsOn: [], inputs: { sales: "sales.csv" } }];
  const resumed = await execute(nodes, {
    mode: "RESUME",
    runStatus: "FAILED",
    successfulAttemptNodeIds: ["a"],
    successfulAttemptBaselines: { a: baseline },
    ioRoot,
  });
  assert.deepEqual(resumed.calls, []);
  assert.equal(resumed.summary.nodeResults[0].disposition, "PRESERVED");

  const rerun = await execute(nodes, {
    mode: "RERUN_FROM",
    selectedNodeIds: ["a"],
    runStatus: "FAILED",
    successfulAttemptNodeIds: ["a"],
    successfulAttemptBaselines: { a: baseline },
    initial: { a: "WAITING" },
    ioRoot,
  });
  assert.deepEqual(rerun.calls, []);
  const attempts = await rerun.repository.getAttempts("run_1");
  const latest = attempts.sort(
    (left, right) => right.value.attempt_no - left.value.attempt_no,
  )[0];
  assert.equal(latest.value.result_code, "INPUT_FILE_MUTATED");
  assert.equal(latest.value.execution_started_at, null);
  assert.equal(rerun.summary.invocationResultCode, "INPUT_FILE_MUTATED");
});

test("到達しない下流nodeのinputは一律pre-flightしない", async () => {
  const result = await execute(
    [
      { id: "upstream", dependsOn: [] },
      {
        id: "downstream",
        dependsOn: ["upstream"],
        inputs: { sales: "missing.csv" },
      },
    ],
    { outcomes: { upstream: "FAILED" } },
  );
  assert.deepEqual(result.calls, ["upstream"]);
  assert.equal(result.summary.nodeResults[1].status, "BLOCKED");
  assert.equal(
    (await result.repository.getAttempts("run_1")).filter(
      ({ value }) => value.node_id === "downstream",
    ).length,
    0,
  );
});

test("retry brake counts equal trailing failures and treats PREPARE_FAILED as transparent", () => {
  const attempt = (attemptNo, status, resultCode) => ({
    revision: 1,
    value: {
      node_id: "a",
      attempt_no: attemptNo,
      status,
      result_code: resultCode,
    },
  });
  assert.deepEqual(
    retryBrakeForNode(
      [
        attempt(1, "FAILED", "SQL_ERROR"),
        attempt(2, "CANCELLED", "PREPARE_FAILED"),
        attempt(3, "FAILED", "SQL_ERROR"),
        attempt(4, "FAILED", "SQL_ERROR"),
      ],
      "a",
    ),
    { failureKind: "SQL_ERROR", count: 3 },
  );
  for (const breaker of [
    attempt(4, "UNKNOWN", "SQL_ERROR"),
    attempt(4, "FAILED", "API_ERROR"),
    attempt(4, "FAILED", ""),
  ]) {
    assert.equal(
      retryBrakeForNode(
        [
          attempt(1, "FAILED", "SQL_ERROR"),
          attempt(2, "FAILED", "SQL_ERROR"),
          attempt(3, "FAILED", "SQL_ERROR"),
          breaker,
        ],
        "a",
      ),
      null,
    );
  }
});

test("CANCEL_REQUEST is accepted before node launch and closes STOP_REQUESTED", async () => {
  const result = await execute([{ id: "a", dependsOn: [] }], {
    afterSeed: async ({ repository }) => {
      await repository.createCancelRequest({
        run_id: "run_1",
        state: "REQUESTED",
        requested_by: "operator",
        reason: "maintenance",
        requested_at: T0,
        accepted_at: null,
        released_at: null,
        release_reason: null,
        release_requested_by: null,
      });
    },
  });
  assert.deepEqual(result.calls, []);
  assert.equal(result.summary.invocationStatus, "CANCELLED");
  assert.equal(result.summary.invocationResultCode, "STOP_REQUESTED");
  assert.equal(
    (await result.repository.getCancelRequest("run_1")).value.state,
    "ACCEPTED",
  );
  assert.equal(
    (await result.repository.getNodeStates("run_1"))[0].value.status,
    "WAITING",
  );
});

test("RESUME retry brake excludes the failed branch after three equal failures", async () => {
  const nodes = [
    { id: "failed", dependsOn: [] },
    { id: "child", dependsOn: ["failed"] },
    { id: "independent", dependsOn: [] },
  ];
  const result = await execute(nodes, {
    mode: "RESUME",
    runStatus: "RUNNING",
    afterSeed: async ({ repository }) => {
      let state = (await repository.getNodeStates("run_1")).find(
        ({ value }) => value.node_id === "failed",
      );
      for (let number = 1; number <= 3; number += 1) {
        const attempt = await repository.createAttempt({
          node_state: state,
          node_attempt_id: `failed_${number}`,
          invocation_id: `old_${number}`,
        });
        state = await repository.upsertNodeState({
          expected_revision: state.revision,
          value: {
            ...state.value,
            status: "RUNNING",
            latest_attempt_no: number,
            active_attempt_id: attempt.value.node_attempt_id,
          },
        });
        await repository.finalizeAttempt(
          attempt.value.node_attempt_id,
          attempt.revision,
          {
            status: "FAILED",
            result_code: "SQL_ERROR",
            runner_execution_started_at: T0,
            execution_id: `exec_${number}`,
            finished_at: T0,
            duration_sec: 0,
            error_message: "deterministic",
            read_count: 0,
            written_count: 0,
            last_successful_chunk_no: null,
            last_written_key: null,
          },
        );
        state = await repository.upsertNodeState({
          expected_revision: state.revision,
          value: {
            ...state.value,
            status: "FAILED",
            active_attempt_id: null,
            status_reason: "SQL_ERROR",
          },
        });
        if (number < 3)
          state = await repository.upsertNodeState({
            expected_revision: state.revision,
            value: { ...state.value, status: "WAITING" },
          });
      }
    },
  });
  assert.deepEqual(result.calls, ["independent"]);
  const states = new Map(
    (await result.repository.getNodeStates("run_1")).map(({ value }) => [
      value.node_id,
      value,
    ]),
  );
  assert.equal(states.get("failed").status, "FAILED");
  assert.equal(states.get("failed").status_reason, "RETRY_BRAKE:SQL_ERRORx3");
  assert.deepEqual(result.summary.retryBrakeNodeIds, ["failed"]);
  assert.equal(states.get("child").status, "BLOCKED");
  assert.equal(states.get("independent").status, "SUCCESS");
  assert.equal(
    (await result.repository.getAttempts("run_1")).filter(
      ({ value }) => value.node_id === "failed",
    ).length,
    3,
  );
});

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

test("孤児RUNNING+ログRUNNINGはUNKNOWNになり、下流だけBLOCKEDで独立系統は継続する（受入25）", async () => {
  const nodes = [
    { id: "orphan", dependsOn: [] },
    { id: "child", dependsOn: ["orphan"] },
    { id: "independent", dependsOn: [] },
  ];
  const result = await execute(nodes, {
    mode: "RESUME",
    runStatus: "RUNNING",
    runningAttempts: { orphan: "invoke_old" },
    jobLogReader: {
      async findAttemptResult() {
        return {
          status: "RUNNING",
          runnerExecutionStartedAt: T0,
          executionId: "exec_orphan",
          finishedAt: null,
        };
      },
    },
  });
  assert.deepEqual(result.calls, ["independent"]);
  const states = new Map(
    (await result.repository.getNodeStates("run_1")).map(({ value }) => [
      value.node_id,
      value,
    ]),
  );
  assert.equal(states.get("orphan").status, "UNKNOWN");
  assert.equal(states.get("child").status, "BLOCKED");
  const orphanAttempt = (await result.repository.getAttempts("run_1")).find(
    ({ value }) => value.node_id === "orphan",
  ).value;
  assert.equal(orphanAttempt.status, "UNKNOWN");
  assert.equal(orphanAttempt.result_code, "NO_EXECUTION_RESULT");
  assert.equal(orphanAttempt.runner_execution_started_at, null);
  assert.match(result.closeCalls[0].reason, /running_attempt_orphan=UNKNOWN/);
});

test("孤児RUNNING+ログSUCCESSはSUCCESSへ裁定して下流を継続する（受入25）", async () => {
  const nodes = [
    { id: "orphan", dependsOn: [] },
    { id: "child", dependsOn: ["orphan"] },
  ];
  const result = await execute(nodes, {
    mode: "RESUME",
    runStatus: "RUNNING",
    runningAttempts: { orphan: "invoke_old" },
    jobLogReader: {
      async findAttemptResult() {
        return {
          status: "SUCCESS",
          runnerExecutionStartedAt: T0,
          executionId: "exec_orphan",
          finishedAt: T0,
        };
      },
    },
  });
  assert.deepEqual(result.calls, ["child"]);
  const attempts = await result.repository.getAttempts("run_1");
  assert.equal(
    attempts.find(({ value }) => value.node_id === "orphan").value.status,
    "SUCCESS",
  );
  assert.equal(result.summary.aggregateStatus, "SUCCESS");
});

test("孤児RUNNING+ログ不在はUNKNOWNへ裁定する（受入25）", async () => {
  const result = await execute([{ id: "orphan", dependsOn: [] }], {
    mode: "RESUME",
    runStatus: "RUNNING",
    runningAttempts: { orphan: "invoke_old" },
    jobLogReader: {
      async findAttemptResult() {
        return null;
      },
    },
  });
  const attempt = (await result.repository.getAttempts("run_1"))[0].value;
  assert.equal(attempt.status, "UNKNOWN");
  assert.equal(attempt.result_code, "NO_EXECUTION_RESULT");
});

test("孤児RUNNINGのログ読取エラーは裁定せずfail-closedで停止する（受入25）", async () => {
  const nodes = [{ id: "orphan", dependsOn: [] }];
  const seeded = await seed(nodes, {
    mode: "RESUME",
    runStatus: "RUNNING",
    runningAttempts: { orphan: "invoke_old" },
  });
  const closeCalls = [];
  await assert.rejects(
    runSequentialScheduler({
      run: seeded.seededRun,
      invocation: seeded.seededInvocation,
      bundleBytes: bundle(nodes),
      repository: seeded.repository,
      attemptExecutor: {
        async execute() {
          throw new Error("unexpected");
        },
      },
      jobLogReader: {
        async findAttemptResult() {
          throw new Error("job log unavailable");
        },
      },
      leaseMonitor: heldMonitor(),
      profile: "prod",
      configPath: "C:\\secure\\config.json",
      close: async (value) => closeCalls.push(value),
    }),
    /job log unavailable/,
  );
  assert.equal(
    (await seeded.repository.getAttempts("run_1"))[0].value.status,
    "RUNNING",
  );
  assert.equal(
    (await seeded.repository.getNodeStates("run_1"))[0].value.status,
    "RUNNING",
  );
  assert.equal(closeCalls[0].status, "FAILED");
});

test("現Invocation自身のRUNNING Attemptは孤児裁定の対象外（受入25）", async () => {
  let reads = 0;
  const result = await execute(
    [
      { id: "active", dependsOn: [] },
      { id: "independent", dependsOn: [] },
    ],
    {
      mode: "RESUME",
      runStatus: "RUNNING",
      runningAttempts: { active: "invoke_1" },
      jobLogReader: {
        async findAttemptResult() {
          reads += 1;
          throw new Error("unexpected");
        },
      },
    },
  );
  assert.equal(reads, 0);
  assert.equal(
    (await result.repository.getAttempts("run_1"))[0].value.status,
    "RUNNING",
  );
  assert.deepEqual(result.calls, ["independent"]);
});

test("resumeは孤児Attempt裁定後に旧Invocationだけを終端して監査する", async () => {
  const result = await execute([{ id: "a", dependsOn: [] }], {
    mode: "RESUME",
    runStatus: "RUNNING",
    abandonedInvocationStatuses: ["RUNNING", "CREATED"],
  });
  const invocations = await result.repository.getInvocations("run_1");
  for (const invocationId of ["invoke_old_1", "invoke_old_2"]) {
    const old = invocations.find(
      ({ value }) => value.invocation_id === invocationId,
    ).value;
    assert.equal(old.status, "CANCELLED");
    assert.equal(old.result_code, "NETWORK_LEASE_INTERRUPTED");
  }
  assert.equal(
    result.operationAudits.some(
      ({ target_id }) =>
        target_id === result.seededInvocation.value.invocation_id,
    ),
    false,
  );
  assert.deepEqual(
    result.operationAudits.map(
      ({ repair_type, target_type, before, after }) => ({
        repair_type,
        target_type,
        before: before.status,
        after: after.status,
      }),
    ),
    [
      {
        repair_type: "INVOCATION_FINALIZED",
        target_type: "RUN_INVOCATION",
        before: "RUNNING",
        after: "CANCELLED",
      },
      {
        repair_type: "INVOCATION_FINALIZED",
        target_type: "RUN_INVOCATION",
        before: "CREATED",
        after: "CANCELLED",
      },
    ],
  );
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

test("RERUN_FROMは対象集合だけを再実行し過去Attemptを保持して継続採番する（受入12）", async () => {
  const nodes = [
    { id: "upstream", dependsOn: [] },
    { id: "selected", dependsOn: ["upstream"] },
    { id: "child", dependsOn: ["selected"] },
    { id: "sibling", dependsOn: ["upstream"] },
  ];
  const result = await execute(nodes, {
    mode: "RERUN_FROM",
    runStatus: "FAILED",
    selectedNodeIds: ["selected", "child"],
    successfulAttemptNodeIds: ["upstream", "selected", "child", "sibling"],
    initial: { selected: "WAITING", child: "WAITING" },
  });
  assert.deepEqual(result.calls, ["selected", "child"]);
  assert.deepEqual(result.summary.selectedNodeIds, ["selected", "child"]);
  assert.deepEqual(result.summary.preservedNodeIds, ["upstream", "sibling"]);
  const attempts = await result.repository.getAttempts("run_1");
  for (const nodeId of ["selected", "child"]) {
    assert.deepEqual(
      attempts
        .filter(({ value }) => value.node_id === nodeId)
        .map(({ value }) => [value.attempt_no, value.status]),
      [
        [1, "SUCCESS"],
        [2, "SUCCESS"],
      ],
    );
  }
  for (const nodeId of ["upstream", "sibling"]) {
    assert.equal(
      attempts.filter(({ value }) => value.node_id === nodeId).length,
      1,
    );
  }
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

test("node実行中のcontrol-plane到達不能は期限内回復後に保存して新Nodeを開始しない", async () => {
  const nodes = [
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: ["a"] },
  ];
  const seeded = await seed(nodes);
  let state = "HELD";
  let confirmations = 0;
  let operationCalls = 0;
  let clock = 0;
  const monitor = heldMonitor({
    canStartNewNode: () => state === "HELD",
    canPersistResults: () => state === "HELD" || state === "FINAL",
    markControlPlaneUnreachable: () => {
      state = "UNCERTAIN";
    },
    confirmLeaseForFinalWrite: async () => {
      confirmations += 1;
      if (confirmations < 2) return false;
      state = "FINAL";
      return true;
    },
    requiresNetworkLeaseInterruptedFinalization: () => state === "FINAL",
    tick: async () => state === "HELD",
  });
  const calls = [];
  const base = fakeExecutor(seeded.repository, {}, calls, {
    active: 0,
    max: 0,
  });
  const closeCalls = [];
  const summary = await runSequentialScheduler({
    run: seeded.seededRun,
    invocation: seeded.seededInvocation,
    bundleBytes: bundle(nodes),
    repository: seeded.repository,
    attemptExecutor: {
      async execute(input) {
        await input.runControlPlaneOperation(async () => {
          operationCalls += 1;
          if (operationCalls === 1)
            throw new KintoneTransportError(new TypeError("fetch failed"));
          return null;
        });
        return base.execute(input);
      },
    },
    leaseMonitor: monitor,
    profile: "prod",
    configPath: "C:\\secure\\config.json",
    controlPlaneDrain: {
      retryDelayMs: 1,
      nowMs: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
    },
    close: async (value) => closeCalls.push(value),
  });
  assert.deepEqual(calls, ["a"]);
  assert.equal(operationCalls, 2);
  assert.equal(summary.invocationStatus, "CANCELLED");
  assert.equal(summary.invocationResultCode, "NETWORK_LEASE_INTERRUPTED");
  assert.equal(closeCalls[0].persistInvocation, undefined);
});

test("control-plane到達不能が期限内に回復しなければ結果を書かず非成功終了する", async () => {
  const nodes = [{ id: "a", dependsOn: [] }];
  const seeded = await seed(nodes);
  let clock = 0;
  const closeCalls = [];
  await assert.rejects(
    runSequentialScheduler({
      run: seeded.seededRun,
      invocation: seeded.seededInvocation,
      bundleBytes: bundle(nodes),
      repository: seeded.repository,
      attemptExecutor: {
        async execute(input) {
          await input.runControlPlaneOperation(async () => {
            throw new KintoneTransportError(new TypeError("fetch failed"));
          });
          assert.fail("unreachable operation must not recover");
        },
      },
      leaseMonitor: heldMonitor({
        markControlPlaneUnreachable: () => undefined,
        confirmLeaseForFinalWrite: async () => false,
      }),
      profile: "prod",
      configPath: "C:\\secure\\config.json",
      controlPlaneDrain: {
        retryDelayMs: 1_000,
        nowMs: () => clock,
        sleep: async (delayMs) => {
          clock += delayMs;
        },
      },
      close: async (value) => closeCalls.push(value),
    }),
    /network lease could not be confirmed/i,
  );
  const attempt = (await seeded.repository.getAttempts("run_1"))[0].value;
  const stateValue = (await seeded.repository.getNodeStates("run_1"))[0].value;
  assert.equal(attempt.status, "RUNNING");
  assert.equal(stateValue.status, "RUNNING");
  assert.equal(seeded.operationAudits.length, 0);
  assert.equal(closeCalls[0].persistInvocation, false);
});

test("control-plane API裁定エラーはdrain再試行せず即時失敗する", async () => {
  const nodes = [{ id: "a", dependsOn: [] }];
  const seeded = await seed(nodes);
  let marked = 0;
  let calls = 0;
  await assert.rejects(
    runSequentialScheduler({
      run: seeded.seededRun,
      invocation: seeded.seededInvocation,
      bundleBytes: bundle(nodes),
      repository: seeded.repository,
      attemptExecutor: {
        async execute(input) {
          await input.runControlPlaneOperation(async () => {
            calls += 1;
            throw new KintoneApiError(409, "GAIA_CO02", {});
          });
          assert.fail("API error must escape");
        },
      },
      leaseMonitor: heldMonitor({
        markControlPlaneUnreachable: () => {
          marked += 1;
        },
      }),
      profile: "prod",
      configPath: "C:\\secure\\config.json",
      close: async () => undefined,
    }),
    /kintone API returned 409/,
  );
  assert.equal(calls, 1);
  assert.equal(marked, 0);
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
  const order = [];
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
      leaseMonitor: heldMonitor({ stop: () => order.push("stop") }),
      profile: "prod",
      configPath: "C:\\secure\\config.json",
      close: async (value) => {
        order.push("close");
        closeCalls.push(value);
      },
    }),
    /boom/,
  );
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].status, "FAILED");
  assert.equal(closeCalls[0].resultCode, "SCHEDULER_FAILED");
  assert.deepEqual(order, ["stop", "close", "stop"]);
});

test("scheduler正常終了でもheartbeatを止めてからcloseする", async () => {
  const order = [];
  await execute([{ id: "a", dependsOn: [] }], {
    monitor: heldMonitor({ stop: () => order.push("stop") }),
    onClose: () => order.push("close"),
  });
  assert.deepEqual(order, ["stop", "close", "stop"]);
});
