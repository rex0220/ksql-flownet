import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureRun,
  EnsureRunError,
} from "../../dist/orchestration/ensure-run.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";
import { RepositoryError } from "../../dist/persistence/repository.js";

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
      maxApiCalls: 5000,
      maxReadRows: 200000,
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
      return capabilities();
    },
    async describeProfile() {
      events.push("profile");
      return overrides.profile ?? description();
    },
    async inspectJob() {
      events.push("inspect");
      return inspection();
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

test("D-02 0件NEW: capability後にlockを取り、その後だけ検索・作成する", async (context) => {
  const { networkPath } = fixture(context);
  const events = [];
  const h = harness(new CapturingRepository(events));
  const result = await ensureRun(input(networkPath, h));
  assert.equal(result.outcome, "NEW");
  assert.deepEqual(events.slice(0, 3), ["capabilities", "lock", "search"]);
  assert.equal(result.run.value.status, "CREATED");
  assert.equal(
    (await h.repository.getNodeStates(result.run.value.run_id)).length,
    1,
  );
  await result.close({ status: "CANCELLED", resultCode: "TEST_DONE" });
  assert.ok(events.includes("release:CANCELLED:TEST_DONE"));
  assert.equal(h.repository.finalized.at(-1).result_code, "TEST_DONE");
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
