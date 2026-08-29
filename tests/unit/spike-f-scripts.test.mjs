import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { assessCloudRunExecution } from "../../spikes/f-network-lock-recovery/scripts/cloud-run-adapter.mjs";
import {
  createHeartbeatFailureFetch,
  runDrainController,
} from "../../spikes/f-network-lock-recovery/scripts/drain-mode.mjs";
import { forceUnlockNetwork } from "../../spikes/f-network-lock-recovery/scripts/force-unlock-network.mjs";
import { runLeaseTokenFencing } from "../../spikes/f-network-lock-recovery/scripts/lease-token-fencing.mjs";
import {
  createNetworkLockAdapter,
  isStaleCandidate,
  makeLockIdentity,
  validateLeaseSettings,
} from "../../spikes/f-network-lock-recovery/scripts/network-lock-adapter.mjs";

const CONFIG = {
  baseUrl: "https://example.cybozu.com",
  execution: { app: "9002", token: "exec-secret" },
  audit: { app: "9003", token: "audit-secret" },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createKintoneFetchMock() {
  const apps = new Map();
  let nextId = 100;
  const calls = [];
  const recordsFor = (app) => {
    if (!apps.has(app)) apps.set(app, new Map());
    return apps.get(app);
  };
  const fetchMock = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    const app = String(body?.app ?? requestUrl.searchParams.get("app"));
    const records = recordsFor(app);
    calls.push({ method: options.method ?? "GET", url: String(url), body });
    if (
      requestUrl.pathname.endsWith("/record.json") &&
      options.method === "POST"
    ) {
      for (const existing of records.values()) {
        for (const code of ["record_key", "lock_key", "node_state_key"]) {
          const value = body.record[code]?.value;
          if (value && existing.record[code]?.value === value) {
            return Response.json({ code: "GAIA_DA02" }, { status: 400 });
          }
        }
      }
      const id = String(nextId++);
      records.set(id, { revision: 1, record: clone(body.record) });
      return Response.json({ id, revision: "1" });
    }
    if (
      requestUrl.pathname.endsWith("/record.json") &&
      options.method === "PUT"
    ) {
      const existing = records.get(String(body.id));
      if (!existing)
        return Response.json({ code: "GAIA_RE01" }, { status: 404 });
      if (String(existing.revision) !== String(body.revision)) {
        return Response.json({ code: "GAIA_CO02" }, { status: 409 });
      }
      existing.record = { ...existing.record, ...clone(body.record) };
      existing.revision += 1;
      return Response.json({ revision: String(existing.revision) });
    }
    if (requestUrl.pathname.endsWith("/record.json")) {
      const id = requestUrl.searchParams.get("id");
      const existing = records.get(String(id));
      if (!existing)
        return Response.json({ code: "GAIA_RE01" }, { status: 404 });
      return Response.json({
        record: {
          $id: { value: String(id) },
          $revision: { value: String(existing.revision) },
          ...clone(existing.record),
        },
      });
    }
    if (requestUrl.pathname.endsWith("/records.json")) {
      const query = requestUrl.searchParams.get("query") ?? "";
      const expected = query.match(/record_key = "([^"]+)"/)?.[1];
      const result = [...records.entries()]
        .filter(
          ([, entry]) =>
            !expected || entry.record.record_key?.value === expected,
        )
        .map(([id, entry]) => ({
          $id: { value: id },
          $revision: { value: String(entry.revision) },
          ...clone(entry.record),
        }));
      return Response.json({ records: result });
    }
    throw new Error(
      `unexpected request: ${options.method} ${requestUrl.pathname}`,
    );
  };
  fetchMock.calls = calls;
  fetchMock.apps = apps;
  return fetchMock;
}

test("lease設定はheartbeat < leaseかつ1/3以下だけを許可する", () => {
  assert.deepEqual(validateLeaseSettings(6, 2), {
    leaseSeconds: 6,
    heartbeatSeconds: 2,
  });
  assert.throws(() => validateLeaseSettings(6, 3), /1\/3以下/);
  assert.throws(() => validateLeaseSettings(2, 2), /lease期間未満/);
});

test("fetch mockで取得した期限超過lockはstale候補だが回収不可", async () => {
  const fetchMock = createKintoneFetchMock();
  const acquiredAt = new Date("2026-08-29T00:00:00.000Z");
  const adapter = createNetworkLockAdapter({
    config: CONFIG,
    fetchImplementation: fetchMock,
    now: () => acquiredAt,
  });
  const lock = await adapter.acquire({
    identity: makeLockIdentity("unit-stale"),
    leaseSeconds: 6,
  });
  const record = await adapter.getById(lock.id);
  const decision = isStaleCandidate(record, "2026-08-29T00:00:07.000Z");
  assert.equal(decision.staleCandidate, true);
  assert.equal(decision.ownerStopped, false);
  assert.equal(decision.reclaimAllowed, false);
  assert.equal(
    fetchMock.calls.filter((call) => call.method === "PUT").length,
    0,
  );
});

test("旧ownerは再GET token不一致とrevision 409の両方で拒否される", async () => {
  const result = await runLeaseTokenFencing({
    config: CONFIG,
    fetchImplementation: createKintoneFetchMock(),
  });
  assert.equal(result.passed, true);
  assert.equal(
    result.oldOwnerRejections.heartbeatRegetLeaseIdentityCheck.code,
    "LEASE_TOKEN_MISMATCH",
  );
  assert.equal(result.oldOwnerRejections.nodeStateRevision409.status, 409);
  assert.equal(result.nextNodeAllowedForOldOwner, false);
});

test("fetch障害drainは再更新成功時だけ保存して必ず次Nodeを止める", async () => {
  const baseFetch = async () => Response.json({ revision: "2" });
  const injected = createHeartbeatFailureFetch(baseFetch);
  injected.setMode("fail");
  let persisted = 0;
  let finalized = 0;
  let reconciled = 0;
  const result = await runDrainController({
    heartbeat: () =>
      injected("https://example.test/k/v1/record.json", {
        method: "PUT",
        body: JSON.stringify({ record: { heartbeat_at: { value: "now" } } }),
      }),
    runSubprocess: () =>
      new Promise((resolve) => setImmediate(() => resolve({ exitCode: 0 }))),
    waitForHeartbeat: async () => {},
    recoverHeartbeat: async () => {
      injected.setMode("pass");
      await injected("https://example.test/k/v1/record.json", {
        method: "PUT",
        body: JSON.stringify({ record: { heartbeat_at: { value: "now" } } }),
      });
    },
    persistResult: async () => {
      persisted += 1;
    },
    finalizeInterrupted: async () => {
      finalized += 1;
    },
    sendToReconciliation: async () => {
      reconciled += 1;
    },
  });
  assert.equal(result.branch, "RECOVERED_AND_CANCELLED");
  assert.equal(persisted, 1);
  assert.equal(finalized, 1);
  assert.equal(reconciled, 0);
});

test("fetch障害drainは再更新失敗時に状態を保存せずreconciliationへ送る", async () => {
  let persisted = 0;
  let reconciled = 0;
  const failure = async () => {
    throw new Error("injected unreachable");
  };
  const result = await runDrainController({
    heartbeat: failure,
    runSubprocess: () =>
      new Promise((resolve) => setImmediate(() => resolve({ exitCode: 0 }))),
    waitForHeartbeat: async () => {},
    recoverHeartbeat: failure,
    persistResult: async () => {
      persisted += 1;
    },
    finalizeInterrupted: async () => {},
    sendToReconciliation: async () => {
      reconciled += 1;
    },
  });
  assert.equal(result.branch, "RECONCILIATION");
  assert.equal(result.resultPersisted, false);
  assert.equal(persisted, 0);
  assert.equal(reconciled, 1);
});

test("Cloud Run停止確認判定表はterminal以外をfail-closedにする", () => {
  for (const state of ["SUCCEEDED", "FAILED", "CANCELLED"]) {
    assert.deepEqual(assessCloudRunExecution({ response: { state } }), {
      stopped: true,
      verdict: "TERMINAL",
      state,
      failClosed: false,
    });
  }
  for (const state of ["RUNNING", "PENDING"]) {
    assert.equal(
      assessCloudRunExecution({ response: { state } }).failClosed,
      true,
    );
  }
  assert.equal(
    assessCloudRunExecution({ error: { status: 403 } }).verdict,
    "PERMISSION_DENIED",
  );
  assert.equal(
    assessCloudRunExecution({ error: new Error("network") }).verdict,
    "API_ERROR",
  );
  assert.equal(
    assessCloudRunExecution({ response: { state: "NEW_STATE" } }).verdict,
    "UNKNOWN_STATE",
  );
  assert.equal(assessCloudRunExecution({ response: {} }).failClosed, true);
});

test("force unlockはexpected値を検証し応答消失後の再GET確定時だけ監査する", async () => {
  const fetchMock = createKintoneFetchMock();
  const adapter = createNetworkLockAdapter({
    config: CONFIG,
    fetchImplementation: fetchMock,
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  const lock = await adapter.acquire({
    identity: makeLockIdentity("unit-force"),
    leaseSeconds: 6,
  });
  const common = {
    adapter,
    reference: lock,
    expectedRevision: lock.revision,
    expectedLeaseToken: lock.leaseToken,
    stopEvidenceRef: "evidence://unit/stopped",
    reason: "unit recovery",
    servicePrincipal: "unit-service",
    confirmedBy: "unit-operator",
  };
  const mismatch = await forceUnlockNetwork({
    ...common,
    expectedOwnerInvocationId: "wrong-owner",
  });
  assert.equal(mismatch.failClosed, true);
  assert.equal(mismatch.auditWritten, false);
  const released = await forceUnlockNetwork({
    ...common,
    expectedOwnerInvocationId: lock.ownerInvocationId,
    simulateResponseLoss: true,
  });
  assert.equal(released.released, true);
  assert.equal(released.regetAdjudication, "RELEASE_CONFIRMED");
  assert.equal(released.auditWritten, true);
  const auditRecords = fetchMock.apps.get(CONFIG.audit.app);
  assert.equal(auditRecords.size, 1);
});
