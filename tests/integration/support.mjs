import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { sanitize } from "../../spikes/lib/runtime.mjs";
import { KintonePersistenceRepository } from "../../dist/persistence/kintone/repository.js";

const FORBIDDEN_APP_IDS = new Set(["4246", "4247", "4249"]);
export const ITEST_PREFIX = "ITEST_";

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`必要な環境変数がありません: ${name}`);
  return value;
}

function appId(environment, name) {
  const value = required(environment, name);
  if (!/^\d+$/.test(value))
    throw new Error(`${name} は数字のアプリIDで指定してください。`);
  if (FORBIDDEN_APP_IDS.has(value))
    throw new Error(`既存アプリID ${value} への書込みは禁止されています。`);
  return Number(value);
}

export function requireIntegrationEnvironment(environment = process.env) {
  const baseUrl = new URL(required(environment, "KSQL_SPIKE_BASE_URL"));
  if (baseUrl.protocol !== "https:")
    throw new Error("KSQL_SPIKE_BASE_URL は https URLで指定してください。");
  const stateAppId = appId(environment, "KSQL_SPIKE_APP_EXEC");
  const auditAppId = appId(environment, "KSQL_SPIKE_APP_AUDIT");
  if (stateAppId === auditAppId)
    throw new Error("EXECとAUDITには異なる2アプリを指定してください。");
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    stateAppId,
    auditAppId,
    stateApiToken: required(environment, "KSQL_SPIKE_TOKEN_EXEC"),
    auditApiToken: required(environment, "KSQL_SPIKE_TOKEN_AUDIT"),
  };
}

export function makeScope(name) {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
  return `${ITEST_PREFIX}${name.replaceAll("-", "_")}_${stamp}_${randomUUID().slice(0, 8)}`;
}

export function createObservedFetch(observations) {
  return async (input, init = {}) => {
    const response = await globalThis.fetch(input, init);
    const copy = response.clone();
    const responseBody = await copy.json().catch(() => null);
    observations.push({
      method: init.method ?? "GET",
      path: new URL(input).pathname,
      status: response.status,
      apiCode:
        responseBody && typeof responseBody.code === "string"
          ? responseBody.code
          : null,
    });
    return response;
  };
}

export function createRepository(config, fetchImplementation) {
  return new KintonePersistenceRepository({
    ...config,
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  });
}

async function rawRequest(config, appIdValue, token, path, options = {}) {
  const url = new URL(`/k/v1/${path}.json`, `${config.baseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(key, String(value));
  const body = options.body;
  const response = await globalThis.fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "X-Cybozu-API-Token": token,
      ...(body === undefined || body instanceof globalThis.FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : {
          body:
            body instanceof globalThis.FormData ? body : JSON.stringify(body),
        }),
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `kintone API ${options.method ?? "GET"} ${path} が失敗しました。`,
    );
    error.status = response.status;
    error.apiCode = responseBody?.code ?? null;
    throw error;
  }
  return responseBody;
}

export async function getRecords(config, target, query) {
  const isState = target === "state";
  const app = isState ? config.stateAppId : config.auditAppId;
  const token = isState ? config.stateApiToken : config.auditApiToken;
  const body = await rawRequest(config, app, token, "records", {
    query: { app, query: `${query} limit 500` },
  });
  return body.records ?? [];
}

export async function getRecordByKey(config, target, recordKey) {
  const escaped = quote(recordKey);
  const records = await getRecords(
    config,
    target,
    `record_key in (${escaped})`,
  );
  return records[0] ?? null;
}

export async function uploadBundle(config, scope) {
  const form = new globalThis.FormData();
  form.append(
    "file",
    new globalThis.Blob([JSON.stringify({ scope })], {
      type: "application/json",
    }),
    `${scope}.json`,
  );
  const result = await rawRequest(
    config,
    config.stateAppId,
    config.stateApiToken,
    "file",
    { method: "POST", body: form },
  );
  return result.fileKey;
}

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

async function deleteMatching(config, target, query) {
  const isState = target === "state";
  const app = isState ? config.stateAppId : config.auditAppId;
  const token = isState ? config.stateApiToken : config.auditApiToken;
  const records = await getRecords(config, target, query);
  for (const group of chunks(records, 100)) {
    await rawRequest(config, app, token, "records", {
      method: "DELETE",
      body: {
        app,
        ids: group.map((record) => String(record.$id.value)),
        revisions: group.map((record) => String(record.$revision.value)),
      },
    });
  }
  return records.length;
}

export async function cleanupTaggedRecords(config, prefix) {
  const escaped = String(prefix)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  const stateQuery = [
    `run_id like "${escaped}"`,
    `owner_invocation_id like "${escaped}"`,
    `status_reason like "${escaped}"`,
    `record_key like "RUN:${escaped}"`,
  ].join(" or ");
  const auditQuery = [
    `run_id like "${escaped}"`,
    `invocation_id like "${escaped}"`,
    `record_key like "INV:${escaped}"`,
    `record_key like "ATT:${escaped}"`,
  ].join(" or ");
  const audit = await deleteMatching(config, "audit", auditQuery);
  const state = await deleteMatching(config, "state", stateQuery);
  return { state, audit, total: state + audit };
}

export function makeRun(scope, bundleFileKey, overrides = {}) {
  const now = new Date().toISOString();
  return {
    run_id: scope,
    network_id: `${scope}_network`,
    business_key: `${scope}_business`,
    max_active_runs: 1,
    status: "CREATED",
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: null,
    definition_schema_version: 1,
    definition_sha256: "sha256:itest-definition",
    source_bundle_sha256: "sha256:itest-bundle",
    source_bundle_attachment: bundleFileKey,
    resolved_profile_snapshot: {
      profile: `${scope}_profile`,
      base_url: "https://itest.invalid",
      guest_space_id: null,
      timezone: "Asia/Tokyo",
      apps: {},
      limits: {
        max_api_calls: 100,
        max_read_rows: 100,
        batch_timeout_sec: 60,
      },
    },
    resolved_profile_sha256: "sha256:itest-profile",
    ksql_flow_version: "itest",
    engine_version: "itest",
    dialect: 1,
    created_at: now,
    started_at: null,
    finished_at: null,
    updated_at: now,
    ...overrides,
  };
}

export function makeState(scope, nodeStateKey, overrides = {}) {
  return {
    node_state_id: `${scope}_state`,
    node_state_key: nodeStateKey,
    run_id: scope,
    node_id: `${scope}_node`,
    job_id: `${scope}_job`,
    status: "WAITING",
    latest_attempt_no: 0,
    active_attempt_id: null,
    revision: 1,
    idempotent: true,
    trigger_rule: "all_success",
    blocked_by: [],
    status_reason: null,
    started_at: null,
    finished_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

export function attemptFinalization(status = "SUCCESS") {
  return {
    status,
    result_code: status === "SUCCESS" ? "OK" : status,
    runner_execution_started_at: new Date().toISOString(),
    execution_id: `${ITEST_PREFIX}execution`,
    finished_at: new Date().toISOString(),
    duration_sec: 1,
    error_message: null,
    read_count: 1,
    written_count: 1,
    last_successful_chunk_no: 1,
    last_written_key: `${ITEST_PREFIX}key`,
  };
}

export function summarizeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    status: error?.status ?? null,
    apiCode: error?.apiCode ?? null,
    message: error?.message ?? String(error),
    ...(error?.result ? { result: error.result } : {}),
  };
}

async function writeIntegrationResult(importMetaUrl, result, secrets) {
  const safe = sanitize(result, secrets);
  const serialized = `${JSON.stringify(safe, null, 2)}\n`;
  for (const secret of secrets) {
    if (secret && serialized.includes(secret))
      throw new Error("結果JSONにtoken値が含まれるため保存を中止しました。");
  }
  if (/"(?:authorization|[^"\n]*token[^"\n]*)"\s*:/i.test(serialized))
    throw new Error("結果JSONに秘密フィールドが含まれています。");
  const directory = join(dirname(fileURLToPath(importMetaUrl)), "results");
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const name = fileURLToPath(importMetaUrl)
    .split(/[\\/]/)
    .at(-1)
    .replace(/\.mjs$/, "");
  const path = join(directory, `${stamp}-${name}.json`);
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
  return path;
}

export async function runIntegration(importMetaUrl, name, test, options = {}) {
  const scope = makeScope(name);
  let config;
  let detail;
  let passed = false;
  let cleanup = null;
  try {
    config = requireIntegrationEnvironment();
    detail = await test({ config, scope });
    passed = true;
  } catch (error) {
    detail = { error: summarizeError(error) };
  } finally {
    if (config && options.selfCleanup !== false) {
      try {
        cleanup = await cleanupTaggedRecords(config, scope);
      } catch (error) {
        cleanup = { error: summarizeError(error) };
        passed = false;
      }
    }
  }
  const secrets = [
    process.env.KSQL_SPIKE_TOKEN_EXEC,
    process.env.KSQL_SPIKE_TOKEN_AUDIT,
    process.env.KSQL_SPIKE_TOKEN_EXEC_RO,
    process.env.KSQL_SPIKE_TOKEN_AUDIT_RO,
  ].filter(Boolean);
  const result = {
    test: name,
    passed,
    scope,
    observedAt: new Date().toISOString(),
    nodeVersion: process.version,
    detail,
    cleanup,
  };
  let path;
  try {
    path = await writeIntegrationResult(importMetaUrl, result, secrets);
  } catch (error) {
    globalThis.console.error(`結果JSON保存失敗: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (passed) globalThis.console.log(`合格: ${name}`);
  else
    globalThis.console.error(
      `不合格: ${name} - ${detail.error?.message ?? "検証条件不一致"}`,
    );
  globalThis.console.log(`詳細JSON: ${path}`);
  process.exitCode = passed ? 0 : 1;
}
