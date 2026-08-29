import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { createKintoneClient, field } from "../../spikes/lib/kintone.mjs";
import { createDataset } from "../../spikes/a-app-layout/scripts/dataset.mjs";
import {
  createLayoutAdapter,
  lockReleaseTombstone,
  nodeStateQuery,
} from "../../spikes/a-app-layout/scripts/layout-adapter.mjs";
import {
  prepareRun,
  runNodeAttempt,
} from "../../spikes/a-app-layout/scripts/scenario-support.mjs";
import { runAuditUnreachable } from "../../spikes/a-app-layout/scripts/scenario-audit-unreachable.mjs";
import { runMidFailure } from "../../spikes/a-app-layout/scripts/scenario-mid-failure.mjs";
import { runNewSuccess } from "../../spikes/a-app-layout/scripts/scenario-new-success.mjs";
import { runReconciliation } from "../../spikes/a-app-layout/scripts/scenario-reconciliation.mjs";
import { runResume } from "../../spikes/a-app-layout/scripts/scenario-resume.mjs";
import { runStateRevisionConflict } from "../../spikes/a-app-layout/scripts/scenario-state-revision-conflict.mjs";

const CONFIG = {
  baseUrl: "https://example.cybozu.com",
  oneApp: { integrated: { app: "9001", token: "one-secret" } },
  twoApp: {
    execution: { app: "9002", token: "exec-secret" },
    audit: { app: "9003", token: "audit-secret" },
  },
};

const ENVIRONMENT = {
  KSQL_SPIKE_BASE_URL: CONFIG.baseUrl,
  KSQL_SPIKE_APP_INTEGRATED: CONFIG.oneApp.integrated.app,
  KSQL_SPIKE_TOKEN_INTEGRATED: CONFIG.oneApp.integrated.token,
  KSQL_SPIKE_APP_EXEC: CONFIG.twoApp.execution.app,
  KSQL_SPIKE_TOKEN_EXEC: CONFIG.twoApp.execution.token,
  KSQL_SPIKE_APP_AUDIT: CONFIG.twoApp.audit.app,
  KSQL_SPIKE_TOKEN_AUDIT: CONFIG.twoApp.audit.token,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createKintoneFetchMock() {
  const apps = new Map();
  let nextId = 100;
  const calls = [];

  function appRecords(app) {
    if (!apps.has(app)) apps.set(app, new Map());
    return apps.get(app);
  }

  function queryValue(query, fieldCode) {
    const match = query.match(
      new RegExp(`${fieldCode}\\s+(?:=|in\\s*\\()\\s*"((?:\\\\.|[^"])*)"\\)?`),
    );
    return match?.[1]?.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }

  const fetchMock = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method ?? "GET", body });
    const app = String(body?.app ?? requestUrl.searchParams.get("app"));
    const records = appRecords(app);

    if (
      requestUrl.pathname.endsWith("/record.json") &&
      options.method === "POST"
    ) {
      for (const existing of records.values()) {
        for (const code of [
          "record_key",
          "node_state_key",
          "attempt_key",
          "lock_key",
        ]) {
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

    if (
      requestUrl.pathname.endsWith("/records.json") &&
      options.method === "DELETE"
    ) {
      for (const id of body.ids) records.delete(String(id));
      return Response.json({});
    }

    if (requestUrl.pathname.endsWith("/records.json")) {
      const query = requestUrl.searchParams.get("query") ?? "";
      if (/\b(?:record_type|status)\s*=/.test(query)) {
        return Response.json({ code: "GAIA_IQ03" }, { status: 400 });
      }
      const filters = [
        "record_type",
        "run_id",
        "node_id",
        "node_attempt_id",
        "record_key",
      ].map((code) => [code, queryValue(query, code)]);
      const responseRecords = [...records.entries()]
        .filter(([, entry]) =>
          filters.every(
            ([code, expected]) =>
              expected === undefined || entry.record[code]?.value === expected,
          ),
        )
        .map(([id, entry]) => ({
          $id: field(id),
          $revision: field(entry.revision),
          ...clone(entry.record),
        }));
      return Response.json({ records: responseRecords, totalCount: null });
    }

    throw new Error(
      `unexpected mock request: ${options.method} ${requestUrl.pathname}`,
    );
  };
  fetchMock.calls = calls;
  fetchMock.apps = apps;
  return fetchMock;
}

test("kintone clientはrequest/response bodyのUTF-8 byte数をcall別・合計で測る", async () => {
  const responseText = JSON.stringify({
    id: "101",
    revision: "1",
    label: "成功",
  });
  let sentBody;
  const client = createKintoneClient(
    { baseUrl: CONFIG.baseUrl, token: "secret" },
    async (_url, options) => {
      sentBody = options.body;
      return new Response(responseText, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  await client.request("record", {
    method: "POST",
    body: { app: "9001", record: { label: field("測定") } },
  });
  assert.equal(client.payloadMeasurements.length, 1);
  assert.equal(
    client.payloadMeasurements[0].requestBytes,
    Buffer.byteLength(sentBody, "utf8"),
  );
  assert.equal(
    client.payloadMeasurements[0].responseBytes,
    Buffer.byteLength(responseText, "utf8"),
  );
  assert.deepEqual(client.payloadTotals, {
    requestBytes: Buffer.byteLength(sentBody, "utf8"),
    responseBytes: Buffer.byteLength(responseText, "utf8"),
    unmeasuredRequestBodies: 0,
  });
});

for (const layoutName of ["1app", "2app"]) {
  test(`${layoutName} adapterは同じD-09操作順でnodeを終端する`, async () => {
    const fetchMock = createKintoneFetchMock();
    const adapter = createLayoutAdapter({
      layoutName,
      config: CONFIG,
      fetchImplementation: fetchMock,
    });
    const dataset = createDataset("unit-order", "fixed");
    const context = await prepareRun(adapter, dataset);
    const node = dataset.nodes[0];
    await runNodeAttempt({
      adapter,
      dataset,
      node,
      state: context.states.get(node.nodeId),
      invocationId: dataset.invocationId,
      attemptNo: 1,
    });
    const relevant = adapter.operationLog
      .map((item) => item.operation)
      .filter((operation) =>
        [
          "insertAttempt",
          "upsertNodeState.update",
          "markAttemptExecutionStarted",
          "finalizeAttempt",
        ].includes(operation),
      );
    assert.deepEqual(relevant, [
      "insertAttempt",
      "upsertNodeState.update",
      "markAttemptExecutionStarted",
      "finalizeAttempt",
      "upsertNodeState.update",
    ]);
    assert.equal(adapter.measurements().payload.unmeasuredRequestBodies, 0);
    assert.deepEqual((await adapter.cleanup()).residualIds, []);
  });
}

test("reconciliationはRUNNING Stateとterminal Attemptの一意な組を検出して修復する", async () => {
  const fetchMock = createKintoneFetchMock();
  const adapter = createLayoutAdapter({
    layoutName: "2app",
    config: CONFIG,
    fetchImplementation: fetchMock,
  });
  const dataset = createDataset("unit-reconcile", "fixed");
  const context = await prepareRun(adapter, dataset);
  const node = dataset.nodes[0];
  await runNodeAttempt({
    adapter,
    dataset,
    node,
    state: context.states.get(node.nodeId),
    invocationId: dataset.invocationId,
    attemptNo: 1,
    skipTerminalState: true,
  });
  const result = await adapter.reconcile(dataset);
  assert.equal(result.detected, 1);
  assert.equal(result.repaired[0].status, "SUCCESS");
  assert.equal(result.inconsistent.length, 0);
  assert.equal(result.additionalApiCalls, 4);
  assert.deepEqual((await adapter.cleanup()).residualIds, []);
});

test("Node State旧revision更新は409となり再GETで勝者を照合できる", async () => {
  const fetchMock = createKintoneFetchMock();
  const adapter = createLayoutAdapter({
    layoutName: "1app",
    config: CONFIG,
    fetchImplementation: fetchMock,
  });
  const dataset = createDataset("unit-conflict", "fixed");
  const context = await prepareRun(adapter, dataset);
  const node = dataset.nodes[0];
  const state = context.states.get(node.nodeId);
  const staleRevision = state.revision;
  await adapter.upsertNodeState({
    dataset,
    node,
    reference: state,
    values: { status: "RUNNING" },
  });
  await assert.rejects(
    adapter.upsertNodeState({
      dataset,
      node,
      reference: state,
      revision: staleRevision,
      values: { status: "FAILED" },
    }),
    (error) => error.status === 409,
  );
  const records = await adapter.query(
    "execution",
    nodeStateQuery(dataset.runId, node.nodeId),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].status.value, "RUNNING");
  assert.deepEqual((await adapter.cleanup()).residualIds, []);
});

test("lock解放はrecord_keyをinvocation tombstoneへ移しlock_keyを空にする", async () => {
  const fetchMock = createKintoneFetchMock();
  const adapter = createLayoutAdapter({
    layoutName: "1app",
    config: CONFIG,
    fetchImplementation: fetchMock,
  });
  const dataset = createDataset("unit-lock-release", "fixed");
  const longInvocationId = `invocation_${"x".repeat(100)}`;
  const lock = await adapter.acquireNetworkLock(dataset, longInvocationId);
  const release = await adapter.releaseNetworkLock(lock);
  assert.equal(release.released, true);
  const releaseCall = fetchMock.calls.find(
    (call) => call.method === "PUT" && call.body?.id === lock.id,
  );
  const tombstone = releaseCall.body.record.record_key.value;
  assert.equal(tombstone, lockReleaseTombstone(longInvocationId));
  assert.match(tombstone, /^LOCKDONE:sha256:/);
  assert.ok(tombstone.length <= 64);
  assert.equal(releaseCall.body.record.lock_key.value, "");
  assert.equal(lockReleaseTombstone("invoke-short"), "LOCKDONE:invoke-short");
  assert.deepEqual((await adapter.cleanup()).residualIds, []);
});

test("全シナリオが生成するqueryはdropdownへ=を使用しない", async (t) => {
  const scenarios = [
    ["new-success", runNewSuccess],
    ["mid-failure", runMidFailure],
    ["resume", runResume],
    ["reconciliation", runReconciliation],
    ["state-revision-conflict", runStateRevisionConflict],
    ["audit-unreachable", runAuditUnreachable],
  ];
  const enumeratedQueries = [];
  for (const [name, runScenario] of scenarios) {
    await t.test(name, async () => {
      const fetchMock = createKintoneFetchMock();
      const result = await runScenario({
        environment: ENVIRONMENT,
        fetchImplementation: fetchMock,
      });
      assert.equal(result.passed, true);
      const queries = fetchMock.calls
        .map((call) => new URL(call.url).searchParams.get("query"))
        .filter((query) => query !== null);
      enumeratedQueries.push(...queries.map((query) => ({ name, query })));
    });
  }
  assert.equal(enumeratedQueries.length, 6);
  for (const { name, query } of enumeratedQueries) {
    assert.doesNotMatch(
      query,
      /\b(?:record_type|status)\s*=/,
      `${name}: ${query}`,
    );
  }
  assert.equal(
    enumeratedQueries.filter(({ query }) =>
      query.startsWith('record_type in ("NODE_STATE")'),
    ).length,
    4,
  );
  assert.equal(
    enumeratedQueries.filter(({ query }) =>
      query.startsWith('record_type in ("NODE_ATTEMPT")'),
    ).length,
    2,
  );
});
