import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  field,
  getAllPersistenceRecords,
  loadRunGraph,
  snapshotPersistenceRevisions,
} from "./support.mjs";
import {
  createAllowlist,
  createRequest,
  getRequest,
  P2_01_PREFIX,
  prepareP201Network,
  requestReason,
  runP201,
  runPollRequests,
  waitForRequest,
} from "./p2-01-support.mjs";

export const P2_11_PREFIX = P2_01_PREFIX;
export const TERMINAL_REQUEST_STATES = new Set(["DONE", "REJECTED"]);

export function startInput(scope, label, input) {
  assert.ok(scope.startsWith(P2_11_PREFIX));
  assert.ok(input.networkId?.startsWith(P2_11_PREFIX));
  return {
    requestType: "START",
    runId: input.runId ?? "",
    networkId: input.networkId,
    businessKey: input.businessKey,
    scheduledFor: input.scheduledFor,
    reason: requestReason(scope, label),
    ...(input.machine === undefined ? {} : { machine: input.machine }),
  };
}

export async function createStartRequest(settings, scope, label, input) {
  return createRequest(settings, startInput(scope, label, input));
}

export async function waitForTerminalRequest(settings, id) {
  return waitForRequest(
    settings,
    id,
    ({ requestState }) => TERMINAL_REQUEST_STATES.has(requestState),
    `START request ${id} terminal`,
  );
}

export async function pollAndWait(settings, allowlistPath, request) {
  const poller = await runPollRequests(settings, allowlistPath);
  assert.equal(poller.exitCode, 0, poller.stderr || poller.stdout);
  return {
    poller,
    request: await waitForTerminalRequest(settings, request.id),
  };
}

export async function prepareP211Network(scope, policy) {
  assert.ok(["explicit", "scheduled"].includes(policy));
  const fixture = await prepareP201Network(
    scope,
    `network-p211-${policy}.yaml`,
  );
  return Object.assign(fixture, { appStart: true });
}

export async function readTargetPeriodAggregate(
  settings,
  { fromDate, toDate },
) {
  assert.match(fromDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert.match(toDate, /^\d{4}-\d{2}-\d{2}$/u);
  const config = JSON.parse(await readFile(settings.configPath, "utf8"));
  const profile = config.profiles?.[settings.profile];
  assert.ok(profile, `configにprofile ${settings.profile} がありません`);
  assert.equal(
    new globalThis.URL(profile.baseUrl).origin,
    new globalThis.URL(settings.baseUrl).origin,
    "業務集計の読取先はE2E profileと同じoriginに限定します",
  );
  const app = profile.apps?.["案件管理"];
  assert.ok(Number.isSafeInteger(app?.id) && app.id > 0);
  const tokenNames = (app.tokens ?? []).map((reference) => {
    assert.match(reference, /^env:[A-Z][A-Z0-9_]*$/u);
    return reference.slice(4);
  });
  const tokens = tokenNames.map((name) => {
    const token = process.env[name]?.trim();
    assert.ok(token, `案件管理の読取token環境変数がありません: ${name}`);
    return token;
  });
  assert.ok(tokens.length > 0);
  const records = [];
  for (let offset = 0; ; offset += 500) {
    const url = new globalThis.URL("/k/v1/records.json", settings.baseUrl);
    url.searchParams.set("app", String(app.id));
    url.searchParams.set(
      "query",
      `受注予定日 >= "${fromDate}" and 受注予定日 < "${toDate}" order by $id asc limit 500 offset ${offset}`,
    );
    url.searchParams.append("fields[0]", "売上");
    const response = await globalThis.fetch(url, {
      headers: { "X-Cybozu-API-Token": tokens.join(",") },
    });
    assert.equal(
      response.status,
      200,
      "案件管理の対象期間集計読取に失敗しました",
    );
    const page = (await response.json()).records ?? [];
    records.push(...page);
    if (page.length < 500) break;
  }
  const totalSales = records.reduce((sum, record) => {
    const value = Number(record.売上?.value);
    assert.ok(Number.isFinite(value), "案件管理の売上は有限数であること");
    return sum + value;
  }, 0);
  assert.ok(records.length > 0, "対象期間の案件が1件以上必要です");
  return { count: records.length, totalSales };
}

export async function setScheduledAggregateExpectation(fixture, expected) {
  assert.ok(Number.isSafeInteger(expected.count) && expected.count > 0);
  assert.ok(Number.isFinite(expected.totalSales));
  const path = join(fixture.directory, "jobs", "p211-scheduled-aggregate.sql");
  const source = await readFile(path, "utf8");
  const configured = source
    .replace("__P211_EXPECTED_COUNT__", String(expected.count))
    .replace("__P211_EXPECTED_SALES__", String(expected.totalSales));
  assert.doesNotMatch(configured, /__P211_EXPECTED_/u);
  await writeFile(path, configured, "utf8");
  return path;
}

export async function createP211Allowlist(entries) {
  return createAllowlist(
    entries.map((entry) => {
      if (entry.networkPath) return entry;
      return Object.assign(entry.fixture, { appStart: entry.appStart });
    }),
  );
}

export async function listRuns(settings, selector = {}) {
  const records = await getAllPersistenceRecords(
    settings,
    "state",
    'record_type in ("NETWORK_RUN")',
  );
  return records
    .filter(
      (record) =>
        (selector.networkId === undefined ||
          field(record, "network_id") === selector.networkId) &&
        (selector.businessKey === undefined ||
          field(record, "business_key") === selector.businessKey),
    )
    .map((record) => ({
      runId: field(record, "run_id"),
      networkId: field(record, "network_id"),
      businessKey: field(record, "business_key"),
      status: field(record, "status"),
      asOf: field(record, "as_of"),
    }));
}

export async function assertStartCorrelation(settings, request, businessKey) {
  const graph = await loadRunGraph(settings, businessKey);
  assert.ok(
    graph.invocations.length > 0,
    "STARTはInvocationを1件以上作成します",
  );
  const invocation = graph.invocations.at(-1);
  const expectedRequestedBy = `app-request:${request.id}:${encodeURIComponent(request.creatorCode)}`;
  assert.equal(invocation.requestedBy, expectedRequestedBy);
  assert.match(request.resultMessage ?? "", /invocation_id=/u);
  assert.match(
    request.resultMessage,
    new RegExp(`${invocation.invocationId}$`, "u"),
  );
  return { graph, expectedRequestedBy };
}

export function graphIdentity(graph) {
  return {
    run: graph.run,
    states: graph.states,
    attempts: graph.attempts,
    invocations: graph.invocations,
  };
}

// ensureRunはMAX_ACTIVE_RUNS等の裁定より前にNETWORK_LOCKレコードを作成し、
// 解放はtombstone(LOCKDONE)のUPDATE方式でレコードが残る(2026-09-02実測 —
// P2-11以前からの基盤挙動)。受入4の「状態不変」はRun/Invocation/Node stateの
// 不変を意味するため、stateアプリはNETWORK_LOCKのみ増分・改版を許容し、
// それ以外のrecord_typeと監査アプリは完全一致で検証する。
export async function persistenceSnapshot(settings) {
  const snapshot = { audit: (await snapshotPersistenceRevisions(settings)).audit };
  const records = await getAllPersistenceRecords(settings, "state");
  snapshot.state = Object.fromEntries(
    records.map((record) => [
      field(record, "$id"),
      {
        revision: field(record, "$revision"),
        type: field(record, "record_type"),
      },
    ]),
  );
  return snapshot;
}

export async function assertPersistenceUnchanged(settings, before) {
  const after = await persistenceSnapshot(settings);
  assert.deepEqual(after.audit, before.audit, "監査アプリは完全不変であること");
  for (const [id, entry] of Object.entries(before.state)) {
    const current = after.state[id];
    assert.ok(current, `既存stateレコード#${id}が消えています`);
    if (entry.type === "NETWORK_LOCK") continue;
    assert.deepEqual(
      current,
      entry,
      `stateレコード#${id}(${entry.type})が変更されています`,
    );
  }
  for (const [id, entry] of Object.entries(after.state)) {
    if (Object.hasOwn(before.state, id)) continue;
    assert.equal(
      entry.type,
      "NETWORK_LOCK",
      `NETWORK_LOCK以外のstateレコード#${id}(${entry.type})が増えています`,
    );
  }
}

export async function refreshRequest(settings, request) {
  return getRequest(settings, request.id);
}

export async function runP211(importMetaUrl, name, test) {
  return runP201(importMetaUrl, name, test);
}
