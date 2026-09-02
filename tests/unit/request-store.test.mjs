import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  KintoneRequestStore,
  MAX_REQUEST_FETCH_LIMIT,
} from "../../dist/requests/kintone-request-store.js";
import {
  parseRequestRecord,
  RequestValidationError,
  REQUEST_VALUE_LIMITS,
} from "../../dist/requests/request-model.js";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function rawRecord(overrides = {}) {
  const values = {
    $id: "42",
    $revision: "3",
    作成者: { code: "operator@example.test", name: "Operator" },
    作成日時: "2026-08-31T01:02:03Z",
    request_type: "RERUN",
    run_id: "run_42",
    rerun_from_node: "",
    reason: "retry after investigation",
    request_state: "REQUESTED",
    claimed_at: "",
    claimed_host: "",
    claim_heartbeat_at: "",
    result_code: "",
    result_message: "",
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value }]),
  );
}

function acceptedRecord(overrides = {}) {
  return rawRecord({
    request_state: "ACCEPTED",
    claimed_at: "2026-08-31T01:03:00Z",
    claimed_host: "poller-a",
    claim_heartbeat_at: "2026-08-31T01:03:00Z",
    ...overrides,
  });
}

function store(fetch, fetchLimit) {
  return new KintoneRequestStore({
    baseUrl: "https://example.cybozu.com",
    appId: 123,
    apiToken: "test-token",
    fetch,
    ...(fetchLimit === undefined ? {} : { fetchLimit }),
  });
}

test("要求recordは$id/$revision/作成者/作成日時を含めてparseする", () => {
  const parsed = parseRequestRecord(rawRecord());
  assert.equal(parsed.id, "42");
  assert.equal(parsed.revision, 3);
  assert.equal(parsed.creatorCode, "operator@example.test");
  assert.equal(parsed.createdAt, "2026-08-31T01:02:03Z");
  assert.equal(parsed.rerunFromNode, null);
  assert.equal(parsed.networkId, null);
  assert.equal(parsed.businessKey, null);
  assert.equal(parsed.scheduledFor, null);
});

test("START recordは空run_idと新3欄をM2向けにparseする", () => {
  const parsed = parseRequestRecord(
    rawRecord({
      request_type: "START",
      run_id: "",
      network_id: "monthly_jobs",
      business_key: "monthly_jobs@2026-08-correction-1",
      scheduled_for: "2026-08-31T15:00:00Z",
    }),
  );
  assert.equal(parsed.requestType, "START");
  assert.equal(parsed.runId, "");
  assert.equal(parsed.networkId, "monthly_jobs");
  assert.equal(parsed.businessKey, "monthly_jobs@2026-08-correction-1");
  assert.equal(parsed.scheduledFor, "2026-08-31T15:00:00Z");
});

test("STARTのpolicy依存入力は意味判定せずM2へ渡す", () => {
  const parsed = parseRequestRecord(
    rawRecord({
      request_type: "START",
      run_id: "unexpected-run-id",
      network_id: "",
      business_key: "",
      scheduled_for: "not-a-timestamp",
    }),
  );
  assert.equal(parsed.runId, "unexpected-run-id");
  assert.equal(parsed.networkId, null);
  assert.equal(parsed.businessKey, null);
  assert.equal(parsed.scheduledFor, "not-a-timestamp");
});

test("新3欄の型と文字列長をfail-closedにする", () => {
  for (const record of [
    rawRecord({ request_type: "START", run_id: "", network_id: 42 }),
    rawRecord({ request_type: "START", run_id: "", business_key: [] }),
    rawRecord({ request_type: "START", run_id: "", scheduled_for: {} }),
    rawRecord({
      request_type: "START",
      run_id: "",
      network_id: "x".repeat(REQUEST_VALUE_LIMITS.networkId + 1),
    }),
    rawRecord({
      request_type: "START",
      run_id: "",
      business_key: "😀".repeat(REQUEST_VALUE_LIMITS.businessKey + 1),
    }),
  ]) {
    assert.throws(() => parseRequestRecord(record), RequestValidationError);
  }
});

test("既存3種は新欄なしfixtureでもrun_id必須を維持する", () => {
  for (const requestType of ["RERUN", "STOP", "RELEASE"]) {
    assert.equal(
      parseRequestRecord(rawRecord({ request_type: requestType })).requestType,
      requestType,
    );
    assert.throws(
      () =>
        parseRequestRecord(
          rawRecord({ request_type: requestType, run_id: " \t" }),
        ),
      RequestValidationError,
    );
  }
});

test("STARTでも機械所有欄の状態規則を維持する", () => {
  assert.throws(
    () =>
      parseRequestRecord(
        rawRecord({
          request_type: "START",
          run_id: "",
          claimed_host: "unexpected",
        }),
      ),
    RequestValidationError,
  );
  assert.throws(
    () =>
      parseRequestRecord(
        rawRecord({
          request_type: "START",
          run_id: "",
          request_state: "DONE",
        }),
      ),
    RequestValidationError,
  );
});

test("未知選択肢、空reason、不正field組合せをfail-closedにする", () => {
  for (const record of [
    rawRecord({ request_type: "DELETE" }),
    rawRecord({ request_state: "PENDING" }),
    rawRecord({ reason: " \t" }),
    rawRecord({ request_type: "STOP", rerun_from_node: "n2" }),
    rawRecord({ claimed_host: "unexpected" }),
  ]) {
    assert.throws(() => parseRequestRecord(record), RequestValidationError);
  }
});

test("run_id/creator/resultの過長値をfail-closedにする", () => {
  assert.throws(
    () =>
      parseRequestRecord(
        rawRecord({ run_id: "x".repeat(REQUEST_VALUE_LIMITS.runId + 1) }),
      ),
    RequestValidationError,
  );
  assert.throws(
    () =>
      parseRequestRecord(
        rawRecord({
          作成者: {
            code: "x".repeat(REQUEST_VALUE_LIMITS.creatorCode + 1),
            name: "x",
          },
        }),
      ),
    RequestValidationError,
  );
  assert.throws(
    () =>
      parseRequestRecord(
        acceptedRecord({
          request_state: "DONE",
          result_code: "x".repeat(REQUEST_VALUE_LIMITS.resultCode + 1),
          result_message: "done",
        }),
      ),
    RequestValidationError,
  );
});

test("REQUESTED取得は作成日時asc,$id ascと上限を固定する", async () => {
  const calls = [];
  const requests = store(async (input, init) => {
    calls.push({ url: new URL(input), init });
    return response({ records: [rawRecord()] });
  }, 17);
  const found = await requests.listRequested();
  assert.equal(found.valid.length, 1);
  assert.deepEqual(found.invalid, []);
  assert.equal(found.skipped, 0);
  assert.equal(
    calls[0].url.searchParams.get("query"),
    'request_state in ("REQUESTED") order by 作成日時 asc, $id asc limit 17',
  );
  assert.throws(() => store(async () => response({}), 0), RangeError);
  assert.throws(
    () => store(async () => response({}), MAX_REQUEST_FETCH_LIMIT + 1),
    RangeError,
  );
});

test("REQUESTED取得は不正recordを識別可能/不能に分離する", async () => {
  const requests = store(async () =>
    response({
      records: [
        rawRecord(),
        rawRecord({ $id: "43", reason: " " }),
        rawRecord({ $id: "", $revision: "", reason: " " }),
      ],
    }),
  );
  const found = await requests.listRequested();
  assert.deepEqual(
    found.valid.map(({ id }) => id),
    ["42"],
  );
  assert.equal(found.invalid.length, 1);
  assert.equal(found.invalid[0].id, "43");
  assert.match(
    found.invalid[0].issues.map(({ code }) => code).join(","),
    /REQUIRED/,
  );
  assert.equal(found.skipped, 1);
});

test("識別可能な不正要求はrevision指定で直接REJECTEDにする", async () => {
  let body;
  const requests = store(async (_input, init) => {
    body = JSON.parse(init.body);
    return response({ revision: "4" });
  });
  await requests.rejectInvalid(
    { id: "43", revision: 3 },
    { state: "REJECTED", code: "REQUEST_INVALID", message: "invalid fields" },
  );
  assert.equal(body.id, "43");
  assert.equal(body.revision, 3);
  assert.equal(body.record.request_state.value, "REJECTED");
});

test("REQUESTED取得失敗は書込みへ進まずそのまま失敗する", async () => {
  const methods = [];
  const requests = store(async (_input, init) => {
    methods.push(init.method);
    return response({ code: "GAIA_TM12" }, 503);
  });
  await assert.rejects(requests.listRequested());
  assert.deepEqual(methods, ["GET"]);
});

test("claimはrecord IDとrevisionを使いACCEPTEDとclaimed_*を記録する", async () => {
  let body;
  const requests = store(async (_input, init) => {
    body = JSON.parse(init.body);
    return response({ revision: "4" });
  });
  const claimed = await requests.claim(
    parseRequestRecord(rawRecord()),
    "poller-a",
    "2026-08-31T01:03:00Z",
  );
  assert.equal(body.id, "42");
  assert.equal(body.revision, 3);
  assert.deepEqual(body.record, {
    request_state: { value: "ACCEPTED" },
    claimed_at: { value: "2026-08-31T01:03:00Z" },
    claimed_host: { value: "poller-a" },
    claim_heartbeat_at: { value: "2026-08-31T01:03:00Z" },
  });
  assert.equal(claimed.revision, 4);
  assert.equal(claimed.requestState, "ACCEPTED");
});

test("claim revision競合は多重pollerの敗者としてskipする", async () => {
  const requests = store(async () =>
    response({ code: "GAIA_CO02", message: "conflict" }, 409),
  );
  assert.equal(
    await requests.claim(
      parseRequestRecord(rawRecord()),
      "poller-b",
      "2026-08-31T01:03:00Z",
    ),
    null,
  );
});

test("heartbeatはACCEPTEDのrevision付きでclaim_heartbeat_atだけを更新する", async () => {
  let body;
  const requests = store(async (_input, init) => {
    body = JSON.parse(init.body);
    return response({ revision: "4" });
  });
  const updated = await requests.heartbeat(
    parseRequestRecord(acceptedRecord()),
    "2026-08-31T01:04:00Z",
  );
  assert.deepEqual(body.record, {
    claim_heartbeat_at: { value: "2026-08-31T01:04:00Z" },
  });
  assert.equal(updated.revision, 4);
});

test("結果競合は再GET後に新revisionで1回だけ再適用する", async () => {
  const calls = [];
  let putCount = 0;
  const requests = store(async (input, init) => {
    const method = init.method;
    calls.push({
      method,
      url: new URL(input),
      body: init.body && JSON.parse(init.body),
    });
    if (method === "GET")
      return response({ records: [acceptedRecord({ $revision: "4" })] });
    putCount += 1;
    if (putCount === 1) return response({ code: "GAIA_DA02" }, 400);
    return response({ revision: "5" });
  });
  const result = await requests.writeResult(
    parseRequestRecord(acceptedRecord()),
    {
      state: "DONE",
      code: "OK",
      message: "invocation invoke_1",
    },
  );
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["PUT", "GET", "PUT"],
  );
  assert.equal(calls[2].body.revision, 4);
  assert.equal(result.revision, 5);
  assert.equal(result.requestState, "DONE");
});

test("再GETで同一終端値なら再PUTせず成功扱いにする", async () => {
  const methods = [];
  const requests = store(async (_input, init) => {
    methods.push(init.method);
    if (init.method === "PUT") return response({ code: "GAIA_CO02" }, 409);
    return response({
      records: [
        acceptedRecord({
          $revision: "4",
          request_state: "REJECTED",
          result_code: "RUN_NOT_FOUND",
          result_message: "run was not found",
        }),
      ],
    });
  });
  const result = await requests.writeResult(
    parseRequestRecord(acceptedRecord()),
    {
      state: "REJECTED",
      code: "RUN_NOT_FOUND",
      message: "run was not found",
    },
  );
  assert.deepEqual(methods, ["PUT", "GET"]);
  assert.equal(result.revision, 4);
});

test("結果の再適用も競合した場合は3回目を試みず失敗する", async () => {
  const methods = [];
  const requests = store(async (_input, init) => {
    methods.push(init.method);
    if (init.method === "GET") {
      return response({ records: [acceptedRecord({ $revision: "4" })] });
    }
    return response({ code: "GAIA_CO02" }, 409);
  });
  await assert.rejects(
    requests.writeResult(parseRequestRecord(acceptedRecord()), {
      state: "DONE",
      code: "OK",
      message: "done",
    }),
  );
  assert.deepEqual(methods, ["PUT", "GET", "PUT"]);
});

test("過長claimed_host/resultはAPI呼出前に拒否する", async () => {
  let calls = 0;
  const requests = store(async () => {
    calls += 1;
    return response({ revision: "4" });
  });
  await assert.rejects(
    requests.claim(
      parseRequestRecord(rawRecord()),
      "x".repeat(REQUEST_VALUE_LIMITS.claimedHost + 1),
      "2026-08-31T01:03:00Z",
    ),
    RequestValidationError,
  );
  await assert.rejects(
    requests.writeResult(parseRequestRecord(acceptedRecord()), {
      state: "DONE",
      code: "x".repeat(REQUEST_VALUE_LIMITS.resultCode + 1),
      message: "done",
    }),
    RequestValidationError,
  );
  assert.equal(calls, 0);
});
