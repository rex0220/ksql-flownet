import assert, { AssertionError } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { sanitize } from "../../spikes/lib/runtime.mjs";
import {
  attemptKey,
  nodeStateKey,
  runKey,
} from "../../dist/domain/canonical-record-key.js";
import { networkLockKey } from "../../dist/domain/canonical-lock-key.js";
import { KsqlFlowCli } from "../../dist/executor/ksql-flow-cli.js";
import {
  downloadBundle as downloadProductBundle,
  uploadBundle as uploadProductBundle,
} from "../../dist/bundle/index.js";
import { KintonePersistenceRepository } from "../../dist/persistence/kintone/repository.js";
import {
  NetworkLockManager,
  releaseTombstoneRecordKey,
} from "../../dist/persistence/network-lock.js";

const FORBIDDEN_APP_IDS = new Set(["4246", "4247", "4249"]);
const MAX_UNIQUE_KEY_LENGTH = 64;
export const ITEST_PREFIX = "IT";

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
  assert.ok(name, "integration test name must not be empty");
  const stamp = new Date().toISOString().slice(2, 19).replaceAll(/[-:T]/g, "");
  return `${ITEST_PREFIX}${stamp}_${randomUUID().slice(0, 4)}`;
}

export function integrationKeySamples(scope) {
  const runIds = [
    scope,
    ...["a", "b", "c", "success_write", "failure_write"].map(
      (suffix) => `${scope}_${suffix}`,
    ),
  ];
  const nodeIds = runIds.map((runId) => `${runId}_node`);
  const attemptIds = [
    ...runIds.map((runId) => `${runId}_attempt`),
    ...["1a", "1b", "2", "3"].map((suffix) => `${scope}_attempt_${suffix}`),
  ];
  const invocationIds = [
    ...runIds.map((runId) => `${runId}_invocation`),
    ...["a", "b", "2", "3"].map((suffix) => `${scope}_invocation_${suffix}`),
  ];
  const canonicalStateKeys = runIds.map((runId, index) =>
    nodeStateKey(runId, nodeIds[index]),
  );
  const canonicalAttemptKeys = runIds.map((runId, index) =>
    attemptKey(runId, nodeIds[index], 1),
  );
  const lockKey = networkLockKey(
    `${scope}_profile`,
    `${scope}_failure_network`,
  );
  const entries = [
    ["scope", scope],
    ...runIds.map((value) => ["run_id", value]),
    [`network_id`, `${scope}_network`],
    [`network_id`, `${scope}_success_network`],
    [`network_id`, `${scope}_failure_network`],
    ["business_key", `${scope}_business`],
    ["profile", `${scope}_profile`],
    ...nodeIds.map((value) => ["node_id", value]),
    ...runIds.map((runId) => ["job_id", `${runId}_job`]),
    ...runIds.map((runId) => ["node_state_id", `${runId}_state`]),
    [`node_state_id`, `${scope}_state_competitor`],
    ...attemptIds.map((value) => ["node_attempt_id", value]),
    ...invocationIds.map((value) => ["invocation_id", value]),
    [`owner_invocation_id`, `${scope}_failure_owner`],
    [`owner_instance_id`, `${scope}_failure_instance`],
    ...canonicalStateKeys.map((value) => ["node_state_key", value]),
    ...canonicalAttemptKeys.map((value) => ["attempt_key", value]),
    ...runIds.map((runId) => [
      "record_key.R1",
      runKey(`${runId}_profile`, `${runId}_network`, `${runId}_business`),
    ]),
    ...canonicalStateKeys.map((key) => ["record_key.STATE", `STATE:${key}`]),
    ...attemptIds.map((attemptId) => ["record_key.ATT", `ATT:${attemptId}`]),
    ...invocationIds.map((invocationId) => [
      "record_key.INV",
      `INV:${invocationId}`,
    ]),
    [
      "record_key.OP",
      `OP:${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}`,
    ],
    ["lock_key", lockKey],
    ["record_key.LOCK", `LOCK:${lockKey}`],
    [
      "record_key.LOCKDONE",
      releaseTombstoneRecordKey(`${lockKey}:${"0".repeat(36)}`),
    ],
  ];
  return entries.map(([kind, value]) => ({
    kind,
    value,
    length: value.length,
  }));
}

export function assertIntegrationKeySampleLengths(samples) {
  for (const sample of samples) {
    assert.ok(
      sample.length <= MAX_UNIQUE_KEY_LENGTH,
      `M3 integration key exceeds ${MAX_UNIQUE_KEY_LENGTH} characters: kind=${sample.kind} actualLength=${sample.length} value=${JSON.stringify(sample.value)}`,
    );
  }
  return samples;
}

export function assertIntegrationKeyLengths(scope) {
  assert.match(
    scope,
    /^IT\d{12}_[0-9a-f]{4}$/,
    `M3 integration scope format is invalid: actual=${JSON.stringify(scope)}`,
  );
  return assertIntegrationKeySampleLengths(integrationKeySamples(scope));
}

export function assertObserved(condition, expected, actual, context) {
  if (condition) return;
  throw new AssertionError({
    message: context,
    actual,
    expected,
    operator: "observed",
  });
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
      code:
        responseBody && typeof responseBody.code === "string"
          ? responseBody.code
          : null,
      apiCode:
        responseBody && typeof responseBody.code === "string"
          ? responseBody.code
          : null,
      message:
        responseBody && typeof responseBody.message === "string"
          ? responseBody.message
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

export async function rawRequest(
  config,
  appIdValue,
  token,
  path,
  options = {},
) {
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
  // An upload fileKey is single-use: every record attachment POST must consume
  // a freshly uploaded key, even when the bundle bytes are identical.
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

export async function uploadBundleBytes(config, bytes, filename) {
  return uploadProductBundle({
    endpoint: `${config.baseUrl}/k/v1/file.json`,
    zipBytes: bytes,
    filename,
    headers: { "X-Cybozu-API-Token": config.stateApiToken },
    fetch: globalThis.fetch,
  });
}

export async function downloadBundleBytes(config, fileKey) {
  return downloadProductBundle({
    endpoint: `${config.baseUrl}/k/v1/file.json`,
    fileKey,
    headers: { "X-Cybozu-API-Token": config.stateApiToken },
    fetch: globalThis.fetch,
  });
}

export async function updateRecordFields(config, target, record, fields) {
  const isState = target === "state";
  const app = isState ? config.stateAppId : config.auditAppId;
  const token = isState ? config.stateApiToken : config.auditApiToken;
  return rawRequest(config, app, token, "record", {
    method: "PUT",
    body: {
      app,
      id: String(record.$id.value),
      revision: String(record.$revision.value),
      record: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, { value }]),
      ),
    },
  });
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
    `network_id like "${escaped}"`,
    `profile like "${escaped}"`,
    `record_key like "${escaped}"`,
    `owner_invocation_id like "${escaped}"`,
    `status_reason like "${escaped}"`,
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

const M4_FIXTURE_FILES = {
  capabilities: "capabilities.json",
  describeProfile: "describe-profile.json",
  inspectJob: "inspect-job-deterministic.json",
};

export function m4CliSettings(environment = process.env) {
  const command = environment.KSQL_FLOW_BIN?.trim();
  const real = Boolean(command);
  const profile = environment.KSQL_FLOW_PROFILE?.trim() || "prod";
  const configPath = environment.KSQL_FLOW_CONFIG_PATH?.trim();
  if (real && !configPath) {
    throw new Error(
      "KSQL_FLOW_BIN 実CLIモードでは KSQL_FLOW_CONFIG_PATH が必要です。",
    );
  }
  return {
    real,
    profile,
    command: command || "fixture:ksql-flow",
    configPath: configPath || "fixture:config",
  };
}

export function createM4Executor(options = {}) {
  const settings = m4CliSettings(options.environment);
  const events = options.events ?? [];
  const names = { ...M4_FIXTURE_FILES, ...options.fixtures };
  const spawn = settings.real
    ? undefined
    : async ({ args }) => {
        const command = args[0];
        const fixtureKey =
          command === "capabilities"
            ? "capabilities"
            : command === "describe-profile"
              ? "describeProfile"
              : command === "inspect-job"
                ? "inspectJob"
                : null;
        if (fixtureKey === null) {
          return { exitCode: 2, stdout: "", stderr: "unknown fixture command" };
        }
        events.push({ command, mode: "fixture", fixture: names[fixtureKey] });
        const fixturePath = fileURLToPath(
          new URL(`../fixtures/executor/${names[fixtureKey]}`, import.meta.url),
        );
        return {
          exitCode: 0,
          stdout: await readFile(fixturePath, "utf8"),
          stderr: "",
        };
      };
  if (settings.real) events.push({ mode: "real", binary: settings.command });
  const cli = new KsqlFlowCli({
    command: settings.command,
    profile: settings.profile,
    configPath: settings.configPath,
    ...(spawn ? { spawn } : {}),
  });
  const transform = options.transform ?? {};
  return {
    executor: {
      async capabilities() {
        if (settings.real)
          events.push({ command: "capabilities", mode: "real" });
        const value = await cli.capabilities();
        return transform.capabilities?.(value) ?? value;
      },
      async describeProfile() {
        if (settings.real)
          events.push({ command: "describe-profile", mode: "real" });
        const value = await cli.describeProfile();
        return transform.describeProfile?.(value) ?? value;
      },
      async inspectJob(sqlPath) {
        if (settings.real)
          events.push({ command: "inspect-job", mode: "real" });
        const value = await cli.inspectJob(sqlPath);
        return transform.inspectJob?.(value) ?? value;
      },
    },
    settings: { real: settings.real, profile: settings.profile },
    events,
  };
}

export function createM4Harness(config, scope, fixture, options = {}) {
  const cliEvents = [];
  const bundleEvents = [];
  const lockEvents = [];
  const cli = createM4Executor({
    fixtures: options.fixtures,
    transform: options.transform,
    events: cliEvents,
  });
  return {
    profile: cli.settings.profile,
    repository: createRepository(config),
    executor: cli.executor,
    bundleStore: createM4BundleStore(config, bundleEvents),
    lockManager: createM4LockManager(
      config,
      scope,
      fixture.networkId,
      lockEvents,
    ),
    uuid: m4Uuid(scope),
    mode: cli.settings.real ? "real" : "fixture",
    observations: { cli: cliEvents, bundle: bundleEvents, lock: lockEvents },
  };
}

export function createM4BundleStore(config, observations = []) {
  return {
    async upload(bytes) {
      observations.push({ operation: "upload", byteLength: bytes.byteLength });
      return uploadBundleBytes(config, bytes, "execution-bundle.zip");
    },
    async download(fileKey) {
      const bytes = await downloadBundleBytes(config, fileKey);
      observations.push({
        operation: "download",
        fileKey,
        byteLength: bytes.byteLength,
      });
      return bytes;
    },
  };
}

export function createM4LockManager(
  config,
  scope,
  networkId,
  observations = [],
) {
  const manager = new NetworkLockManager({
    baseUrl: config.baseUrl,
    appId: config.stateAppId,
    apiToken: config.stateApiToken,
    profile: m4CliSettings().profile,
    networkId,
    ownerInvocationId: `${scope}_owner`,
    ownerInstanceId: `${scope}_instance`,
    leaseDurationSec: 30,
  });
  return {
    recordKey: manager.recordKey,
    async acquire() {
      observations.push({ operation: "acquire", recordKey: manager.recordKey });
      return manager.acquire();
    },
    async release(reference, status, resultCode) {
      observations.push({ operation: "release", status, resultCode });
      return manager.release(reference, status, resultCode);
    },
  };
}

export async function withM4Fixture(scope, options, test) {
  const directory = await mkdtemp(join(tmpdir(), "ksql-flownet-m4-"));
  const nodeId = options.nodeId ?? "aggregate";
  const jobId = options.jobId ?? "aggregate_customer";
  const networkId = options.networkId ?? `${scope}_network`;
  const sql =
    options.sql ?? "-- @ksql name: aggregate_customer\nSELECT $id FROM APP1;\n";
  const jobsDirectory = join(directory, "jobs");
  const sqlPath = join(jobsDirectory, `${nodeId}.sql`);
  const networkPath = join(directory, "network.yaml");
  await mkdir(jobsDirectory);
  await writeFile(sqlPath, sql, "utf8");
  await writeFile(
    networkPath,
    `schema_version: 1
network_id: ${networkId}
business_key_policy:
  type: explicit
max_active_runs: 1
network_lock:
  lease_duration_sec: 30
  heartbeat_interval_sec: 10
nodes:
  - id: ${nodeId}
    job_id: ${jobId}
    sql: jobs/${nodeId}.sql
    depends_on: []
    trigger_rule: all_success
    idempotent: true
`,
    "utf8",
  );
  try {
    return await test({
      directory,
      networkId,
      networkPath,
      nodeId,
      jobId,
      sql,
      sqlPath,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function m4Uuid(scope) {
  let sequence = 0;
  return () => `${scope}_${++sequence}`;
}

export function m4EnsureInput(fixture, harness, scope, overrides = {}) {
  return {
    networkPath: fixture.networkPath,
    profile: harness.profile,
    businessKey: `${scope}_business`,
    requestedBy: `${scope}_requester`,
    host: `${scope}_host`,
    repository: harness.repository,
    lockManager: harness.lockManager,
    executor: harness.executor,
    bundleStore: harness.bundleStore,
    uuid: harness.uuid,
    ...overrides,
  };
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
  const originalMessage = error?.message ?? String(error);
  const assertionObservation =
    error?.actual !== undefined || error?.expected !== undefined
      ? `; expected=${JSON.stringify(error?.expected)} actual=${JSON.stringify(error?.actual)}`
      : "";
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    status: error?.status ?? null,
    apiCode: error?.apiCode ?? null,
    message: `${originalMessage}${assertionObservation}`,
    ...(error?.actual !== undefined ? { actual: error.actual } : {}),
    ...(error?.expected !== undefined ? { expected: error.expected } : {}),
    ...(error?.operator !== undefined ? { operator: error.operator } : {}),
    ...(error?.causeDetail
      ? { cause: summarizeError(error.causeDetail) }
      : error?.cause
        ? { cause: summarizeError(error.cause) }
        : {}),
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
    assertIntegrationKeyLengths(scope);
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
