import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { runForceUnlockNetworkCommand } from "../../dist/cli/force-unlock-network-command.js";
import { networkLockKey } from "../../dist/domain/canonical-lock-key.js";
import {
  NetworkLockRecoveryError,
  forceUnlockNetwork,
} from "../../dist/persistence/network-lock-recovery.js";

const NOW = "2026-08-30T01:00:00.000Z";

function field(value) {
  return { value };
}

function lockRecord(overrides = {}) {
  const lockKey = networkLockKey("prod", "monthly");
  return {
    $id: field("1001"),
    $revision: field("7"),
    record_key: field(`LOCK:${lockKey}`),
    record_type: field("NETWORK_LOCK"),
    lock_key: field(lockKey),
    profile: field("prod"),
    owner_invocation_id: field("invoke-old"),
    lease_token: field("lease-token-old"),
    heartbeat_at: field("2026-08-30T00:58:00.000Z"),
    lease_expires_at: field("2026-08-30T00:59:00.000Z"),
    status: field("RUNNING"),
    revision: field(4),
    ...overrides,
  };
}

function createRecoveryFake({
  record = lockRecord(),
  putConflict = false,
  losePutResponse = false,
  applyLostPut = true,
} = {}) {
  const records = record === null ? [] : [record];
  const calls = [];
  const response = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetch = async (input, init) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, body });
    if (init.method === "GET") {
      const key = /record_key in \("(.+)"\)/.exec(
        url.searchParams.get("query"),
      )?.[1];
      return response({
        records: records.filter(
          (candidate) => candidate.record_key.value === key,
        ),
      });
    }
    if (init.method === "PUT") {
      if (putConflict) return response({ code: "GAIA_CO02" }, 409);
      const current = records.find(
        (candidate) => candidate.$id.value === String(body.id),
      );
      if (!current) return response({ code: "GAIA_RE20" }, 404);
      if (Number(current.$revision.value) !== body.revision)
        return response({ code: "GAIA_CO02" }, 409);
      if (!losePutResponse || applyLostPut) {
        Object.assign(current, body.record, {
          $revision: field(String(Number(current.$revision.value) + 1)),
        });
      }
      if (losePutResponse) throw new TypeError("synthetic response loss");
      return response({ revision: current.$revision.value });
    }
    throw new Error(`unexpected ${init.method}`);
  };
  return { fetch, records, calls };
}

function repository() {
  const audits = [];
  return {
    audits,
    async appendOperationAudit(value) {
      audits.push(globalThis.structuredClone(value));
      return { value, revision: 1 };
    },
  };
}

function input(overrides = {}) {
  return {
    networkId: "monthly",
    profile: "prod",
    expectedOwnerInvocationId: "invoke-old",
    reason: "owner process was inspected and confirmed stopped",
    evidenceRef: "incident://fn-13/1",
    stopConfirmedBy: "operator@example.test",
    stopEvidenceRef: "runbook://stop-check/1",
    stopMethod: "manual",
    servicePrincipal: "svc-flownet",
    requestedBy: "requester@example.test",
    ...overrides,
  };
}

function dependencies(fake, repo = repository(), overrides = {}) {
  return {
    baseUrl: "https://example.cybozu.com",
    stateAppId: 100,
    stateApiToken: "state-token",
    repository: repo,
    fetch: fake.fetch,
    now: () => new Date(NOW),
    uuid: () => "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof NetworkLockRecoveryError && error.code === code,
  );
}

test("force unlock: stale lockをtombstone化し成功時だけ監査を1件記録する", async () => {
  const fake = createRecoveryFake();
  const repo = repository();
  const result = await forceUnlockNetwork(input(), dependencies(fake, repo));
  assert.equal(result.postReleaseRevision, 8);
  assert.equal(fake.records[0].status.value, "CANCELLED");
  assert.equal(
    fake.records[0].status_reason.value,
    "NETWORK_LOCK_FORCE_RELEASED",
  );
  assert.match(fake.records[0].record_key.value, /^LOCKDONE:/);
  assert.equal(repo.audits.length, 1);
  assert.deepEqual(repo.audits[0], result.audit);
  assert.equal(
    result.audit.event_id,
    "net_unlock_11111111-1111-4111-8111-111111111111",
  );
  assert.equal(result.audit.previous_lease_token, "lease-token-old");
  assert.equal(result.audit.post_release_revision, 8);
});

test("force unlock: lockなしはLOCK_NOT_FOUNDで書込みも監査もしない", async () => {
  const fake = createRecoveryFake({ record: null });
  const repo = repository();
  await rejectsWithCode(
    forceUnlockNetwork(input(), dependencies(fake, repo)),
    "LOCK_NOT_FOUND",
  );
  assert.equal(
    fake.calls.some(({ method }) => method === "PUT"),
    false,
  );
  assert.equal(repo.audits.length, 0);
});

test("force unlock: expected owner不一致はOWNER_MISMATCH", async () => {
  const fake = createRecoveryFake();
  await rejectsWithCode(
    forceUnlockNetwork(
      input({ expectedOwnerInvocationId: "invoke-other" }),
      dependencies(fake),
    ),
    "OWNER_MISMATCH",
  );
});

test("force unlock: 生存中leaseはLEASE_STILL_ACTIVE", async () => {
  const fake = createRecoveryFake({
    record: lockRecord({
      lease_expires_at: field("2026-08-30T01:00:01.000Z"),
    }),
  });
  await rejectsWithCode(
    forceUnlockNetwork(input(), dependencies(fake)),
    "LEASE_STILL_ACTIVE",
  );
});

test("force unlock: adapterが否定した停止証拠はSTOP_NOT_CONFIRMED", async () => {
  const fake = createRecoveryFake();
  const stopConfirmations = new Map([
    [
      "manual",
      {
        async confirm() {
          return { confirmed: false, method: "manual", detail: "still alive" };
        },
      },
    ],
  ]);
  await rejectsWithCode(
    forceUnlockNetwork(
      input(),
      dependencies(fake, repository(), { stopConfirmations }),
    ),
    "STOP_NOT_CONFIRMED",
  );
});

test("force unlock: 停止確認中のrevision前進はHEARTBEAT_ADVANCED", async () => {
  const fake = createRecoveryFake();
  const stopConfirmations = new Map([
    [
      "manual",
      {
        async confirm() {
          fake.records[0].$revision.value = "8";
          fake.records[0].heartbeat_at.value = "2026-08-30T01:00:00.000Z";
          return { confirmed: true, method: "manual", detail: "stopped" };
        },
      },
    ],
  ]);
  await rejectsWithCode(
    forceUnlockNetwork(
      input(),
      dependencies(fake, repository(), { stopConfirmations }),
    ),
    "HEARTBEAT_ADVANCED",
  );
});

test("force unlock: release PUTのGAIA_CO02はREVISION_CONFLICT", async () => {
  const fake = createRecoveryFake({ putConflict: true });
  const repo = repository();
  await rejectsWithCode(
    forceUnlockNetwork(input(), dependencies(fake, repo)),
    "REVISION_CONFLICT",
  );
  assert.equal(repo.audits.length, 0);
});

test("force unlock: PUT応答消失後にtombstoneを再GETできれば成功", async () => {
  const fake = createRecoveryFake({ losePutResponse: true });
  const repo = repository();
  const result = await forceUnlockNetwork(input(), dependencies(fake, repo));
  assert.equal(result.postReleaseRevision, 8);
  assert.equal(repo.audits.length, 1);
  assert.equal(fake.calls.filter(({ method }) => method === "GET").length, 3);
});

test("force unlock: PUT応答消失後にtombstoneを確認できなければRELEASE_UNCONFIRMED", async () => {
  const fake = createRecoveryFake({
    losePutResponse: true,
    applyLostPut: false,
  });
  const repo = repository();
  await rejectsWithCode(
    forceUnlockNetwork(input(), dependencies(fake, repo)),
    "RELEASE_UNCONFIRMED",
  );
  assert.equal(repo.audits.length, 0);
});

test("force unlock: 未登録stop-methodはfail-closed", async () => {
  const fake = createRecoveryFake();
  await rejectsWithCode(
    forceUnlockNetwork(input({ stopMethod: "local_pid" }), dependencies(fake)),
    "STOP_NOT_CONFIRMED",
  );
});

test("force-unlock-network CLI: 必須欠落と未知optionを拒否する", async (context) => {
  const errors = [];
  context.mock.method(process.stderr, "write", (value) => {
    errors.push(value);
    return true;
  });
  assert.equal(await runForceUnlockNetworkCommand(["monthly"]), 1);
  assert.match(errors.at(-1), /--profile is required/);
  assert.equal(
    await runForceUnlockNetworkCommand([
      "monthly",
      "--profile",
      "prod",
      "--expected-owner-invocation-id",
      "invoke-old",
      "--reason-file",
      "reason.txt",
      "--evidence-ref",
      "incident://1",
      "--stop-confirmed-by",
      "operator",
      "--stop-evidence-ref",
      "stop://1",
      "--stop-method",
      "manual",
      "--unsupported",
      "value",
    ]),
    1,
  );
  assert.match(errors.at(-1), /unknown option '--unsupported'/);
});

test("force-unlock-network CLI: reason fileと主体を回収処理へ渡し案内を出す", async (context) => {
  const fake = createRecoveryFake();
  const repo = repository();
  const output = [];
  context.mock.method(process.stdout, "write", (value) => {
    output.push(value);
    return true;
  });
  assert.equal(
    await runForceUnlockNetworkCommand(
      [
        "monthly",
        "--profile",
        "prod",
        "--expected-owner-invocation-id",
        "invoke-old",
        "--reason-file",
        "reason.txt",
        "--evidence-ref",
        "incident://1",
        "--stop-confirmed-by",
        "operator",
        "--stop-evidence-ref",
        "stop://1",
        "--stop-method",
        "manual",
      ],
      {
        ...dependencies(fake, repo),
        servicePrincipal: "svc",
        requestedBy: "requester",
        readFile: () => "reason from file",
      },
    ),
    0,
  );
  assert.match(output[0], /^RELEASED: N1:/);
  assert.match(output[1], /resolve-node.*UNKNOWN.*resume/);
  assert.equal(repo.audits[0].reason, "reason from file");
  assert.equal(repo.audits[0].service_principal, "svc");
  assert.equal(repo.audits[0].requested_by, "requester");
});
