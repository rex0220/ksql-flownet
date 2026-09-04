import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureRun,
  EnsureRunError,
} from "../../dist/orchestration/ensure-run.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";
import { RepositoryError } from "../../dist/persistence/repository.js";
import { changeCancelRequest } from "../../dist/orchestration/cancel-request.js";
import { serializeInputBaseline } from "../../dist/io/input-baseline.js";

const T0 = "2026-08-30T01:02:03.004Z";

function capabilities() {
  return {
    formatVersion: 1,
    kind: "CAPABILITIES",
    ksqlFlowVersion: "1.2.3",
    engineVersion: "3.4.5",
    executionContracts: ["ksql-flow.execution/v1"],
    resultSchema: { $id: "schema", contract: "ksql-flow.execution/v1" },
    features: {
      resultJson: true,
      correlationIds: true,
      describeProfile: true,
      inspectJob: true,
      durableExecutionStarted: true,
    },
  };
}

function addInputs(networkPath) {
  const source = readFileSync(networkPath, "utf8");
  writeFileSync(
    networkPath,
    source.replace(
      "    idempotent: true",
      "    idempotent: true\n    inputs:\n      sales: sales_{business_key}_{profile}.csv",
    ),
  );
}

function addOutputs(networkPath) {
  const source = readFileSync(networkPath, "utf8");
  writeFileSync(
    networkPath,
    source.replace(
      "    idempotent: true",
      "    idempotent: true\n    outputs:\n      report: report_{run_id}_{node_id}.csv",
    ),
  );
}

function description(overrides = {}) {
  return {
    formatVersion: 1,
    kind: "PROFILE_DESCRIPTION",
    profile: "prod",
    baseUrl: "https://example.cybozu.com",
    guestSpaceId: null,
    timezone: "Asia/Tokyo",
    apps: { orders: 1 },
    logApp: null,
    limits: {
      maxApiCalls: null,
      maxReadRows: null,
      maxTempRows: null,
      batchTimeoutSec: 3600,
    },
    retry: { maxAttempts: 3 },
    httpTimeoutMs: 30000,
    ...overrides,
  };
}

function inspection(jobId = "job_one") {
  return {
    formatVersion: 1,
    kind: "JOB_INSPECTION",
    jobId,
    fileName: "one.sql",
    dialect: 1,
    statementCount: 1,
    dependsOn: [],
    timeoutSec: null,
    diagnostics: [],
    nondeterministicElements: [],
  };
}

function fixture(context, maxActiveRuns = 1) {
  const directory = mkdtempSync(join(tmpdir(), "ksql-flownet-ensure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "jobs"));
  writeFileSync(join(directory, "jobs", "one.sql"), "SELECT 1;\n");
  const networkPath = join(directory, "network.yaml");
  writeFileSync(
    networkPath,
    `schema_version: 1
network_id: net
business_key_policy:
  type: explicit
max_active_runs: ${maxActiveRuns}
network_lock:
  lease_duration_sec: 3
  heartbeat_interval_sec: 1
nodes:
  - id: one
    job_id: job_one
    sql: jobs/one.sql
    depends_on: []
    trigger_rule: all_success
    idempotent: true
`,
  );
  return { directory, networkPath };
}

function rerunFixture(context, childIdempotent = true) {
  const directory = mkdtempSync(join(tmpdir(), "ksql-flownet-rerun-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "jobs"));
  for (const id of ["upstream", "selected", "child", "sibling"])
    writeFileSync(join(directory, "jobs", `${id}.sql`), "SELECT 1;\n");
  const networkPath = join(directory, "network.yaml");
  writeFileSync(
    networkPath,
    `schema_version: 1
network_id: net
business_key_policy:
  type: explicit
network_lock:
  lease_duration_sec: 3
  heartbeat_interval_sec: 1
nodes:
  - id: upstream
    job_id: job_upstream
    sql: jobs/upstream.sql
    depends_on: []
    trigger_rule: all_success
    idempotent: true
  - id: selected
    job_id: job_selected
    sql: jobs/selected.sql
    depends_on: [upstream]
    trigger_rule: all_success
    idempotent: true
  - id: child
    job_id: job_child
    sql: jobs/child.sql
    depends_on: [selected]
    trigger_rule: all_success
    idempotent: ${String(childIdempotent)}
  - id: sibling
    job_id: job_sibling
    sql: jobs/sibling.sql
    depends_on: [upstream]
    trigger_rule: all_success
    idempotent: true
`,
  );
  return { networkPath };
}

class CapturingRepository extends InMemoryPersistenceRepository {
  events;
  finalized = [];
  constructor(events = []) {
    super();
    this.events = events;
  }
  async getRunByBusinessKey(...args) {
    this.events.push("search");
    return super.getRunByBusinessKey(...args);
  }
  async finalizeInvocation(...args) {
    const result = await super.finalizeInvocation(...args);
    this.finalized.push(result.value);
    return result;
  }
}

function harness(repository = new CapturingRepository(), overrides = {}) {
  const events = repository.events ?? [];
  const files = overrides.files ?? new Map();
  let fileNo = 0;
  const lockManager = {
    async acquire() {
      events.push("lock");
      return { leaseToken: "lease", recordId: "1" };
    },
    async release(_reference, status, resultCode) {
      events.push(`release:${status}:${resultCode}`);
    },
  };
  const executor = {
    async capabilities() {
      events.push("capabilities");
      return overrides.capabilities ?? capabilities();
    },
    async describeProfile() {
      events.push("profile");
      return overrides.profile ?? description();
    },
    async inspectJob(sqlPath) {
      events.push("inspect");
      const jobId = `job_${sqlPath
        .split(/[\\/]/u)
        .at(-1)
        .replace(/\.sql$/u, "")}`;
      return overrides.inspection?.(sqlPath) ?? inspection(jobId);
    },
  };
  const bundleStore = {
    async upload(bytes) {
      const key = `file-${++fileNo}`;
      files.set(key, Buffer.from(bytes));
      return key;
    },
    async download(key) {
      events.push(`download:${key}`);
      const bytes = files.get(key);
      if (bytes === undefined) throw new Error(`missing bundle ${key}`);
      return Buffer.from(bytes);
    },
  };
  return { repository, events, files, lockManager, executor, bundleStore };
}

function input(networkPath, h, overrides = {}) {
  return {
    networkPath,
    profile: "prod",
    businessKey: "net@one",
    requestedBy: "tester",
    host: "test-host",
    repository: h.repository,
    lockManager: h.lockManager,
    executor: h.executor,
    bundleStore: h.bundleStore,
    now: () => new Date(T0),
    uuid: (() => {
      let value = 0;
      return () => `id-${++value}`;
    })(),
    ...overrides,
  };
}

async function setNodeStatus(repository, runId, nodeId, status) {
  let state = (await repository.getNodeStates(runId)).find(
    ({ value }) => value.node_id === nodeId,
  );
  if (state.value.status === status) return;
  if (state.value.status !== "RUNNING") {
    state = await repository.upsertNodeState({
      expected_revision: state.revision,
      value: { ...state.value, status: "RUNNING" },
    });
  }
  await repository.upsertNodeState({
    expected_revision: state.revision,
    value: { ...state.value, status },
  });
}

async function setLatestAttemptNo(repository, runId, nodeId, attemptNo) {
  const state = (await repository.getNodeStates(runId)).find(
    ({ value }) => value.node_id === nodeId,
  );
  await repository.upsertNodeState({
    expected_revision: state.revision,
    value: { ...state.value, latest_attempt_no: attemptNo },
  });
}

async function seedPrepareFailedAttempt(
  repository,
  runId,
  nodeId,
  invocationId,
) {
  let state = (await repository.getNodeStates(runId)).find(
    ({ value }) => value.node_id === nodeId,
  );
  const attempt = await repository.createAttempt({
    node_state: state,
    node_attempt_id: `attempt_${nodeId}_prepare_failed`,
    invocation_id: invocationId,
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
  await repository.finalizeAttempt(
    attempt.value.node_attempt_id,
    attempt.revision,
    {
      status: "CANCELLED",
      result_code: "PREPARE_FAILED",
      runner_execution_started_at: null,
      execution_id: null,
      finished_at: T0,
      duration_sec: 0,
      error_message: "prepare failed",
      read_count: 0,
      written_count: 0,
      last_successful_chunk_no: null,
      last_written_key: null,
    },
  );
  await repository.upsertNodeState({
    expected_revision: state.revision,
    value: {
      ...state.value,
      status: "WAITING",
      active_attempt_id: null,
      status_reason: "PREPARE_FAILED",
    },
  });
}

test("D-02 0件NEW: capability後にlockを取り、その後だけ検索・作成する", async (context) => {
  const { networkPath } = fixture(context);
  const events = [];
  const h = harness(new CapturingRepository(events));
  const result = await ensureRun(input(networkPath, h));
  assert.equal(result.outcome, "NEW");
  assert.deepEqual(events.slice(0, 3), ["capabilities", "lock", "search"]);
  assert.equal(result.run.value.status, "CREATED");
  assert.deepEqual(result.run.value.resolved_profile_snapshot.limits, {
    max_api_calls: null,
    max_read_rows: null,
    batch_timeout_sec: 3600,
  });
  assert.equal(
    (await h.repository.getNodeStates(result.run.value.run_id)).length,
    1,
  );
  await result.close({ status: "CANCELLED", resultCode: "TEST_DONE" });
  assert.ok(events.includes("release:CANCELLED:TEST_DONE"));
  assert.equal(h.repository.finalized.at(-1).result_code, "TEST_DONE");
});

test("未設定のbatchTimeoutSecをnullのままsnapshotへ保存する", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness(undefined, {
    profile: description({
      limits: {
        maxApiCalls: null,
        maxReadRows: null,
        maxTempRows: null,
        batchTimeoutSec: null,
      },
    }),
  });
  const result = await ensureRun(input(networkPath, h));
  assert.equal(
    result.run.value.resolved_profile_snapshot.limits.batch_timeout_sec,
    null,
  );
  await result.close({ status: "CANCELLED", resultCode: "TEST_DONE" });
});

test("D-02 未完了1件RESUME: 保存bundleだけを検証し作業ツリーSQLを参照しない", async (context) => {
  const { directory, networkPath } = fixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  rmSync(join(directory, "jobs", "one.sql"));
  h.events.length = 0;
  const resumed = await ensureRun(input(networkPath, h, { resume: true }));
  assert.equal(resumed.outcome, "RESUME");
  assert.ok(h.events.some((event) => event.startsWith("download:")));
  assert.ok(!h.events.includes("inspect"));
  await resumed.close({ status: "CANCELLED", resultCode: "TEST_DONE" });
});

test("resume非指定の同一キー未完了RunはInvocation・bundle・Node state変更前に拒否する", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  const invocationCount = (
    await h.repository.getInvocations(created.run.value.run_id)
  ).length;
  const statesBefore = await h.repository.getNodeStates(
    created.run.value.run_id,
  );
  h.events.length = 0;
  await assert.rejects(ensureRun(input(networkPath, h)), (error) => {
    assert.ok(error instanceof EnsureRunError);
    assert.equal(error.code, "RUN_ALREADY_EXISTS");
    assert.deepEqual(error.blockedBy, [created.run.value.run_id]);
    return true;
  });
  assert.equal(
    (await h.repository.getInvocations(created.run.value.run_id)).length,
    invocationCount,
  );
  assert.deepEqual(
    await h.repository.getNodeStates(created.run.value.run_id),
    statesBefore,
  );
  assert.equal(
    h.events.some((event) => event.startsWith("download:")),
    false,
  );
});

test("CANCEL_REQUEST hold中のRESUMEはRUN_ON_HOLDで拒否する", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  await changeCancelRequest({
    repository: h.repository,
    runId: created.run.value.run_id,
    requestedBy: "operator",
    reason: "maintenance",
    release: false,
    now: () => new Date(T0),
  });
  await assert.rejects(
    ensureRun(input(networkPath, h, { resume: true })),
    (error) => {
      assert.equal(error.code, "RUN_ON_HOLD");
      assert.match(error.message, /CANCEL:/u);
      return true;
    },
  );
});

test("D-02 完了済1件NOOPとSUCCESS --resume-runは再オープンしない", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  const current = await h.repository.getRun(created.run.value.run_id);
  await h.repository.updateRunAggregate(
    current.value.run_id,
    current.revision,
    {
      status: "SUCCESS",
      started_at: T0,
      finished_at: T0,
      updated_at: T0,
    },
  );
  const noop = await ensureRun(
    input(networkPath, h, {
      businessKey: undefined,
      resumeRunId: current.value.run_id,
    }),
  );
  assert.equal(noop.outcome, "NOOP");
  assert.equal(noop.invocation, null);
  assert.ok(h.events.includes("release:SUCCESS:ALREADY_SUCCESS"));
});

test("D-02 複数件はfail-closedでlockを解放する", async (context) => {
  const { networkPath } = fixture(context);
  class BrokenRepository extends CapturingRepository {
    async getRunByBusinessKey() {
      this.events.push("search");
      throw new RepositoryError("MULTIPLE_RECORDS", "duplicate legacy rows");
    }
  }
  const h = harness(new BrokenRepository([]));
  await assert.rejects(ensureRun(input(networkPath, h)), (error) => {
    assert.ok(error instanceof EnsureRunError);
    assert.equal(error.code, "MULTIPLE_RUNS");
    return true;
  });
  assert.ok(h.events.includes("release:FAILED:ENSURE_RUN_FAILED"));
});

function seededRun(overrides = {}) {
  return {
    run_id: "blocking-run",
    network_id: "net",
    business_key: "net@other",
    max_active_runs: 1,
    status: "CREATED",
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: null,
    definition_schema_version: 1,
    definition_sha256: "a".repeat(64),
    source_bundle_sha256: "b".repeat(64),
    source_bundle_attachment: "stored",
    resolved_profile_snapshot: {
      profile: "prod",
      base_url: "https://example.cybozu.com",
      guest_space_id: null,
      timezone: "Asia/Tokyo",
      apps: {},
      limits: { max_api_calls: 1, max_read_rows: 1, batch_timeout_sec: 1 },
    },
    resolved_profile_sha256: "c".repeat(64),
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

test("max_active_runs到達時は阻害run_idを返し、Runを作成しない", async (context) => {
  const { networkPath } = fixture(context);
  const repository = new CapturingRepository();
  await repository.createRun(seededRun());
  const h = harness(repository);
  await assert.rejects(ensureRun(input(networkPath, h)), (error) => {
    assert.equal(error.code, "MAX_ACTIVE_RUNS");
    assert.deepEqual(error.blockedBy, ["blocking-run"]);
    return true;
  });
  assert.equal((await repository.listRuns("prod", "net")).length, 1);
});

test("max_active_runsはARCHIVEDとresume_allowed=falseを除外する", async (context) => {
  const { networkPath } = fixture(context);
  for (const inactive of [
    { run_id: "archived", lifecycle_status: "ARCHIVED" },
    { run_id: "disabled", business_key: "net@disabled", resume_allowed: false },
  ]) {
    const repository = new CapturingRepository();
    await repository.createRun(seededRun(inactive));
    const h = harness(repository);
    const result = await ensureRun(input(networkPath, h));
    assert.equal(result.outcome, "NEW");
    await result.close({ status: "CANCELLED", resultCode: "TEST_DONE" });
  }
});

test("RESUMEのbundle hash不一致はInvocationをFAILEDにしてlockを解放する", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  h.files.set(
    created.run.value.source_bundle_attachment,
    Buffer.from("tampered"),
  );
  await assert.rejects(
    ensureRun(input(networkPath, h, { resume: true })),
    /SHA-256/,
  );
  assert.equal(h.repository.finalized.at(-1).status, "FAILED");
  assert.ok(h.events.includes("release:FAILED:ENSURE_RUN_FAILED"));
});

test("NEWの永続bundle検証失敗もInvocationをFAILEDにしてlockを解放する", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness();
  h.bundleStore.download = async () => Buffer.from("corrupted-after-attach");
  await assert.rejects(ensureRun(input(networkPath, h)), /SHA-256/);
  assert.equal(h.repository.finalized.at(-1).status, "FAILED");
  assert.ok(h.events.includes("release:FAILED:ENSURE_RUN_FAILED"));
});

test("RESUMEのprofile snapshot不一致を拒否する", async (context) => {
  const { networkPath } = fixture(context);
  const shared = harness();
  const created = await ensureRun(input(networkPath, shared));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  const changed = harness(shared.repository, {
    files: shared.files,
    profile: description({ baseUrl: "https://other.cybozu.com" }),
  });
  await assert.rejects(
    ensureRun(input(networkPath, changed, { resume: true })),
    /differs from snapshot/,
  );
  assert.ok(changed.events.includes("release:FAILED:ENSURE_RUN_FAILED"));
});

test("ARCHIVEDまたはresume_allowed=falseのRunはRESUMEを拒否する", async (context) => {
  const { networkPath } = fixture(context);
  for (const override of [
    { lifecycle_status: "ARCHIVED" },
    { resume_allowed: false },
  ]) {
    class NonResumableRepository extends CapturingRepository {
      async getRunByBusinessKey(...args) {
        const found = await super.getRunByBusinessKey(...args);
        if (found === null) return null;
        return {
          ...found,
          value: { ...found.value, ...override },
        };
      }
    }
    const repository = new NonResumableRepository();
    const h = harness(repository);
    const created = await ensureRun(input(networkPath, h));
    await created.close({ status: "CANCELLED", resultCode: "SEED" });
    await assert.rejects(
      ensureRun(input(networkPath, h, { resume: true })),
      (error) => error.code === "RUN_NOT_RESUMABLE",
    );
    assert.ok(h.events.includes("release:FAILED:ENSURE_RUN_FAILED"));
  }
});

test("純粋な手動NEWは未指定business keyを生成する", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness();
  const result = await ensureRun(
    input(networkPath, h, { businessKey: undefined }),
  );
  assert.equal(result.businessKey, "net@manual-20260830T010203004Z");
  await result.close({ status: "CANCELLED", resultCode: "TEST_DONE" });
});

test("capability不一致ではNetwork lockを取得しない", async (context) => {
  const { networkPath } = fixture(context);
  const h = harness();
  h.executor.capabilities = async () => ({
    ...capabilities(),
    executionContracts: [],
  });
  await assert.rejects(ensureRun(input(networkPath, h)), /not supported/);
  assert.ok(!h.events.includes("lock"));
});

test("inputs付きnetworkはimportCsvをNetwork lock取得前に必須化する", async (context) => {
  const { networkPath } = fixture(context);
  addInputs(networkPath);
  const h = harness();
  await assert.rejects(ensureRun(input(networkPath, h)), (error) => {
    assert.equal(error.code, "CAPABILITY_FEATURE_MISSING");
    assert.deepEqual(error.details, ["importCsv"]);
    return true;
  });
  assert.deepEqual(h.events, ["capabilities"]);

  h.executor.capabilities = async () => {
    h.events.push("capabilities");
    return {
      ...capabilities(),
      features: { ...capabilities().features, importCsv: true },
    };
  };
  const accepted = await ensureRun(
    input(networkPath, h, {
      beforeLock: () => h.events.push("io-config"),
    }),
  );
  assert.equal(accepted.outcome, "NEW");
  assert.deepEqual(h.events.slice(1, 4), ["capabilities", "io-config", "lock"]);
});

test("outputs付きnetworkはresultCsvをNetwork lock取得前に必須化する", async (context) => {
  const { networkPath } = fixture(context);
  addOutputs(networkPath);
  const h = harness();
  await assert.rejects(ensureRun(input(networkPath, h)), (error) => {
    assert.equal(error.code, "CAPABILITY_FEATURE_MISSING");
    assert.deepEqual(error.details, ["resultCsv"]);
    return true;
  });
  assert.deepEqual(h.events, ["capabilities"]);

  h.executor.capabilities = async () => {
    h.events.push("capabilities");
    return {
      ...capabilities(),
      features: { ...capabilities().features, resultCsv: true },
    };
  };
  const accepted = await ensureRun(
    input(networkPath, h, {
      beforeLock: () => h.events.push("io-config"),
    }),
  );
  assert.equal(accepted.outcome, "NEW");
  assert.deepEqual(h.events.slice(1, 4), ["capabilities", "io-config", "lock"]);
});

test("--rerun-fromは未実行の非冪等子孫を含めてWAITINGへ戻しmodeと対象集合を記録する", async (context) => {
  const { networkPath } = rerunFixture(context, false);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  for (const id of ["upstream", "sibling"])
    await setNodeStatus(h.repository, created.run.value.run_id, id, "SUCCESS");
  await setNodeStatus(
    h.repository,
    created.run.value.run_id,
    "selected",
    "FAILED",
  );
  const current = await h.repository.getRun(created.run.value.run_id);
  await h.repository.updateRunAggregate(
    current.value.run_id,
    current.revision,
    {
      status: "FAILED",
      started_at: T0,
      finished_at: T0,
      updated_at: T0,
    },
  );

  const result = await ensureRun(
    input(networkPath, h, {
      businessKey: undefined,
      resumeRunId: current.value.run_id,
      rerunFrom: "selected",
    }),
  );
  assert.equal(result.invocation.value.mode, "RERUN_FROM");
  assert.deepEqual(result.invocation.value.selected_node_ids, [
    "selected",
    "child",
  ]);
  const statuses = Object.fromEntries(
    (await h.repository.getNodeStates(current.value.run_id)).map(
      ({ value }) => [value.node_id, value.status],
    ),
  );
  assert.deepEqual(statuses, {
    upstream: "SUCCESS",
    selected: "WAITING",
    child: "WAITING",
    sibling: "SUCCESS",
  });
  const child = (await h.repository.getNodeStates(current.value.run_id)).find(
    ({ value }) => value.node_id === "child",
  ).value;
  assert.equal(child.idempotent, false);
  assert.equal(child.latest_attempt_no, 0);
  await result.close({ status: "CANCELLED", resultCode: "TEST_DONE" });
});

test("--rerun-fromは終端SUCCESS Runをcorrection案内付き安定codeで拒否する", async (context) => {
  const { networkPath } = rerunFixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  for (const id of ["upstream", "selected", "child", "sibling"])
    await setNodeStatus(h.repository, created.run.value.run_id, id, "SUCCESS");
  let current = await h.repository.getRun(created.run.value.run_id);
  current = await h.repository.updateRunAggregate(
    current.value.run_id,
    current.revision,
    { status: "SUCCESS", started_at: T0, finished_at: T0, updated_at: T0 },
  );
  const before = await h.repository.getNodeStates(current.value.run_id);
  await assert.rejects(
    ensureRun(
      input(networkPath, h, {
        businessKey: undefined,
        resumeRunId: current.value.run_id,
        rerunFrom: "selected",
      }),
    ),
    (error) => {
      assert.equal(error.code, "RERUN_FROM_SUCCESS_RUN");
      assert.match(error.message, /correction business key/);
      return true;
    },
  );
  assert.deepEqual(
    await h.repository.getNodeStates(current.value.run_id),
    before,
  );
});

test("--rerun-fromはノード不在を安定codeで拒否する", async (context) => {
  const { networkPath } = rerunFixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  await assert.rejects(
    ensureRun(
      input(networkPath, h, {
        businessKey: undefined,
        resumeRunId: created.run.value.run_id,
        rerunFrom: "missing",
      }),
    ),
    (error) => error.code === "RERUN_FROM_NODE_NOT_FOUND",
  );
});

test("--rerun-fromは対象内UNKNOWNを状態変更せず安定codeで拒否する", async (context) => {
  const { networkPath } = rerunFixture(context);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  await setNodeStatus(
    h.repository,
    created.run.value.run_id,
    "child",
    "UNKNOWN",
  );
  const before = await h.repository.getNodeStates(created.run.value.run_id);
  await assert.rejects(
    ensureRun(
      input(networkPath, h, {
        businessKey: undefined,
        resumeRunId: created.run.value.run_id,
        rerunFrom: "selected",
      }),
    ),
    (error) => error.code === "RERUN_FROM_UNKNOWN_STATE",
  );
  assert.deepEqual(
    await h.repository.getNodeStates(created.run.value.run_id),
    before,
  );
});

test("--rerun-fromは実行済みidempotent=falseを状態変更せず安定codeで拒否する", async (context) => {
  const { networkPath } = rerunFixture(context, false);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  await setLatestAttemptNo(h.repository, created.run.value.run_id, "child", 1);
  const before = await h.repository.getNodeStates(created.run.value.run_id);
  await assert.rejects(
    ensureRun(
      input(networkPath, h, {
        businessKey: undefined,
        resumeRunId: created.run.value.run_id,
        rerunFrom: "selected",
      }),
    ),
    (error) => {
      assert.equal(error.code, "RERUN_FROM_NON_IDEMPOTENT");
      assert.match(error.message, /executed idempotent=false/);
      return true;
    },
  );
  assert.deepEqual(
    await h.repository.getNodeStates(created.run.value.run_id),
    before,
  );
});

test("--rerun-fromはPREPARE_FAILEDだけでもattempt済み非冪等ノードを拒否する", async (context) => {
  const { networkPath } = rerunFixture(context, false);
  const h = harness();
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });
  await seedPrepareFailedAttempt(
    h.repository,
    created.run.value.run_id,
    "child",
    created.invocation.value.invocation_id,
  );
  const before = await h.repository.getNodeStates(created.run.value.run_id);
  const attempts = await h.repository.getAttempts(created.run.value.run_id);
  assert.deepEqual(
    attempts.map(({ value }) => [
      value.node_id,
      value.attempt_no,
      value.status,
      value.result_code,
    ]),
    [["child", 1, "CANCELLED", "PREPARE_FAILED"]],
  );
  await assert.rejects(
    ensureRun(
      input(networkPath, h, {
        businessKey: undefined,
        resumeRunId: created.run.value.run_id,
        rerunFrom: "selected",
      }),
    ),
    (error) => error.code === "RERUN_FROM_NON_IDEMPOTENT",
  );
  assert.deepEqual(
    await h.repository.getNodeStates(created.run.value.run_id),
    before,
  );
});

test("入力Runのresume保持期限は90日と最終分を許容し、超過はInvocation前に拒否する", async (context) => {
  const { networkPath } = fixture(context);
  addInputs(networkPath);
  const h = harness(undefined, {
    capabilities: {
      ...capabilities(),
      features: { ...capabilities().features, importCsv: true },
    },
  });
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });

  const boundary = new Date(Date.parse(T0) + 90 * 86_400_000 + 59_000);
  const resumed = await ensureRun(
    input(networkPath, h, {
      resume: true,
      ioRetentionDays: 90,
      now: () => boundary,
    }),
  );
  await resumed.close({ status: "CANCELLED", resultCode: "BOUNDARY_OK" });
  const invocationCount = (
    await h.repository.getInvocations(created.run.value.run_id)
  ).length;

  await assert.rejects(
    ensureRun(
      input(networkPath, h, {
        resume: true,
        ioRetentionDays: 90,
        now: () => new Date(Date.parse(T0) + 90 * 86_400_000 + 60_000),
      }),
    ),
    (error) => {
      assert.equal(error.code, "INPUT_RETENTION_EXPIRED");
      assert.match(error.message, /correction business key/);
      return true;
    },
  );
  assert.equal(
    (await h.repository.getInvocations(created.run.value.run_id)).length,
    invocationCount,
  );
});

test("resume対象importの差替えはInvocation作成前にINPUT_FILE_MUTATEDで拒否する", async (context) => {
  const { networkPath } = fixture(context);
  addInputs(networkPath);
  const ioRoot = mkdtempSync(join(tmpdir(), "ksql-flownet-ensure-io-"));
  context.after(() => rmSync(ioRoot, { recursive: true, force: true }));
  mkdirSync(join(ioRoot, "in"));
  writeFileSync(join(ioRoot, "in", "sales_net%40one_prod.csv"), "changed");
  const h = harness(undefined, {
    capabilities: {
      ...capabilities(),
      features: { ...capabilities().features, importCsv: true },
    },
  });
  const created = await ensureRun(input(networkPath, h));
  await created.close({ status: "CANCELLED", resultCode: "SEED" });

  let state = (await h.repository.getNodeStates(created.run.value.run_id))[0];
  let attempt = await h.repository.createAttempt({
    node_state: state,
    node_attempt_id: "attempt_old_input",
    invocation_id: created.invocation.value.invocation_id,
  });
  const original = "old";
  attempt = await h.repository.setAttemptInputBaseline(
    attempt.value.node_attempt_id,
    attempt.revision,
    {
      error_message: serializeInputBaseline([
        {
          name: "sales",
          sha256: createHash("sha256").update(original).digest("hex"),
          bytes: Buffer.byteLength(original),
        },
      ]),
    },
  );
  state = await h.repository.upsertNodeState({
    expected_revision: state.revision,
    value: {
      ...state.value,
      status: "RUNNING",
      latest_attempt_no: attempt.value.attempt_no,
      active_attempt_id: attempt.value.node_attempt_id,
    },
  });
  await h.repository.finalizeAttempt(
    attempt.value.node_attempt_id,
    attempt.revision,
    {
      status: "FAILED",
      result_code: "SQL_ERROR",
      runner_execution_started_at: T0,
      execution_id: "exec_old_input",
      finished_at: T0,
      duration_sec: 0,
      error_message: attempt.value.error_message,
      read_count: 0,
      written_count: 0,
      last_successful_chunk_no: null,
      last_written_key: null,
    },
  );
  await h.repository.upsertNodeState({
    expected_revision: state.revision,
    value: {
      ...state.value,
      status: "FAILED",
      active_attempt_id: null,
      status_reason: "SQL_ERROR",
    },
  });
  const before = (await h.repository.getInvocations(created.run.value.run_id))
    .length;
  await assert.rejects(
    ensureRun(
      input(networkPath, h, { resume: true, ioRoot, ioRetentionDays: 90 }),
    ),
    (error) => error.code === "INPUT_FILE_MUTATED",
  );
  assert.equal(
    (await h.repository.getInvocations(created.run.value.run_id)).length,
    before,
  );

  await assert.rejects(
    ensureRun(
      input(networkPath, h, {
        resume: true,
        rerunFrom: "one",
        ioRoot,
        ioRetentionDays: 90,
      }),
    ),
    (error) => error.code === "INPUT_FILE_MUTATED",
  );
  assert.equal(
    (await h.repository.getInvocations(created.run.value.run_id)).length,
    before,
  );
});
