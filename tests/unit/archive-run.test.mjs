import assert from "node:assert/strict";
import test from "node:test";
import { archiveRun } from "../../dist/orchestration/archive-run.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";
import { RepositoryError } from "../../dist/persistence/repository.js";

const at = "2026-09-05T00:00:00.000Z";
function run(status = "FAILED", lifecycle_status = "ACTIVE") {
  return {
    run_id: "run_1",
    network_id: "net",
    business_key: "net@1",
    status,
    lifecycle_status,
    resume_allowed: true,
    created_at: at,
    started_at: at,
    finished_at: at,
    updated_at: at,
    resolved_profile_snapshot: { profile: "prod" },
  };
}
function lock(releaseFails = false) {
  const calls = [];
  return {
    calls,
    manager: {
      async acquire() {
        calls.push("acquire");
        return { revision: 1 };
      },
      async release() {
        calls.push("release");
        if (releaseFails) throw new Error("release");
      },
    },
  };
}
function monitor(ticks = [true, true]) {
  const calls = [];
  return {
    calls,
    value: {
      start() {
        calls.push("start");
      },
      stop() {
        calls.push("stop");
      },
      async tick() {
        calls.push("tick");
        return ticks.shift() ?? true;
      },
    },
  };
}
async function invoke({
  status = "FAILED",
  lifecycle = "ACTIVE",
  ticks,
  releaseFails = false,
  mutate,
} = {}) {
  const repository = new InMemoryPersistenceRepository();
  await repository.createRun(run(status, lifecycle));
  if (mutate) mutate(repository);
  const l = lock(releaseFails);
  const m = monitor(ticks);
  const result = await archiveRun({
    repository,
    runId: "run_1",
    requestedBy: "operator",
    reason: "closed",
    servicePrincipal: "svc",
    uuid: () => "fixed",
    now: () => new Date(at),
    lockManagerFactory: () => l.manager,
    leaseMonitorFactory: () => m.value,
  });
  return { result, repository, lockCalls: l.calls, monitorCalls: m.calls };
}

test("archive-runはFAILED Runをrevision fencingでARCHIVEDにして監査し解放する", async () => {
  const { result, repository, lockCalls, monitorCalls } = await invoke();
  assert.deepEqual(result, {
    outcome: "ARCHIVED",
    run_id: "run_1",
    event_id: "archive_fixed",
    run_revision: 2,
    audit: "RECORDED",
    lock_released: true,
  });
  assert.equal(
    (await repository.getRun("run_1")).value.lifecycle_status,
    "ARCHIVED",
  );
  assert.equal(
    (await repository.getOperationAuditByEventId("archive_fixed")).value
      .event_type,
    "RUN_ARCHIVED",
  );
  assert.deepEqual(lockCalls, ["acquire", "release"]);
  assert.deepEqual(monitorCalls.at(-1), "stop");
});

test("archive-runはlease中断時点をarchive前後で区別する", async () => {
  assert.equal(
    (await invoke({ ticks: [false] })).result.code,
    "LEASE_INTERRUPTED",
  );
  const after = await invoke({ ticks: [true, false] });
  assert.equal(after.result.outcome, "ARCHIVED");
  assert.equal(after.result.code, "LEASE_INTERRUPTED_AFTER_ARCHIVE");
  assert.equal(after.result.audit, "PENDING");
});

test("archive-runはALREADY_ARCHIVEDとlock解放失敗をvariantで返す", async () => {
  const already = await invoke({ lifecycle: "ARCHIVED" });
  assert.equal(already.result.outcome, "ALREADY_ARCHIVED");
  assert.equal(already.result.lock_released, true);
  const failedRelease = await invoke({ releaseFails: true });
  assert.equal(failedRelease.result.outcome, "ARCHIVED");
  assert.equal(failedRelease.result.audit, "RECORDED");
  assert.equal(failedRelease.result.lock_released, false);
});

test("archive-runはlock競合をRun読取前にREJECTEDへ固定する", async () => {
  const result = await archiveRun({
    repository: {},
    runId: "run_1",
    requestedBy: "operator",
    reason: "close",
    servicePrincipal: "svc",
    uuid: () => "fixed",
    lockManagerFactory: () => ({
      async acquire() {
        throw Object.assign(new Error("held"), { code: "LOCK_CONFLICT" });
      },
      async release() {
        throw new Error("must not release");
      },
    }),
    leaseMonitorFactory: () => {
      throw new Error("must not monitor");
    },
  });
  assert.deepEqual(result, {
    outcome: "REJECTED",
    run_id: "run_1",
    event_id: "archive_fixed",
    run_revision: null,
    code: "LOCK_CONFLICT",
    lock_released: true,
  });
});

test("archive PUT応答喪失後にARCHIVEDを再読取できれば監査へ進む", async () => {
  const repository = new InMemoryPersistenceRepository();
  await repository.createRun(run());
  const original = repository.archiveRun.bind(repository);
  let first = true;
  repository.archiveRun = async (...args) => {
    const value = await original(...args);
    if (first) {
      first = false;
      throw new RepositoryError("AMBIGUOUS_WRITE", "lost");
    }
    return value;
  };
  const l = lock();
  const m = monitor();
  const result = await archiveRun({
    repository,
    runId: "run_1",
    requestedBy: "operator",
    reason: "close",
    servicePrincipal: "svc",
    uuid: () => "fixed",
    now: () => new Date(at),
    lockManagerFactory: () => l.manager,
    leaseMonitorFactory: () => m.value,
  });
  assert.equal(result.outcome, "ARCHIVED");
  assert.equal(result.audit, "RECORDED");
});

test("監査明示失敗はARCHIVED/PENDING、応答喪失は再読取5項目で裁定する", async () => {
  const failed = await invoke({
    mutate(repository) {
      repository.appendOperationAudit = async () => {
        throw new RepositoryError("REMOTE_ERROR", "down");
      };
    },
  });
  assert.equal(failed.result.outcome, "ARCHIVED");
  assert.equal(failed.result.audit, "PENDING");
  assert.equal(failed.result.code, "ARCHIVE_AUDIT_FAILED");
  assert.equal(failed.result.lock_released, true);

  const matching = await invoke({
    mutate(repository) {
      const original = repository.appendOperationAudit.bind(repository);
      repository.appendOperationAudit = async (audit) => {
        await original(audit);
        throw new RepositoryError("AMBIGUOUS_WRITE", "lost");
      };
    },
  });
  assert.equal(matching.result.audit, "RECORDED");

  const conflict = await invoke({
    mutate(repository) {
      repository.appendOperationAudit = async (audit) => {
        const stored = { ...audit, run_revision_before: 999 };
        await InMemoryPersistenceRepository.prototype.appendOperationAudit.call(
          repository,
          stored,
        );
        throw new RepositoryError("AMBIGUOUS_WRITE", "lost");
      };
    },
  });
  assert.equal(conflict.result.audit, "PENDING");
  assert.equal(conflict.result.code, "AUDIT_CONFLICT");
});
