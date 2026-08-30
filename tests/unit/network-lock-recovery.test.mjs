import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { runForceUnlockNetworkCommand } from "../../dist/cli/force-unlock-network-command.js";
import { networkLockKey } from "../../dist/domain/canonical-lock-key.js";
import {
  NetworkLockRecoveryError,
  createCloudRunJobExecutionStopConfirmation,
  createLocalPidStopConfirmation,
  defaultStopConfirmations,
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
    status_reason: field("owner_instance_id=local-pid://recovery-host/4242"),
    lease_token: field("lease-token-old"),
    heartbeat_at: field("2026-08-30T00:58:00.000Z"),
    lease_expires_at: field("2026-08-30T00:58:59.000Z"),
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
  truncateDateTimesOnRead = false,
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
        records: records
          .filter((candidate) => candidate.record_key.value === key)
          .map((candidate) => {
            const result = globalThis.structuredClone(candidate);
            if (truncateDateTimesOnRead) {
              for (const [code, value] of Object.entries(result)) {
                if (code.endsWith("_at") && typeof value.value === "string") {
                  value.value = value.value.replace(
                    /:\d{2}(?:\.\d{3})?Z$/,
                    ":00Z",
                  );
                }
              }
            }
            return result;
          }),
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

test("force unlock: 保存上は過去でも切り捨て上限内のleaseはLEASE_STILL_ACTIVE", async () => {
  const fake = createRecoveryFake({
    record: lockRecord({
      lease_expires_at: field("2026-08-30T00:59:01.000Z"),
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

test("force unlock: ownerInstanceIdを停止確認adapterへ渡す", async () => {
  const fake = createRecoveryFake();
  let received;
  const stopConfirmations = new Map([
    [
      "capture",
      {
        async confirm(value) {
          received = value;
          return { confirmed: true, method: "capture", detail: "stopped" };
        },
      },
    ],
  ]);
  await forceUnlockNetwork(
    input({ stopMethod: "capture" }),
    dependencies(fake, repository(), { stopConfirmations }),
  );
  assert.equal(received.ownerInstanceId, "local-pid://recovery-host/4242");
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
  const fake = createRecoveryFake({
    losePutResponse: true,
    truncateDateTimesOnRead: true,
  });
  const repo = repository();
  const result = await forceUnlockNetwork(input(), dependencies(fake, repo));
  assert.equal(result.postReleaseRevision, 8);
  assert.equal(repo.audits.length, 1);
  assert.equal(fake.calls.filter(({ method }) => method === "GET").length, 3);
  assert.equal(fake.records[0].finished_at.value, NOW);
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

function stopInput(ownerInstanceId) {
  return {
    profile: "prod",
    networkId: "monthly",
    expectedOwnerInvocationId: "invoke-old",
    ownerInstanceId,
    stopConfirmedBy: "operator@example.test",
    stopMethod: "local_pid",
    stopEvidenceRef: "runbook://stop-check/1",
  };
}

function processError(code) {
  return Object.assign(new Error(code), { code });
}

test("local_pid: ESRCHだけを停止済みと確認する", async () => {
  const confirmation = createLocalPidStopConfirmation({
    host: "host-a",
    processKill() {
      throw processError("ESRCH");
    },
    now: () => new Date(NOW),
  });
  const result = await confirmation.confirm(
    stopInput("local-pid://host-a/123"),
  );
  assert.equal(result.confirmed, true);
  assert.match(result.detail, /123.*2026-08-30T01:00:00\.000Z.*reuse/i);
});

test("local_pid: 生存プロセスとEPERMを拒否する", async () => {
  const alive = createLocalPidStopConfirmation({
    host: "host-a",
    processKill: () => true,
  });
  assert.equal(
    (await alive.confirm(stopInput("local-pid://host-a/123"))).confirmed,
    false,
  );
  const denied = createLocalPidStopConfirmation({
    host: "host-a",
    processKill() {
      throw processError("EPERM");
    },
  });
  const deniedResult = await denied.confirm(
    stopInput("local-pid://host-a/123"),
  );
  assert.equal(deniedResult.confirmed, false);
  assert.match(deniedResult.detail, /permission/i);
});

test("local_pid: 別ホスト、形式不正、PID不正をfail-closedにする", async () => {
  const confirmation = createLocalPidStopConfirmation({
    host: "host-a",
    processKill: () => {
      throw new Error("must not inspect");
    },
  });
  const otherHost = await confirmation.confirm(
    stopInput("local-pid://host-b/123"),
  );
  assert.equal(otherHost.confirmed, false);
  assert.match(otherHost.detail, /manual recovery/i);
  assert.equal(
    (await confirmation.confirm(stopInput("host-a:123"))).confirmed,
    false,
  );
  for (const pid of ["0", "-1", "abc", "1.5"]) {
    const result = await confirmation.confirm(
      stopInput(`local-pid://host-a/${pid}`),
    );
    assert.equal(result.confirmed, false);
    assert.match(result.detail, /positive safe integer/i);
  }
});

const executionName =
  "projects/project-a/locations/asia-northeast1/jobs/monthly/executions/run-1";

function cloudConfirmation(fetch, gcpAccessToken = "secret-token") {
  return createCloudRunJobExecutionStopConfirmation({
    fetch,
    gcpAccessToken,
  });
}

function cloudResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("cloud_run: success/failure/cancel terminal executionを確認する", async () => {
  for (const state of ["SUCCEEDED", "FAILED", "CANCELLED"]) {
    const confirmation = cloudConfirmation(async (url, init) => {
      assert.equal(url, `https://run.googleapis.com/v2/${executionName}`);
      assert.equal(init.headers.Authorization, "Bearer secret-token");
      return cloudResponse({
        name: executionName,
        state,
        completionTime: NOW,
        taskCount: 1,
        succeededCount: state === "SUCCEEDED" ? 1 : 0,
        failedCount: state === "FAILED" ? 1 : 0,
        cancelledCount: state === "CANCELLED" ? 1 : 0,
      });
    });
    const result = await confirmation.confirm(stopInput(executionName));
    assert.equal(result.confirmed, true);
    assert.match(result.detail, new RegExp(`state=${state}`));
    assert.match(result.detail, /completionTime=.*taskCounts=consistent/);
  }
});

test("cloud_run: RUNNING/PENDING executionを拒否する", async () => {
  for (const state of ["RUNNING", "PENDING"]) {
    const confirmation = cloudConfirmation(async () =>
      cloudResponse({ name: executionName, state }),
    );
    const result = await confirmation.confirm(stopInput(executionName));
    assert.equal(result.confirmed, false);
    assert.match(result.detail, new RegExp(`state=${state}`));
    assert.match(result.detail, /completionTime=unset/);
  }
});

test("cloud_run: completionTimeがあっても未知stateをfail-closedにする", async () => {
  const result = await cloudConfirmation(async () =>
    cloudResponse({
      name: executionName,
      state: "FUTURE_STATE",
      completionTime: NOW,
    }),
  ).confirm(stopInput(executionName));
  assert.equal(result.confirmed, false);
  assert.match(result.detail, /unknown state.*FUTURE_STATE/);
});

test("cloud_run: HTTP失敗、通信失敗、形状不明をfail-closedにする", async () => {
  for (const status of [403, 404, 500]) {
    const result = await cloudConfirmation(async () =>
      cloudResponse({ error: "denied" }, status),
    ).confirm(stopInput(executionName));
    assert.equal(result.confirmed, false);
    assert.match(result.detail, new RegExp(`HTTP ${status}`));
  }
  const transport = await cloudConfirmation(async () => {
    throw new TypeError("offline");
  }).confirm(stopInput(executionName));
  assert.equal(transport.confirmed, false);
  assert.match(transport.detail, /request failed/);
  for (const body of [
    null,
    {},
    { name: "wrong" },
    { name: executionName, completionTime: 123 },
  ]) {
    const result = await cloudConfirmation(async () =>
      cloudResponse(body),
    ).confirm(stopInput(executionName));
    assert.equal(result.confirmed, false);
    assert.match(result.detail, /unknown/i);
  }
});

test("cloud_run: resource形式不正とtoken未設定を拒否しtokenをdetailへ漏らさない", async () => {
  const malformed = await cloudConfirmation(async () => {
    throw new Error("must not fetch");
  }).confirm(stopInput("projects/p/jobs/j/executions/e"));
  assert.equal(malformed.confirmed, false);
  assert.match(malformed.detail, /not a valid/);

  const missingToken = await cloudConfirmation(async () => {
    throw new Error("must not fetch");
  }, "").confirm(stopInput(executionName));
  assert.equal(missingToken.confirmed, false);

  const secret = "very-sensitive-token";
  const denied = await cloudConfirmation(
    async () => cloudResponse({ error: secret }, 403),
    secret,
  ).confirm(stopInput(executionName));
  assert.equal(denied.detail.includes(secret), false);
});

test("default stop confirmationsはmanualと自動adapterを登録する", () => {
  assert.deepEqual(
    [...defaultStopConfirmations({ host: "host-a" }).keys()],
    ["manual", "local_pid", "cloud_run_job_execution"],
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
