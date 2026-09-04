import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import {
  childEnvironment,
  prepareNetwork,
  runE2EGate,
  startProcess,
  waitFor,
} from "./support.mjs";

export const P2_01_PREFIX = "KSQL_FLOW_TEST_";
const PRODUCTION_APP_IDS = new Set([4261, 4262, 4249]);
const PRODUCTION_JOB_IDS = new Set([
  "00_intake_count",
  "intake_count",
  "intake_gate",
  "test_data_gate",
  "monthly_deal_summary",
]);
const P2_01_FIXTURES = new Set([
  "network-success.yaml",
  "network-brake.yaml",
  "network-drill.yaml",
  "network-p211-explicit.yaml",
  "network-p211-scheduled.yaml",
  "network-csv1-import.yaml",
]);
const FLOWNET_CLI = fileURLToPath(
  new globalThis.URL("../../dist/cli/index.js", import.meta.url),
);

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`必要な環境変数がありません: ${name}`);
  return value;
}

function positiveInteger(environment, name) {
  const value = Number(required(environment, name));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} は正の整数で指定してください。`);
  return value;
}

function assertNonProductionApp(name, appId) {
  assert.ok(
    !PRODUCTION_APP_IDS.has(appId),
    `${name} に本番アプリID 4261/4262/4249は指定できません`,
  );
}

export function requireP201Environment(
  baseSettings,
  environment = process.env,
) {
  const profile =
    environment.KSQL_FLOWNET_PROFILE?.trim() || baseSettings.profile;
  assert.notEqual(
    profile,
    "prod",
    "P2-01 E2Eはprodプロファイルを使用できません",
  );
  const requestAppId = positiveInteger(environment, "KSQL_E2E_REQUEST_APP_ID");
  const requestApiToken = required(environment, "KSQL_E2E_TOKEN_REQUESTS");
  const requestReadToken = required(environment, "KSQL_E2E_TOKEN_REQUESTS_RO");
  assert.notEqual(
    requestApiToken,
    requestReadToken,
    "要求アプリの更新/清掃tokenと読取専用tokenは分離してください",
  );
  for (const [name, appId] of [
    ["KSQL_E2E_REQUEST_APP_ID", requestAppId],
    ["KSQL_SPIKE_APP_EXEC", baseSettings.stateAppId],
    ["KSQL_SPIKE_APP_AUDIT", baseSettings.auditAppId],
    ["KSQL_E2E_LOG_APP_ID", baseSettings.jobLogAppId],
  ]) {
    assertNonProductionApp(name, appId);
  }
  for (const [name, appId] of [
    ["KSQL_SPIKE_APP_EXEC", baseSettings.stateAppId],
    ["KSQL_SPIKE_APP_AUDIT", baseSettings.auditAppId],
    ["KSQL_E2E_LOG_APP_ID", baseSettings.jobLogAppId],
  ]) {
    assert.notEqual(
      requestAppId,
      appId,
      `E2E要求アプリは${name}と別IDにしてください`,
    );
  }
  const productionRequestApp = environment.KSQL_FLOWNET_REQUEST_APP_ID?.trim();
  if (productionRequestApp) {
    assert.notEqual(
      requestAppId,
      Number(productionRequestApp),
      "E2E要求アプリは本番要求アプリと別IDにしてください",
    );
  }
  const productionRequestToken =
    environment.KSQL_FLOWNET_REQUEST_API_TOKEN?.trim();
  if (productionRequestToken) {
    assert.notEqual(
      requestApiToken,
      productionRequestToken,
      "E2E要求アプリtokenに本番要求アプリtokenは使用できません",
    );
  }
  return {
    ...baseSettings,
    profile,
    requestAppId,
    requestApiToken,
    requestReadToken,
    servicePrincipal: `${P2_01_PREFIX}service`,
    requestedBy: `${P2_01_PREFIX}direct_requester`,
  };
}

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function rawField(record, name) {
  return record[name]?.value ?? null;
}

function decodeRequest(record) {
  const creator = rawField(record, "作成者");
  return {
    id: rawField(record, "$id"),
    revision: Number(rawField(record, "$revision")),
    creatorCode:
      creator && typeof creator === "object" ? (creator.code ?? null) : null,
    createdAt: rawField(record, "作成日時"),
    requestType: rawField(record, "request_type"),
    runId: rawField(record, "run_id"),
    networkId: rawField(record, "network_id") || null,
    businessKey: rawField(record, "business_key") || null,
    scheduledFor: rawField(record, "scheduled_for") || null,
    rerunFromNode: rawField(record, "rerun_from_node") || null,
    reason: rawField(record, "reason"),
    requestState: rawField(record, "request_state"),
    claimedAt: rawField(record, "claimed_at") || null,
    claimedHost: rawField(record, "claimed_host") || null,
    claimHeartbeatAt: rawField(record, "claim_heartbeat_at") || null,
    resultCode: rawField(record, "result_code") || null,
    resultMessage: rawField(record, "result_message") || null,
  };
}

async function requestApi(settings, path, options = {}) {
  const url = new globalThis.URL(`/k/v1/${path}.json`, `${settings.baseUrl}/`);
  for (const [name, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(name, String(value));
  const response = await globalThis.fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "X-Cybozu-API-Token": options.readOnly
        ? settings.requestReadToken
        : settings.requestApiToken,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(
      `要求アプリAPI ${options.method ?? "GET"} ${path} がHTTP ${response.status}で失敗しました`,
    );
  }
  return response.status === 204 ? null : response.json();
}

export async function createRequest(settings, input) {
  assert.ok(
    input.reason?.startsWith(P2_01_PREFIX),
    `reasonは${P2_01_PREFIX}で始めてください`,
  );
  const machine = input.machine ?? {};
  const record = {
    request_type: { value: input.requestType },
    run_id: { value: input.runId ?? "" },
    ...(input.networkId === undefined
      ? {}
      : { network_id: { value: input.networkId ?? "" } }),
    ...(input.businessKey === undefined
      ? {}
      : { business_key: { value: input.businessKey ?? "" } }),
    ...(input.scheduledFor === undefined
      ? {}
      : { scheduled_for: { value: input.scheduledFor ?? "" } }),
    rerun_from_node: { value: input.rerunFromNode ?? "" },
    reason: { value: input.reason },
    request_state: { value: machine.requestState ?? "REQUESTED" },
    ...(machine.claimedAt === undefined
      ? {}
      : { claimed_at: { value: machine.claimedAt } }),
    ...(machine.claimedHost === undefined
      ? {}
      : { claimed_host: { value: machine.claimedHost } }),
    ...(machine.claimHeartbeatAt === undefined
      ? {}
      : { claim_heartbeat_at: { value: machine.claimHeartbeatAt } }),
  };
  const created = await requestApi(settings, "record", {
    method: "POST",
    body: { app: settings.requestAppId, record },
  });
  return getRequest(settings, created.id);
}

export async function getRequest(settings, id) {
  const result = await requestApi(settings, "record", {
    query: { app: settings.requestAppId, id },
    readOnly: true,
  });
  return decodeRequest(result.record);
}

export async function listRequests(settings, query = "") {
  const result = await requestApi(settings, "records", {
    query: { app: settings.requestAppId, query },
    readOnly: true,
  });
  return result.records.map(decodeRequest);
}

export async function waitForRequest(settings, id, predicate, description) {
  return waitFor(
    async () => {
      const record = await getRequest(settings, id);
      return predicate(record) ? record : null;
    },
    description ?? `request ${id}`,
  );
}

export async function cleanupRequestRecords(settings, prefix) {
  assert.ok(
    prefix.startsWith(P2_01_PREFIX),
    `要求清掃prefixは${P2_01_PREFIX}配下に限定されます`,
  );
  const records = await listRequests(
    settings,
    `reason like ${quote(prefix)} order by $id asc limit 500`,
  );
  const targets = records.filter(({ reason }) => reason?.startsWith(prefix));
  assert.ok(
    targets.every(({ reason }) => reason.startsWith(P2_01_PREFIX)),
    "prefix外の要求レコードは削除できません",
  );
  for (let offset = 0; offset < targets.length; offset += 100) {
    const group = targets.slice(offset, offset + 100);
    await requestApi(settings, "records", {
      method: "DELETE",
      body: {
        app: settings.requestAppId,
        ids: group.map(({ id }) => id),
        revisions: group.map(({ revision }) => revision),
      },
    });
  }
  return { prefix, removed: targets.length };
}

async function assertNoPendingRequests(settings) {
  const pending = await listRequests(
    settings,
    'request_state in ("REQUESTED", "ACCEPTED") order by $id asc limit 500',
  );
  assert.deepEqual(
    pending,
    [],
    "E2E要求アプリに未処理要求があります。別ポーラーの誤処理を防ぐため先に解消してください",
  );
}

export async function prepareP201Network(scope, fixtureName) {
  assert.ok(scope.startsWith(P2_01_PREFIX));
  assert.ok(
    P2_01_FIXTURES.has(fixtureName),
    `P2-01 E2Eで許可していないfixtureです: ${fixtureName}`,
  );
  const fixture = await prepareNetwork(scope, fixtureName);
  const source = await readFile(fixture.networkPath, "utf8");
  const network = parse(source);
  const nodeIds = new Map();
  const jobIds = new Map();
  // ksql-flowのジョブロックキー {profile}:{job_id} は64 UTF-16単位が上限
  // (ksql-flow src/jobkey.ts、kintone一意フィールド実測)。scope全体を前置すると
  // 超過してVALIDATION_ERRORになるため(2026-09-01実機)、job_idだけは
  // KSQL_FLOW_TEST_プレフィックス+scopeの短縮ハッシュで前置する。
  const jobScope = `${P2_01_PREFIX}${createHash("sha256").update(scope).digest("hex").slice(0, 8)}`;
  for (const node of network.nodes) {
    assert.ok(
      !PRODUCTION_JOB_IDS.has(node.job_id),
      `P2-01 E2Eは本番job_idを使用できません: ${node.job_id}`,
    );
    nodeIds.set(node.id, `${scope}_${node.id}`);
    const jobId = `${jobScope}_${node.job_id}`;
    assert.ok(
      jobId.length <= 60,
      `job_idが長すぎます(profile "e2e:"+job_idで64超過): ${jobId}`,
    );
    jobIds.set(node.job_id, jobId);
  }
  network.network_id = fixture.networkId;
  network.description = `${scope} ${network.description}`;
  for (const node of network.nodes) {
    const oldNodeId = node.id;
    node.id = nodeIds.get(oldNodeId);
    node.job_id = jobIds.get(node.job_id);
    node.depends_on = node.depends_on.map((id) => nodeIds.get(id));
    assert.ok(node.id.startsWith(P2_01_PREFIX));
    assert.ok(node.job_id.startsWith(P2_01_PREFIX));
    const sqlPath = join(fixture.directory, node.sql);
    const sql = await readFile(sqlPath, "utf8");
    await writeFile(
      sqlPath,
      sql.replace(/^-- @ksql name:\s*\S+/mu, `-- @ksql name: ${node.job_id}`),
      "utf8",
    );
  }
  await writeFile(fixture.networkPath, stringify(network), "utf8");
  return {
    ...fixture,
    nodeId(original) {
      const value = nodeIds.get(original);
      assert.ok(value, `fixture nodeがありません: ${original}`);
      return value;
    },
    jobId(original) {
      const value = jobIds.get(original);
      assert.ok(value, `fixture jobがありません: ${original}`);
      return value;
    },
  };
}

export async function createAllowlist(fixtures) {
  assert.ok(fixtures.length > 0);
  for (const fixture of fixtures) {
    assert.ok(fixture.networkId.startsWith(P2_01_PREFIX));
  }
  const directory = await mkdtemp(join(tmpdir(), "ksql-flow-test-allowlist-"));
  const path = join(directory, "allowlist.yaml");
  await writeFile(
    path,
    stringify({
      networks: fixtures.map((fixture) => ({
        network_id: fixture.networkId,
        definition_path: fixture.networkPath,
        ...(fixture.appStart === undefined
          ? {}
          : { app_start: fixture.appStart }),
      })),
    }),
    "utf8",
  );
  return {
    path,
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function startPollRequests(settings, allowlistPath, options = {}) {
  assert.ok(settings.requestAppId);
  const environment = childEnvironment(settings, {
    KSQL_FLOWNET_REQUEST_APP_ID: String(settings.requestAppId),
    KSQL_FLOWNET_REQUEST_API_TOKEN:
      options.requestApiToken ?? settings.requestApiToken,
    KSQL_FLOWNET_REQUEST_ALLOWLIST_PATH: allowlistPath,
    KSQL_FLOWNET_REQUEST_HEARTBEAT_INTERVAL_MS: String(
      options.heartbeatIntervalMs ?? 1_000,
    ),
    KSQL_FLOWNET_REQUEST_STALE_AFTER_MS: String(options.staleAfterMs ?? 5_000),
    KSQL_FLOWNET_HOST: `${P2_01_PREFIX}poller`,
  });
  return startProcess(process.execPath, [FLOWNET_CLI, "poll-requests"], {
    env: environment,
  });
}

export async function runPollRequests(settings, allowlistPath, options = {}) {
  return (await startPollRequests(settings, allowlistPath, options)).completion;
}

export async function runP201(importMetaUrl, name, test, options = {}) {
  return runE2EGate(
    importMetaUrl,
    name,
    async (context) => {
      const settings = requireP201Environment(context.settings);
      await assertNoPendingRequests(settings);
      try {
        const detail = await test({ ...context, settings });
        return { ...detail, requestCleanup: "performed-after-scenario" };
      } finally {
        const requestCleanup = await cleanupRequestRecords(
          settings,
          `${context.scope}:`,
        );
        assert.ok(requestCleanup.removed >= 0);
      }
    },
    { ...options, prefix: P2_01_PREFIX },
  );
}

export function requestReason(scope, label) {
  assert.match(label, /^[a-z0-9-]+$/u);
  return `${scope}:${label}`;
}

export async function ensureWorkdir(settings) {
  await mkdir(settings.workdir, { recursive: true });
  return settings.workdir;
}
