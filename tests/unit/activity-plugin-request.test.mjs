import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreateRequestBody,
  buildCancelRequestedBody,
  createRequest,
  guardPendingRequest,
  loadPendingStartRequests,
  loadPendingRequests,
  loadTerminalStartRequests,
  PENDING_MAX_FINAL_QUERY_LENGTH,
  PENDING_REQUEST_FIELDS,
  putCancelRequested,
  RequestPostError,
  START_TERMINAL_QUERY,
} from "../../dist/plugin/request-client.js";
import { createKintonePutCancelRequested } from "../../dist/plugin/desktop.js";

const field = (value) => ({ value });
const pending = (id, runId, state = "REQUESTED") => ({
  $id: field(String(id)),
  $revision: field("7"),
  run_id: field(runId),
  network_id: field(""),
  business_key: field(""),
  scheduled_for: field(""),
  request_type: field("RERUN"),
  request_state: field(state),
  作成者: field({ code: "operator@example.test", name: "運用担当" }),
  reason: field("operator reason"),
  cancel_requested: field([]),
});
const pendingStart = (id, overrides = {}) => ({
  $id: field(String(id)),
  $revision: field("8"),
  request_type: field("START"),
  request_state: field("REQUESTED"),
  network_id: field("monthly"),
  business_key: field("monthly@2026-09"),
  scheduled_for: field("2026-09-01T01:23:00Z"),
  reason: field("operator reason"),
  作成者: field({ code: "operator@example.test", name: "運用担当" }),
  作成日時: field("2026-09-01T00:00:00Z"),
  cancel_requested: field([]),
  ...overrides,
});

test("4 Run request types use only the fixed human-owned POST fields", () => {
  const rerun = buildCreateRequestBody("request-app", {
    requestType: "RERUN",
    runId: "run_1",
    reason: "retry safely",
    rerunFromNode: "node_2",
  });
  assert.deepEqual(rerun, {
    app: "request-app",
    record: {
      request_type: field("RERUN"),
      run_id: field("run_1"),
      reason: field("retry safely"),
      rerun_from_node: field("node_2"),
    },
  });
  for (const requestType of ["STOP", "RELEASE", "CLOSE"]) {
    const body = buildCreateRequestBody(300, {
      requestType,
      runId: "run_1",
      reason: "operator reason",
    });
    assert.deepEqual(Object.keys(body.record), [
      "request_type",
      "run_id",
      "reason",
    ]);
  }
  for (const forbidden of [
    "request_state",
    "claimed_at",
    "claimed_host",
    "claim_heartbeat_at",
    "result_code",
    "result_message",
    "作成者",
  ]) {
    assert.equal(Object.hasOwn(rerun.record, forbidden), false, forbidden);
  }
  assert.throws(
    () =>
      buildCreateRequestBody(1, {
        requestType: "STOP",
        runId: "run",
        reason: "reason",
        rerunFromNode: "node",
      }),
    /only allowed for RERUN/u,
  );
});

test("request values enforce blank and Unicode character limits", () => {
  assert.throws(
    () =>
      buildCreateRequestBody(1, {
        requestType: "STOP",
        runId: " ",
        reason: "reason",
      }),
    /blank/u,
  );
  assert.doesNotThrow(() =>
    buildCreateRequestBody(1, {
      requestType: "RERUN",
      runId: "😀".repeat(128),
      reason: "r",
    }),
  );
  assert.throws(
    () =>
      buildCreateRequestBody(1, {
        requestType: "RERUN",
        runId: "😀".repeat(129),
        reason: "r",
      }),
    /value limit/u,
  );
});

test("pending GET covers REQUESTED/ACCEPTED, chunks, escapes and final query limit", async () => {
  const runIds = [
    ...Array.from({ length: 100 }, (_, index) => `run_${index}`),
    'attack"\\value',
  ];
  const queries = [];
  const result = await loadPendingRequests(
    async (request) => {
      queries.push(request.query);
      return { records: [] };
    },
    400,
    runIds,
  );
  assert.equal(result.state, "ready");
  assert.equal(queries.length, 2, "100 values per chunk");
  for (const query of queries) {
    assert.match(
      query,
      /^\(request_state in \("REQUESTED", "ACCEPTED"\)\) and run_id in/u,
    );
    assert.match(query, /order by \$id asc limit 500$/u);
    assert.ok(query.length <= PENDING_MAX_FINAL_QUERY_LENGTH, query.length);
  }
  assert.ok(queries.some((query) => query.includes('attack\\"\\\\value')));
});

test("pending records page at 500 and preserves every request in ID order", async () => {
  let calls = 0;
  const result = await guardPendingRequest(
    async (request) => {
      calls += 1;
      if (!request.query.includes("$id >")) {
        return {
          records: Array.from({ length: 500 }, (_, index) =>
            pending(
              index + 2,
              "run_1",
              index % 2 === 0 ? "REQUESTED" : "ACCEPTED",
            ),
          ),
        };
      }
      return { records: [pending(1_000, "run_1", "ACCEPTED")] };
    },
    1,
    "run_1",
  );
  assert.equal(calls, 2);
  assert.equal(result.state, "ready");
  const requests = result.byRunId.get("run_1");
  assert.equal(requests.length, 501);
  assert.equal(requests[0].id, "2");
  assert.equal(requests.at(-1).id, "1000");
  assert.deepEqual(requests[0], {
    id: "2",
    revision: "7",
    requestType: "RERUN",
    requestState: "REQUESTED",
    creatorCode: "operator@example.test",
    reason: "operator reason",
    target: { runId: "run_1" },
    cancelRequested: false,
  });
});

test("any pending chunk failure discards all partial results and fails open", async () => {
  let calls = 0;
  const result = await loadPendingRequests(
    async () => {
      calls += 1;
      if (calls === 2)
        throw Object.assign(new Error("forbidden"), { status: 403 });
      return { records: [pending(10, "a".repeat(600))] };
    },
    1,
    ["a".repeat(600), "b".repeat(600)],
  );
  assert.equal(calls, 2);
  assert.equal(result.state, "unavailable");
  assert.equal(result.byRunId.size, 0);
  assert.match(result.warning, /重複確認ができませんでした/u);
  assert.doesNotMatch(result.warning, /追加権限/u);

  const outside = await loadPendingRequests(
    async () => ({ records: [pending(20, "outside")] }),
    1,
    ["target"],
  );
  assert.equal(outside.state, "unavailable");
  assert.equal(outside.byRunId.size, 0);
});

test("pending START uses the common request-unit model", async () => {
  const gets = [];
  const result = await loadPendingStartRequests(async (request) => {
    gets.push(request);
    return {
      records: [
        pendingStart(41),
        pendingStart(42, {
          request_state: field("ACCEPTED"),
          business_key: field(""),
          scheduled_for: field(""),
          作成者: field({ code: "second@example.test", name: "第二担当" }),
          作成日時: field("2026-09-01T02:34:00Z"),
        }),
      ],
    };
  }, 300);
  assert.equal(result.state, "ready");
  assert.equal(result.summary.count, 2, "existing count contract");
  assert.equal(result.summary.oldestId, "41", "existing oldestId contract");
  assert.deepEqual(result.summary.requests, [
    {
      id: "41",
      revision: "8",
      requestType: "START",
      requestState: "REQUESTED",
      target: {
        networkId: "monthly",
        businessKey: "monthly@2026-09",
        scheduledFor: "2026-09-01T01:23:00Z",
      },
      reason: "operator reason",
      creatorCode: "operator@example.test",
      cancelRequested: false,
    },
    {
      id: "42",
      revision: "8",
      requestType: "START",
      requestState: "ACCEPTED",
      target: { networkId: "monthly", businessKey: null, scheduledFor: null },
      reason: "operator reason",
      creatorCode: "second@example.test",
      cancelRequested: false,
    },
  ]);
  assert.deepEqual(gets[0].fields, [
    "$id",
    "$revision",
    "request_type",
    "request_state",
    "network_id",
    "business_key",
    "scheduled_for",
    "reason",
    "作成者",
    "cancel_requested",
  ]);
});

test("cancel PUT is one fixed single-record call with revision and one checkbox field", async () => {
  const calls = [];
  await putCancelRequested(
    async (body) => {
      calls.push(body);
      return { revision: "8" };
    },
    300,
    "41",
    "7",
  );
  assert.deepEqual(calls, [
    {
      app: 300,
      id: "41",
      revision: "7",
      record: { cancel_requested: { value: ["取消"] } },
    },
  ]);
  assert.deepEqual(buildCancelRequestedBody(300, "41", "7"), calls[0]);
  assert.deepEqual(Object.keys(calls[0].record), ["cancel_requested"]);
  assert.throws(() => buildCancelRequestedBody(300, "41", ""), /revision/u);

  const runtimeCalls = [];
  const api = async (url, method, body) => {
    runtimeCalls.push({ url, method, body });
    return {};
  };
  api.url = (path) => path;
  const runtimePut = createKintonePutCancelRequested({ api });
  await runtimePut(300, "41", "7");
  assert.equal(runtimeCalls.length, 1);
  assert.equal(runtimeCalls[0].method, "PUT");
  assert.equal(runtimeCalls[0].url, "/k/v1/record.json");
  assert.deepEqual(runtimeCalls[0].body, calls[0]);
  assert.equal(Object.hasOwn(runtimePut, "delete"), false);
});

test("pending fields include cancellation identity and START histories exclude CANCELLED", () => {
  for (const required of [
    "$revision",
    "作成者",
    "request_type",
    "reason",
    "cancel_requested",
  ]) {
    assert.ok(PENDING_REQUEST_FIELDS.includes(required), required);
  }
  assert.doesNotMatch(START_TERMINAL_QUERY, /CANCELLED/u);
});

test("terminal START GET is limited newest-first and parses result fields", async () => {
  const gets = [];
  const result = await loadTerminalStartRequests(async (request) => {
    gets.push(request);
    return {
      records: [
        pendingStart(52, {
          request_state: field("REJECTED"),
          result_code: field("NETWORK_NOT_ALLOWED"),
          result_message: field("許可対象外です"),
        }),
        pendingStart(51, {
          request_state: field("DONE"),
          result_code: field("OK"),
          result_message: field(""),
        }),
      ],
    };
  }, 300);
  assert.equal(result.state, "ready");
  assert.match(
    gets[0].query,
    /request_state in \("DONE", "REJECTED"\) order by \$id desc limit 10$/u,
  );
  assert.ok(gets[0].fields.includes("result_code"));
  assert.ok(gets[0].fields.includes("result_message"));
  assert.deepEqual(
    result.requests.map(({ id, requestState, resultCode, resultMessage }) => ({
      id,
      requestState,
      resultCode,
      resultMessage,
    })),
    [
      {
        id: "52",
        requestState: "REJECTED",
        resultCode: "NETWORK_NOT_ALLOWED",
        resultMessage: "許可対象外です",
      },
      {
        id: "51",
        requestState: "DONE",
        resultCode: "OK",
        resultMessage: null,
      },
    ],
  );
});

function readbackRecord(type = "RERUN") {
  return {
    $id: field("88"),
    $revision: field("1"),
    作成者: field({ code: "operator@example.test" }),
    作成日時: field("2026-09-01T01:00:00Z"),
    request_type: field(type),
    run_id: field("run_88"),
    rerun_from_node: field(type === "RERUN" ? "node_2" : ""),
    reason: field("operator reason"),
    request_state: field("REQUESTED"),
    claimed_at: field(""),
    claimed_host: field(""),
    claim_heartbeat_at: field(""),
    result_code: field(""),
    result_message: field(""),
  };
}

test("POST occurs once, then GET readback passes parseRequestRecord", async () => {
  const posts = [];
  const gets = [];
  const parsed = await createRequest(
    {
      requestAppId: 500,
      postRecord: async (body) => {
        posts.push(body);
        return { id: "88", revision: "1" };
      },
      fetchRecords: async (request) => {
        gets.push(request);
        return { records: [readbackRecord()] };
      },
    },
    {
      requestType: "RERUN",
      runId: "run_88",
      reason: "operator reason",
      rerunFromNode: "node_2",
    },
  );
  assert.equal(posts.length, 1);
  assert.equal(gets.length, 1);
  assert.equal(gets[0].query, "$id = 88 limit 1");
  assert.equal(parsed.id, "88");
  assert.equal(parsed.requestState, "REQUESTED");
});

test("START posts only its five human fields once and validates canonical readback", async () => {
  const posts = [];
  const parsed = await createRequest(
    {
      requestAppId: 500,
      postRecord: async (body) => {
        posts.push(body);
        return { id: "89", revision: "1" };
      },
      fetchRecords: async () => ({
        records: [
          {
            ...readbackRecord("START"),
            $id: field("89"),
            run_id: field(""),
            network_id: field("monthly"),
            business_key: field("monthly@2026-08-correction-1"),
            scheduled_for: field("2026-08-31T15:00:00Z"),
            rerun_from_node: field(""),
          },
        ],
      }),
    },
    {
      requestType: "START",
      networkId: "monthly",
      businessKey: "monthly@2026-08-correction-1",
      scheduledFor: "2026-08-31T15:00:00Z",
      reason: "operator reason",
    },
  );
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], {
    app: 500,
    record: {
      request_type: field("START"),
      network_id: field("monthly"),
      business_key: field("monthly@2026-08-correction-1"),
      scheduled_for: field("2026-08-31T15:00:00Z"),
      reason: field("operator reason"),
    },
  });
  assert.equal(parsed.requestType, "START");
  assert.equal(parsed.runId, "");
});

test("POST 403 is dedicated; GET/parse and generic POST failures are not retried", async () => {
  let postCalls = 0;
  let getCalls = 0;
  await assert.rejects(
    createRequest(
      {
        requestAppId: 1,
        postRecord: async () => {
          postCalls += 1;
          throw { response: { status: 403 } };
        },
        fetchRecords: async () => {
          getCalls += 1;
          return { records: [] };
        },
      },
      { requestType: "STOP", runId: "run", reason: "reason" },
    ),
    (error) =>
      error instanceof RequestPostError &&
      error.kind === "forbidden" &&
      /追加権限がありません/u.test(error.message),
  );
  assert.equal(postCalls, 1);
  assert.equal(getCalls, 0);

  await assert.rejects(
    createRequest(
      {
        requestAppId: 1,
        postRecord: async () => {
          throw new Error("network down");
        },
        fetchRecords: async () => ({ records: [] }),
      },
      { requestType: "RELEASE", runId: "run", reason: "reason" },
    ),
    (error) =>
      error instanceof RequestPostError &&
      error.kind === "failed" &&
      /自動再試行は行いません/u.test(error.message),
  );
});
