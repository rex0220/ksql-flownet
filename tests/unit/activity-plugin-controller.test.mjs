import assert from "node:assert/strict";
import test from "node:test";

import {
  BoardController,
  loadBoard,
} from "../../dist/plugin/board-controller.js";
import { loadDetail } from "../../dist/plugin/detail-controller.js";
import {
  createKintoneFetchRecords,
  installDesktop,
  isNetworkRunDetail,
  isRunBoardEvent,
} from "../../dist/plugin/desktop.js";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const field = (value) => ({ value });
const runRecord = (id, overrides = {}) => ({
  $id: field(String(id)),
  record_type: field("NETWORK_RUN"),
  run_id: field(`run_${id}`),
  business_key: field(`business_${id}`),
  status: field("RUNNING"),
  started_at: field("2026-08-31T23:00:00.000Z"),
  ...overrides,
});
const lockRecord = () => ({
  $id: field("20"),
  record_type: field("NETWORK_LOCK"),
  status: field("RUNNING"),
  owner_invocation_id: field("invoke_1"),
  status_reason: field("owner_instance_id=host-1"),
  heartbeat_at: field("2026-09-01T00:00:00.000Z"),
  lease_expires_at: field("2026-09-01T00:00:30.000Z"),
  revision: field("1"),
});
const invocationRecord = () => ({
  $id: field("30"),
  record_type: field("RUN_INVOCATION"),
  invocation_id: field("invoke_1"),
  run_id: field("run_1"),
});

test("index/detail guards reject other views and record types", () => {
  assert.equal(
    isRunBoardEvent({ viewType: "custom", viewName: "00_Run状況" }),
    true,
  );
  assert.equal(
    isRunBoardEvent({ viewType: "list", viewName: "00_Run状況" }),
    false,
  );
  assert.equal(
    isRunBoardEvent({ viewType: "custom", viewName: "02_未完了Run" }),
    false,
  );
  assert.equal(
    isNetworkRunDetail({ record: { record_type: field("NETWORK_RUN") } }),
    true,
  );
  assert.equal(
    isNetworkRunDetail({ record: { record_type: field("NODE_STATE") } }),
    false,
  );

  const handlers = new Map();
  let apiCalls = 0;
  const apiFunction = async () => {
    apiCalls += 1;
    return { records: [] };
  };
  apiFunction.url = (path) => path;
  installDesktop(
    {
      $PLUGIN_ID: "plugin-id",
      events: { on: (name, handler) => handlers.set(name, handler) },
      app: {
        getId: () => 100,
        record: { getHeaderMenuSpaceElement: () => null },
      },
      plugin: { app: { getConfig: () => ({ auditAppId: "200" }) } },
      api: apiFunction,
    },
    {},
  );
  handlers.get("app.record.index.show")({
    viewType: "list",
    viewName: "00_Run状況",
  });
  handlers.get("app.record.detail.show")({
    record: { record_type: field("NODE_STATE") },
  });
  assert.equal(apiCalls, 0);
});

test("terminal detail performs no GET and displays terminal state", async () => {
  let calls = 0;
  const model = await loadDetail(
    {
      fetchRecords: async () => {
        calls += 1;
        return { records: [] };
      },
      stateAppId: 100,
      auditAppId: "200",
      nowMs: () => NOW,
    },
    runRecord(1, { status: field("SUCCESS") }),
  );
  assert.deepEqual(model, { state: "terminal" });
  assert.equal(calls, 0);
});

test("board uses the minimum four records GET requests with scoped apps, fields, and queries", async () => {
  const requests = [];
  const fetchRecords = async (request) => {
    requests.push(request);
    if (request.query.includes('record_type in ("NETWORK_RUN")')) {
      return { records: [runRecord(1)] };
    }
    if (request.query.includes('record_type in ("NETWORK_LOCK")')) {
      return { records: [lockRecord()] };
    }
    if (request.query.includes('record_type in ("CANCEL_REQUEST")')) {
      return { records: [] };
    }
    if (request.query.includes('record_type in ("RUN_INVOCATION")')) {
      return { records: [invocationRecord()] };
    }
    throw new Error("unexpected request");
  };
  const model = await loadBoard({
    fetchRecords,
    stateAppId: 100,
    auditAppId: "200",
    nowMs: () => NOW,
  });
  assert.equal(model.state, "ready");
  assert.equal(model.rows[0]?.activity, "LIVE");
  assert.equal(requests.length, 4);
  assert.deepEqual(
    requests.map(({ app }) => app),
    [100, 100, 100, "200"],
  );
  assert.match(requests[0].query, /status not in/u);
  assert.match(requests[1].query, /status in \("RUNNING"\)/u);
  assert.match(requests[2].query, /run_id in \("run_1"\)/u);
  assert.match(requests[3].query, /invocation_id in \("invoke_1"\)/u);
  assert.ok(requests.every(({ query }) => query.includes("limit 500")));
  assert.deepEqual(requests[3].fields, [
    "$id",
    "record_type",
    "invocation_id",
    "run_id",
  ]);

  const apiCalls = [];
  const apiFunction = async (url, method, body) => {
    apiCalls.push({ url, method, body });
    return { records: [] };
  };
  apiFunction.url = (path, guestSpace) => `${guestSpace}:${path}`;
  await createKintoneFetchRecords({ api: apiFunction })({
    app: 100,
    query: "limit 1",
    fields: ["$id"],
  });
  assert.deepEqual(apiCalls, [
    {
      url: "true:/k/v1/records.json",
      method: "GET",
      body: { app: 100, query: "limit 1", fields: ["$id"] },
    },
  ]);
});

test("configuration and supporting-read failures expose no partial activity badges", async () => {
  let invalidConfigCalls = 0;
  const invalid = await loadBoard({
    fetchRecords: async () => {
      invalidConfigCalls += 1;
      return { records: [] };
    },
    stateAppId: 100,
    auditAppId: " 200 ",
  });
  assert.equal(invalid.state, "error");
  assert.equal(invalid.rows.length, 0);
  assert.equal(invalidConfigCalls, 0);

  let calls = 0;
  const failed = await loadBoard({
    fetchRecords: async (request) => {
      calls += 1;
      if (request.query.includes('record_type in ("NETWORK_RUN")')) {
        return { records: [runRecord(1)] };
      }
      if (request.query.includes('record_type in ("NETWORK_LOCK")')) {
        return { records: [lockRecord()] };
      }
      if (request.query.includes('record_type in ("CANCEL_REQUEST")')) {
        return { records: [] };
      }
      throw new Error("audit permission denied");
    },
    stateAppId: 100,
    auditAppId: "200",
  });
  assert.equal(calls, 4);
  assert.equal(failed.state, "error");
  assert.equal(failed.rows.length, 0);
  assert.equal(failed.judgedAt, null);
});

test("a malformed Cancel suppresses only its row badge", async () => {
  const malformedCancel = {
    $id: field("41"),
    record_type: field("CANCEL_REQUEST"),
    record_key: field("CANCEL:run_1"),
    run_id: field("run_1"),
    status_reason: field("{"),
  };
  const model = await loadBoard({
    fetchRecords: async (request) => {
      if (request.query.includes('record_type in ("NETWORK_RUN")')) {
        return {
          records: [runRecord(1), runRecord(2, { started_at: field("") })],
        };
      }
      if (request.query.includes('record_type in ("CANCEL_REQUEST")')) {
        return { records: [malformedCancel] };
      }
      return { records: [] };
    },
    stateAppId: 100,
    auditAppId: "200",
    nowMs: () => NOW,
  });
  assert.equal(model.state, "ready");
  assert.equal(model.rows[0]?.activity, null);
  assert.match(model.rows[0]?.error ?? "", /CANCEL_REQUEST/u);
  assert.equal(model.rows[1]?.activity, "IDLE");
  assert.equal(model.rows[1]?.error, null);
});

test("reload generations ignore slow old responses and keep one active render", async () => {
  const pending = [];
  const rendered = [];
  let loading = 0;
  const controller = new BoardController(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
    {
      loading: () => {
        loading += 1;
      },
      render: (model) => rendered.push(model),
    },
  );
  controller.reload();
  controller.reload();
  const oldModel = { state: "ready", rows: [], judgedAt: 1, error: null };
  const newModel = { state: "ready", rows: [], judgedAt: 2, error: null };
  pending[1](newModel);
  await Promise.resolve();
  pending[0](oldModel);
  await Promise.resolve();
  assert.equal(loading, 2);
  assert.deepEqual(rendered, [newModel]);
});
