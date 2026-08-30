import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  LeaseMonitor,
  NetworkLockError,
  NetworkLockManager,
  releaseTombstoneRecordKey,
} from "../../dist/persistence/network-lock.js";
import {
  KintoneApiError,
  KintoneClient,
} from "../../dist/persistence/kintone/client.js";

function createLockFake({
  duplicateWithoutRecord = false,
  loseAcquireResponse = false,
  loseReleaseResponse = false,
} = {}) {
  const records = [];
  const calls = [];
  let forceConflict = false;
  let beforeNextPut = null;
  let acquireResponseLost = false;
  let releaseResponseLost = false;
  const response = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetch = async (input, init) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    if (init.method === "POST") {
      if (
        duplicateWithoutRecord ||
        records.some(
          (record) => record.record_key.value === body.record.record_key.value,
        )
      ) {
        return response({ code: "CB_VA01" }, 400);
      }
      const stored = {
        ...body.record,
        $id: { value: String(records.length + 1) },
        $revision: { value: "1" },
      };
      records.push(stored);
      if (loseAcquireResponse && !acquireResponseLost) {
        acquireResponseLost = true;
        throw new TypeError("synthetic acquire response loss");
      }
      return response({ id: String(records.length), revision: "1" });
    }
    if (init.method === "GET") {
      const query = url.searchParams.get("query");
      const key = /record_key in \("(.+)"\)/.exec(query)?.[1];
      return response({
        records: records.filter((record) => record.record_key.value === key),
      });
    }
    if (init.method === "PUT") {
      if (beforeNextPut !== null) {
        const mutate = beforeNextPut;
        beforeNextPut = null;
        mutate(records);
      }
      if (forceConflict) {
        forceConflict = false;
        return response({ code: "GAIA_CO02" }, 409);
      }
      if (body.updateKey && Object.hasOwn(body.record, body.updateKey.field)) {
        return response({ code: "CB_VA01" }, 400);
      }
      const record = records.find((candidate) =>
        body.id
          ? candidate.$id.value === String(body.id)
          : candidate.record_key.value === body.updateKey.value,
      );
      if (!record) return response({ code: "GAIA_RE20" }, 404);
      if (Number(record.$revision.value) !== body.revision) {
        return response({ code: "GAIA_CO02" }, 409);
      }
      const revision = String(Number(record.$revision.value) + 1);
      Object.assign(record, body.record, { $revision: { value: revision } });
      if (
        loseReleaseResponse &&
        body.id &&
        body.record.record_key &&
        !releaseResponseLost
      ) {
        releaseResponseLost = true;
        throw new TypeError("synthetic release response loss");
      }
      return response({ revision });
    }
    throw new Error(`unexpected method ${init.method}`);
  };
  return {
    fetch,
    records,
    calls,
    conflictNextPut() {
      forceConflict = true;
    },
    beforeNextPut(mutate) {
      beforeNextPut = mutate;
    },
  };
}

function manager(fake, overrides = {}) {
  return new NetworkLockManager({
    baseUrl: "https://example.cybozu.com",
    appId: 100,
    apiToken: "token",
    profile: "prod",
    networkId: "monthly",
    ownerInvocationId: "invocation-a",
    ownerInstanceId: "host:1",
    leaseDurationSec: 30,
    fetch: fake.fetch,
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    uuid: () => "11111111-1111-4111-8111-111111111111",
    ...overrides,
  });
}

test("network lock: CB_VA01後の再GETでholder競合を裁定する", async () => {
  const fake = createLockFake();
  await manager(fake).acquire();
  const contender = manager(fake, {
    ownerInvocationId: "invocation-b",
    uuid: () => "22222222-2222-4222-8222-222222222222",
  });
  await assert.rejects(
    contender.acquire(),
    (error) =>
      error instanceof NetworkLockError && error.code === "LOCK_CONFLICT",
  );
  assert.equal(fake.records[0].record_key.value.length, 51);
});

test("network lock: acquire成功時と応答消失後の再GET時にrecord $idを保持する", async () => {
  const directFake = createLockFake();
  const direct = await manager(directFake).acquire();
  assert.equal(direct.recordId, "1");

  const lostFake = createLockFake({ loseAcquireResponse: true });
  const adjudicated = await manager(lostFake).acquire();
  assert.equal(adjudicated.recordId, "1");
});

test("network lock: 重複後にholderを一意確認できなければLOCK_UNAVAILABLE", async () => {
  const fake = createLockFake({ duplicateWithoutRecord: true });
  await assert.rejects(
    manager(fake).acquire(),
    (error) =>
      error instanceof NetworkLockError && error.code === "LOCK_UNAVAILABLE",
  );
});

test("network lock: heartbeatはtoken不一致をPUT前にfenceする", async () => {
  const fake = createLockFake();
  const lockManager = manager(fake);
  const reference = await lockManager.acquire();
  fake.records[0].lease_token.value = "reclaimed-token";
  await assert.rejects(
    lockManager.heartbeat(reference),
    (error) =>
      error instanceof NetworkLockError &&
      error.code === "LEASE_TOKEN_MISMATCH",
  );
  assert.equal(fake.calls.filter(({ method }) => method === "PUT").length, 0);
});

test("network lock: heartbeatの409を安定codeへ変換する", async () => {
  const fake = createLockFake();
  const lockManager = manager(fake);
  const reference = await lockManager.acquire();
  fake.conflictNextPut();
  await assert.rejects(
    lockManager.heartbeat(reference),
    (error) =>
      error instanceof NetworkLockError &&
      error.code === "LEASE_REVISION_CONFLICT",
  );
});

test("network lock: releaseは64文字内の一意tombstoneへ更新してlock_keyを空にする", async () => {
  assert.equal(releaseTombstoneRecordKey("x".repeat(55)).length, 64);
  assert.equal(releaseTombstoneRecordKey("x".repeat(56)).length, 52);

  const fake = createLockFake();
  const lockManager = manager(fake);
  const reference = await lockManager.acquire();
  const released = await lockManager.release(reference);
  assert.equal(released.released, true);
  assert.ok(released.recordKey.length <= 64);
  assert.equal(fake.records[0].record_key.value, released.recordKey);
  assert.equal(fake.records[0].lock_key.value, "");
  assert.equal(fake.records[0].status.value, "SUCCESS");
  const releasePut = fake.calls.find(
    ({ method, body }) => method === "PUT" && body.record.record_key,
  );
  assert.equal(releasePut.body.id, reference.recordId);
  assert.equal(releasePut.body.updateKey, undefined);
  assert.ok(fake.calls.every(({ method }) => method !== "DELETE"));
});

test("network lock: release成功応答消失は$id更新後のtombstone再GETで裁定する", async () => {
  const fake = createLockFake({ loseReleaseResponse: true });
  const lockManager = manager(fake);
  const reference = await lockManager.acquire();
  const released = await lockManager.release(reference);
  assert.equal(released.released, true);
  assert.equal(fake.records[0].record_key.value, released.recordKey);
  assert.equal(reference.revision, 2);
  assert.ok(
    fake.calls.some(
      ({ method, url }) =>
        method === "GET" &&
        url.searchParams.get("query")?.includes(released.recordKey),
    ),
  );
});

test("network lock: release直前の自heartbeatによるrevision競合は再GETして一度だけ再試行する", async () => {
  const fake = createLockFake();
  const lockManager = manager(fake);
  const reference = await lockManager.acquire();
  fake.beforeNextPut(([record]) => {
    record.$revision.value = "2";
    record.revision.value = 2;
  });

  const released = await lockManager.release(reference);

  assert.equal(released.released, true);
  assert.equal(reference.revision, 3);
  assert.equal(reference.businessRevision, 3);
  assert.equal(
    fake.calls.filter(
      ({ method, body }) =>
        method === "PUT" && body.id && body.record.record_key,
    ).length,
    2,
  );
});

test("network lock: release競合後にtokenが他者へ変わっていればfail-closedにする", async () => {
  const fake = createLockFake();
  const lockManager = manager(fake);
  const reference = await lockManager.acquire();
  fake.beforeNextPut(([record]) => {
    record.$revision.value = "2";
    record.revision.value = 2;
    record.lease_token.value = "reclaimed-token";
  });

  await assert.rejects(
    lockManager.release(reference),
    (error) =>
      error instanceof NetworkLockError &&
      error.code === "LEASE_REVISION_CONFLICT",
  );
  assert.equal(fake.records[0].record_key.value, reference.originalRecordKey);
  assert.equal(
    fake.calls.filter(
      ({ method, body }) =>
        method === "PUT" && body.id && body.record.record_key,
    ).length,
    1,
  );
});

test("kintone fake: updateKey指定フィールドを同じPUTで変更すると400にする", async () => {
  const fake = createLockFake();
  const client = new KintoneClient({
    baseUrl: "https://example.cybozu.com",
    appId: 100,
    apiToken: "token",
    fetch: fake.fetch,
  });
  await client.postRecord({ record_key: { value: "before" } });
  await assert.rejects(
    client.putRecord("before", 1, { record_key: { value: "after" } }),
    (error) =>
      error instanceof KintoneApiError &&
      error.status === 400 &&
      error.apiCode === "CB_VA01",
  );
  assert.equal(fake.records[0].record_key.value, "before");
});

function monitorReference() {
  return {
    lockKey: "N1:test",
    recordId: "1",
    originalRecordKey: "LOCK:N1:test",
    leaseToken: "token",
    ownerInvocationId: "invocation",
    leaseDurationSec: 30,
    revision: 1,
    businessRevision: 1,
    heartbeatAt: "2026-08-30T00:00:00.000Z",
    leaseExpiresAt: "2026-08-30T00:00:30.000Z",
  };
}

test("lease monitor: 正常heartbeatを継続しHELDのgateを維持する", async () => {
  let calls = 0;
  const reference = monitorReference();
  const monitor = new LeaseMonitor(
    {
      async heartbeat(value) {
        calls += 1;
        value.leaseExpiresAt = "2026-08-30T00:00:40.000Z";
      },
    },
    reference,
    {
      leaseDurationSec: 30,
      heartbeatIntervalSec: 10,
      now: () => new Date("2026-08-30T00:00:10.000Z"),
    },
  );
  assert.equal(await monitor.tick(), true);
  assert.equal(calls, 1);
  assert.equal(monitor.canStartNewNode(), true);
  assert.equal(monitor.canPersistResults(), true);
});

test("lease monitor: 連続失敗の閾値境界でdrainし再確認成功時だけ最終保存を許す", async () => {
  let attempts = 0;
  const events = [];
  const monitor = new LeaseMonitor(
    {
      async heartbeat() {
        attempts += 1;
        if (attempts <= 2) throw new Error("temporary outage");
      },
    },
    monitorReference(),
    {
      leaseDurationSec: 30,
      heartbeatIntervalSec: 5,
      consecutiveFailureThreshold: 2,
      remainingLeaseSafetySec: 5,
      now: () => new Date("2026-08-30T00:00:10.000Z"),
    },
  );
  monitor.subscribe((event) => events.push(event));
  assert.equal(await monitor.tick(), false);
  assert.equal(monitor.currentState, "HELD");
  assert.equal(await monitor.tick(), false);
  assert.equal(monitor.currentState, "LEASE_UNCERTAIN");
  assert.equal(monitor.canStartNewNode(), false);
  assert.equal(monitor.canPersistResults(), false);
  assert.equal(await monitor.confirmLeaseForFinalWrite(), true);
  assert.equal(monitor.canPersistResults(), true);
  assert.equal(monitor.canStartNewNode(), false);
  assert.equal(monitor.requiresNetworkLeaseInterruptedFinalization(), true);
  assert.deepEqual(
    events.map(({ reason }) => reason),
    ["FAILURE_THRESHOLD", "FINAL_WRITE_CONFIRMED"],
  );
});

test("lease monitor: 残余leaseが安全閾値以下ならdrainし再確認失敗時は全書込み不可", async () => {
  const monitor = new LeaseMonitor(
    {
      async heartbeat() {
        throw new Error("unreachable");
      },
    },
    monitorReference(),
    {
      leaseDurationSec: 30,
      heartbeatIntervalSec: 5,
      consecutiveFailureThreshold: 3,
      remainingLeaseSafetySec: 5,
      now: () => new Date("2026-08-30T00:00:25.000Z"),
    },
  );
  assert.equal(await monitor.tick(), false);
  assert.equal(monitor.currentState, "LEASE_UNCERTAIN");
  assert.equal(await monitor.confirmLeaseForFinalWrite(), false);
  assert.equal(monitor.canPersistResults(), false);
  assert.equal(monitor.requiresNetworkLeaseInterruptedFinalization(), false);
});

test("lease monitor: heartbeat timerを注入して任意の呼出側から駆動・停止できる", async () => {
  let scheduled;
  let cancelled;
  let heartbeats = 0;
  const monitor = new LeaseMonitor(
    {
      async heartbeat() {
        heartbeats += 1;
      },
    },
    monitorReference(),
    {
      leaseDurationSec: 30,
      heartbeatIntervalSec: 5,
      schedule(callback, intervalMs) {
        scheduled = { callback, intervalMs };
        return "fake-timer";
      },
      cancelSchedule(handle) {
        cancelled = handle;
      },
    },
  );
  monitor.start();
  assert.equal(scheduled.intervalMs, 5000);
  scheduled.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heartbeats, 1);
  monitor.stop();
  assert.equal(cancelled, "fake-timer");
});
