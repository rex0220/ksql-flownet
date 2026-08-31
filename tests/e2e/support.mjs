import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { networkLockKey } from "../../dist/domain/canonical-lock-key.js";
import { runKey } from "../../dist/domain/canonical-record-key.js";
import { ksqlFlowBinArgsEnvironment } from "../../dist/cli/run-network-command.js";
import { sanitize } from "../../spikes/lib/runtime.mjs";

export const M5_PREFIX = "M5";
export const M5_JOB_ID = "m5_shared_read";
export const M6_PREFIX = "M6";
export const M7_PREFIX = "M7";
export const M8_PREFIX = "M8";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FLOWNET_CLI = join(ROOT, "dist", "cli", "index.js");
const DEFAULT_CONFIG =
  "C:\\Users\\rex02\\Projects\\my-ksql-jobs\\ksql.config.json";
const DEFAULT_WORKDIR = join(tmpdir(), "ksql-flownet-m5-work");
const MAX_CAPTURE = 8_000;

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`必要な環境変数がありません: ${name}`);
  return value;
}

function positiveInteger(environment, name, fallback) {
  const source = environment[name]?.trim() || fallback;
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} は正の整数で指定してください。`);
  return value;
}

export function requireM5Environment(environment = process.env) {
  const baseUrl = new globalThis.URL(
    required(environment, "KSQL_SPIKE_BASE_URL"),
  );
  if (baseUrl.protocol !== "https:")
    throw new Error("KSQL_SPIKE_BASE_URL は https URLで指定してください。");
  const logAppId = positiveInteger(environment, "KSQL_E2E_LOG_APP_ID");
  assert.notEqual(logAppId, 4249, "E2Eは本番ログアプリ4249を使用できません");
  const profile = environment.KSQL_FLOWNET_PROFILE?.trim() || "e2e";
  assert.notEqual(profile, "prod", "E2Eはprodプロファイルを使用できません");
  const ksqlFlowBin = required(environment, "KSQL_FLOW_BIN");
  const ksqlFlowBinArgs = ksqlFlowBinArgsEnvironment(environment);
  return {
    baseUrl: baseUrl.href.replace(/\/$/u, ""),
    profile,
    stateAppId: positiveInteger(environment, "KSQL_SPIKE_APP_EXEC"),
    auditAppId: positiveInteger(environment, "KSQL_SPIKE_APP_AUDIT"),
    stateApiToken: required(environment, "KSQL_SPIKE_TOKEN_EXEC"),
    auditApiToken: required(environment, "KSQL_SPIKE_TOKEN_AUDIT"),
    jobLogAppId: logAppId,
    jobLogWriteToken: required(environment, "KSQL_E2E_TOKEN_LOGS"),
    jobLogReadToken: required(environment, "KSQL_E2E_TOKEN_LOGS_RO"),
    ksqlFlowBin,
    ksqlFlowBinArgs,
    configPath: resolve(
      environment.KSQL_FLOW_CONFIG?.trim() ||
        environment.KSQL_FLOW_CONFIG_PATH?.trim() ||
        DEFAULT_CONFIG,
    ),
    workdirBase: resolve(
      environment.KSQL_FLOW_WORKDIR?.trim() || DEFAULT_WORKDIR,
    ),
  };
}

export function makeM5Scope(label) {
  return makeScope(M5_PREFIX, label);
}

export function makeM6Scope(label) {
  return makeScope(M6_PREFIX, label);
}

export function makeM7Scope(label) {
  return makeScope(M7_PREFIX, label);
}

export function makeM8Scope(label) {
  return makeScope(M8_PREFIX, label);
}

function makeScope(prefix, label) {
  assert.match(label, /^[a-z0-9-]+$/u);
  const stamp = new Date().toISOString().slice(2, 19).replaceAll(/[-:T]/gu, "");
  return `${prefix}${stamp}_${randomUUID().slice(0, 4)}_${label}`;
}

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function kintoneRequest(settings, target, path, options = {}) {
  const isState = target === "state";
  const token = isState ? settings.stateApiToken : settings.auditApiToken;
  const url = new globalThis.URL(`/k/v1/${path}.json`, `${settings.baseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(key, String(value));
  const response = await globalThis.fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "X-Cybozu-API-Token": token,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `kintone ${options.method ?? "GET"} ${path} failed (${response.status})`,
    );
    error.status = response.status;
    error.apiCode = body?.code ?? null;
    throw error;
  }
  return body;
}

async function getPersistenceRecords(settings, target, query, exact = false) {
  const isState = target === "state";
  const app = isState ? settings.stateAppId : settings.auditAppId;
  const body = await kintoneRequest(settings, target, "records", {
    query: { app, query: exact ? query : `${query} limit 500` },
  });
  return body.records ?? [];
}

export async function getAllPersistenceRecords(settings, target, query = "") {
  const records = [];
  for (let offset = 0; ; offset += 500) {
    const page = await getPersistenceRecords(
      settings,
      target,
      `${query === "" ? "" : `${query} `}order by $id asc limit 500 offset ${offset}`,
      true,
    );
    records.push(...page);
    if (page.length < 500) return records;
  }
}

export async function getJobLogs(settings, query) {
  const url = new globalThis.URL("/k/v1/records.json", `${settings.baseUrl}/`);
  url.searchParams.set("app", String(settings.jobLogAppId));
  url.searchParams.set("query", `${query} limit 500`);
  const response = await globalThis.fetch(url, {
    headers: { "X-Cybozu-API-Token": settings.jobLogReadToken },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(`JOBログ読取に失敗しました (${response.status})`);
  return body.records ?? [];
}

export function field(record, name) {
  return record?.[name]?.value ?? null;
}

function numberField(record, name) {
  const value = Number(field(record, name));
  return Number.isFinite(value) ? value : null;
}

function jsonField(record, name) {
  const value = field(record, name);
  if (typeof value !== "string" || value === "") return [];
  return JSON.parse(value);
}

function decodeRun(record) {
  const resolvedProfileSnapshot = JSON.parse(
    field(record, "resolved_profile_snapshot") || "null",
  );
  return {
    recordKey: field(record, "record_key"),
    runId: field(record, "run_id"),
    networkId: field(record, "network_id"),
    businessKey: field(record, "business_key"),
    status: field(record, "status"),
    asOf: field(record, "as_of"),
    startedAt: field(record, "started_at"),
    finishedAt: field(record, "finished_at"),
    resolvedProfile: resolvedProfileSnapshot?.profile ?? null,
  };
}

export function describeRunIdentity(profile, networkId, businessKey) {
  return {
    profile,
    networkId,
    businessKey,
    r1Key: runKey(profile, networkId, businessKey),
  };
}

function decodeState(record) {
  return {
    nodeId: field(record, "node_id"),
    jobId: field(record, "job_id"),
    status: field(record, "status"),
    latestAttemptNo: numberField(record, "latest_attempt_no"),
    statusReason: field(record, "status_reason"),
    blockedBy: jsonField(record, "blocked_by"),
    startedAt: field(record, "started_at"),
    finishedAt: field(record, "finished_at"),
  };
}

function decodeAttempt(record) {
  return {
    recordId: numberField(record, "$id"),
    attemptId: field(record, "node_attempt_id"),
    nodeId: field(record, "node_id"),
    jobId: field(record, "job_id"),
    invocationId: field(record, "invocation_id"),
    attemptNo: numberField(record, "attempt_no"),
    status: field(record, "status"),
    resultCode: field(record, "result_code"),
    executionStartedAt: field(record, "execution_started_at"),
    runnerExecutionStartedAt: field(record, "runner_execution_started_at"),
    executionId: field(record, "execution_id"),
    finishedAt: field(record, "finished_at"),
    readCount: numberField(record, "read_count"),
    writtenCount: numberField(record, "written_count"),
  };
}

function decodeInvocation(record) {
  return {
    recordId: numberField(record, "$id"),
    invocationId: field(record, "invocation_id"),
    mode: field(record, "mode"),
    status: field(record, "status"),
    resultCode: field(record, "result_code"),
    selectedNodeIds: jsonField(record, "selected_node_ids"),
    preservedNodeIds: jsonField(record, "preserved_node_ids"),
    blockedNodeIds: jsonField(record, "blocked_node_ids"),
    startedAt: field(record, "started_at"),
    finishedAt: field(record, "finished_at"),
  };
}

function decodeResolution(record) {
  const detail = JSON.parse(field(record, "reason") || "{}");
  return {
    recordId: numberField(record, "$id"),
    attemptId: field(record, "attempt_id"),
    eventType: field(record, "event_type"),
    resolutionType: detail.resolution_type ?? null,
    resolvedOutcome: field(record, "resolved_outcome"),
    reason: detail.reason ?? null,
    evidenceRef: field(record, "evidence_ref"),
    servicePrincipal: field(record, "service_principal"),
    requestedBy: field(record, "requested_by"),
    approvedBy: field(record, "approved_by"),
    stopConfirmedBy: detail.stop_confirmed_by ?? null,
    stopEvidenceRef: detail.stop_evidence_ref ?? null,
    resolvedAt: field(record, "resolved_at"),
  };
}

export async function loadAttemptResolutions(settings, attemptIds) {
  const records = [];
  for (const group of chunks([...new Set(attemptIds)], 50)) {
    if (group.length === 0) continue;
    records.push(
      ...(await getPersistenceRecords(
        settings,
        "audit",
        `record_type in ("ATTEMPT_RESOLUTION") and attempt_id in (${group.map(quote).join(", ")}) order by $id asc`,
      )),
    );
  }
  return records.map(decodeResolution);
}

export async function loadNetworkForceReleaseAudits(settings, networkId) {
  const records = await getPersistenceRecords(
    settings,
    "audit",
    'record_type in ("OPERATION_AUDIT") and result_code in ("NETWORK_LOCK_FORCE_RELEASED") order by $id asc',
  );
  return records
    .map((record) => {
      const value = JSON.parse(field(record, "reason") || "null");
      if (value?.network_id !== networkId) return null;
      return {
        recordId: numberField(record, "$id"),
        eventType: value.event_type,
        networkId: value.network_id,
        profile: value.profile,
        previousOwnerInvocationId: value.previous_owner_invocation_id,
        servicePrincipal: value.service_principal,
        requestedBy: value.requested_by,
        stopConfirmedBy: value.stop_confirmed_by,
        stopMethod: value.stop_method,
        stopEvidenceRef: value.stop_evidence_ref,
        reason: value.reason,
        evidenceRef: value.evidence_ref,
        releasedAt: value.released_at,
        postReleaseRevision: value.post_release_revision,
      };
    })
    .filter(Boolean);
}

export async function snapshotPersistenceRevisions(settings) {
  const snapshot = {};
  for (const target of ["state", "audit"]) {
    const records = await getAllPersistenceRecords(settings, target);
    snapshot[target] = Object.fromEntries(
      records.map((record) => [
        field(record, "$id"),
        field(record, "$revision"),
      ]),
    );
  }
  return snapshot;
}

export async function loadRunGraph(settings, businessKey) {
  const runRecords = await getPersistenceRecords(
    settings,
    "state",
    `record_type in ("NETWORK_RUN") and business_key = ${quote(businessKey)} order by created_at desc`,
  );
  assert.equal(
    runRecords.length,
    1,
    "business_keyに対応するRunは1件であること",
  );
  const run = decodeRun(runRecords[0]);
  const stateRecords = await getPersistenceRecords(
    settings,
    "state",
    `record_type in ("NODE_STATE") and run_id = ${quote(run.runId)} order by node_id asc`,
  );
  const auditRecords = await getPersistenceRecords(
    settings,
    "audit",
    `run_id = ${quote(run.runId)} order by $id asc`,
  );
  return {
    run,
    states: stateRecords.map(decodeState),
    attempts: auditRecords
      .filter((record) => field(record, "record_type") === "NODE_ATTEMPT")
      .map(decodeAttempt)
      .toSorted(
        (left, right) =>
          left.attemptNo - right.attemptNo || left.recordId - right.recordId,
      ),
    invocations: auditRecords
      .filter((record) => field(record, "record_type") === "RUN_INVOCATION")
      .map(decodeInvocation)
      .toSorted((left, right) => left.recordId - right.recordId),
  };
}

export async function prepareNetwork(scope, fixtureName, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ksql-flownet-m5-"));
  const source = join(FIXTURES, fixtureName);
  let yaml = await readFile(source, "utf8");
  const networkId = `${scope}_${basename(fixtureName, ".yaml").replace("network-", "")}`;
  yaml = yaml.replace(/^network_id:\s*\S+/mu, `network_id: ${networkId}`);
  if (options.longReadNodeId) {
    const nodePattern = new RegExp(
      `(  - id: ${options.longReadNodeId}\\r?\\n(?:    .*\\r?\\n)*?    sql:) [^\\r\\n]+`,
      "u",
    );
    yaml = yaml.replace(nodePattern, "$1 job-longread.sql");
  }
  await cp(join(FIXTURES, "jobs"), join(directory, "jobs"), {
    recursive: true,
  });
  await cp(
    join(FIXTURES, "job-longread.sql"),
    join(directory, "job-longread.sql"),
  );
  const networkPath = join(directory, fixtureName);
  await writeFile(networkPath, yaml, "utf8");
  return {
    directory,
    networkPath,
    networkId,
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function childEnvironment(settings, overrides = {}) {
  return {
    ...process.env,
    KSQL_FLOWNET_PROFILE: settings.profile,
    KSQL_FLOWNET_BASE_URL: settings.baseUrl,
    KSQL_FLOWNET_STATE_APP_ID: String(settings.stateAppId),
    KSQL_FLOWNET_AUDIT_APP_ID: String(settings.auditAppId),
    KSQL_FLOWNET_STATE_API_TOKEN: settings.stateApiToken,
    KSQL_FLOWNET_AUDIT_API_TOKEN: settings.auditApiToken,
    KSQL_FLOW_BIN: settings.ksqlFlowBin,
    KSQL_FLOW_BIN_ARGS: JSON.stringify(settings.ksqlFlowBinArgs),
    KSQL_FLOW_CONFIG: settings.configPath,
    KSQL_FLOW_WORKDIR: settings.workdir,
    KSQL_FLOW_LOG_APP_ID: String(settings.jobLogAppId),
    KSQL_FLOW_LOG_API_TOKEN: settings.jobLogReadToken,
    KSQL_E2E_TOKEN_LOGS: settings.jobLogWriteToken,
    KSQL_FLOWNET_SERVICE_PRINCIPAL:
      settings.servicePrincipal ?? "m6-e2e-service",
    KSQL_FLOWNET_REQUESTED_BY: settings.requestedBy ?? "m6-e2e-requester",
    ...overrides,
  };
}

export function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const completion = new Promise((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolveCompletion({
        exitCode,
        signal,
        stdout: stdout.slice(-MAX_CAPTURE),
        stderr: stderr.slice(-MAX_CAPTURE),
      }),
    );
  });
  return { child, completion };
}

export async function startFlowNetNetwork(
  settings,
  networkPath,
  businessKey,
  options = {},
) {
  await mkdir(settings.workdir, { recursive: true });
  const args = [
    FLOWNET_CLI,
    "run-network",
    networkPath,
    ...(options.resume ? ["--resume"] : []),
    ...(options.resumeRun === undefined
      ? ["--business-key", businessKey]
      : ["--resume-run", options.resumeRun]),
  ];
  return startProcess(process.execPath, args, {
    cwd: ROOT,
    env: childEnvironment(settings, options.environment),
  });
}

export async function runFlowNetCommand(settings, args, options = {}) {
  return startProcess(process.execPath, [FLOWNET_CLI, ...args], {
    cwd: ROOT,
    env: childEnvironment(settings, options.environment),
  }).completion;
}

export async function runFlowNetStatus(settings, networkId, selector = {}) {
  const processResult = await runFlowNetCommand(settings, [
    "status",
    networkId,
    "--profile",
    settings.profile,
    ...(selector.runId === undefined ? [] : ["--run-id", selector.runId]),
    ...(selector.businessKey === undefined
      ? []
      : ["--business-key", selector.businessKey]),
    ...(selector.json === false ? [] : ["--json"]),
  ]);
  assert.equal(
    processResult.exitCode,
    0,
    processResult.stderr || processResult.stdout,
  );
  return {
    process: processResult,
    output: selector.json === false ? null : JSON.parse(processResult.stdout),
  };
}

export async function runFlowNetNetwork(
  settings,
  networkPath,
  businessKey,
  options = {},
) {
  const processHandle = await startFlowNetNetwork(
    settings,
    networkPath,
    businessKey,
    options,
  );
  return processHandle.completion;
}

export async function startStandaloneLongRead(settings, scope) {
  await mkdir(settings.workdir, { recursive: true });
  const standaloneCwd = join(settings.workdir, "standalone-cwd");
  await mkdir(standaloneCwd, { recursive: true });
  assertDistinctProcessCwds(ROOT, standaloneCwd);
  const attemptId = `${scope}_standalone`;
  const correlationId = `${scope}_holder`;
  const resultJson = join(settings.workdir, `${attemptId}-result.json`);
  const args = [
    ...settings.ksqlFlowBinArgs,
    "run",
    "-f",
    join(FIXTURES, "job-longread.sql"),
    "--profile",
    settings.profile,
    "--config",
    settings.configPath,
    "--result-json",
    resultJson,
    "--correlation-id",
    correlationId,
    "--attempt-id",
    attemptId,
    "--expected-job-id",
    M5_JOB_ID,
  ];
  const handle = startProcess(settings.ksqlFlowBin, args, {
    cwd: standaloneCwd,
    env: process.env,
  });
  return {
    ...handle,
    attemptId,
    correlationId,
    resultJson,
    cwd: standaloneCwd,
    flowNetCwd: ROOT,
  };
}

export function assertDistinctProcessCwds(flowNetCwd, standaloneCwd) {
  assert.notEqual(
    resolve(flowNetCwd).toLowerCase(),
    resolve(standaloneCwd).toLowerCase(),
    "分散ロック競合試験の2プロセスは異なるcwdから起動すること",
  );
}

export async function waitFor(predicate, description, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) =>
      globalThis.setTimeout(resolveWait, intervalMs),
    );
  }
  throw new Error(
    `${description}を${timeoutMs}ms以内に確認できませんでした${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export async function waitForRunningJobLog(
  settings,
  attemptId,
  expectedJobId = M5_JOB_ID,
) {
  return waitFor(async () => {
    const records = await getJobLogs(
      settings,
      `attempt_id = ${quote(attemptId)} and job_id = ${quote(expectedJobId)} and status in ("RUNNING") order by $id asc`,
    );
    return records[0] ?? null;
  }, `JOBログ RUNNING (${expectedJobId}, ${attemptId})`);
}

export async function requireRunningJobLog(
  settings,
  attemptId,
  phase,
  expectedJobId = M5_JOB_ID,
) {
  const records = await getJobLogs(
    settings,
    `attempt_id = ${quote(attemptId)} and job_id = ${quote(expectedJobId)} order by $id asc`,
  );
  const running = records.find(
    (record) => field(record, "status") === "RUNNING",
  );
  if (running) return running;
  const matches = records.map(summarizeJobLog);
  const error = new Error(
    `競合窓不足: ${phase}にstandalone JOBのRUNNING継続を確認できませんでした (${expectedJobId}, ${attemptId}); matches=${JSON.stringify(matches)}`,
  );
  error.code = "M5_LOCK_WINDOW_INSUFFICIENT";
  error.jobLogMatches = matches;
  throw error;
}

function parseMachineJson(stdout, expectedKind) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value?.kind === expectedKind) return value;
    } catch {
      // kSQL-Flowの補助出力が混在しても、対象kindのJSON行を探索する。
    }
  }
  throw new Error(`${expectedKind} がkSQL-Flow標準出力にありません。`);
}

async function runKsqlFlowJson(settings, args, expectedKind) {
  const processResult = await startProcess(
    settings.ksqlFlowBin,
    [...settings.ksqlFlowBinArgs, ...args],
    {
      cwd: ROOT,
      env: process.env,
    },
  ).completion;
  const output = parseMachineJson(processResult.stdout, expectedKind);
  return { process: processResult, output };
}

export function m5ConfirmedBy(
  environment = process.env,
  argv = process.argv.slice(2),
) {
  const flagIndex = argv.indexOf("--confirmed-by");
  const argumentValue =
    flagIndex === -1 ? "" : (argv[flagIndex + 1]?.trim() ?? "");
  const value =
    argumentValue || environment.M5_FORCE_UNLOCK_CONFIRMED_BY?.trim() || "";
  if (!value) {
    throw new Error(
      "kill試験には --confirmed-by <実行者> または M5_FORCE_UNLOCK_CONFIRMED_BY が必要です。",
    );
  }
  return value;
}

export async function recoverM5JobLock(settings, evidenceRef, confirmedBy) {
  return recoverJobLock(
    settings,
    M5_JOB_ID,
    evidenceRef,
    confirmedBy,
    "M5 kill試験の後始末",
  );
}

export async function recoverJobLock(
  settings,
  jobId,
  evidenceRef,
  confirmedBy,
  reason = "FlowNet E2E kill試験の後始末",
) {
  const jobKey = `${settings.profile}:${jobId}`;
  const commonArgs = [
    "--job-key",
    jobKey,
    "--profile",
    settings.profile,
    "--config",
    settings.configPath,
    "--json",
  ];
  const inspection = await runKsqlFlowJson(
    settings,
    ["inspect-lock", ...commonArgs],
    "LOCK_INSPECTION_RESULT",
  );
  assert.equal(
    inspection.process.exitCode,
    0,
    inspection.process.stderr || inspection.process.stdout,
  );
  assert.notEqual(
    inspection.output.locked,
    null,
    "inspect-lockでロック状態を確認できること",
  );
  if (!inspection.output.locked) {
    return { jobKey, inspection, lockRecoveryResult: null };
  }

  const recovery = await runKsqlFlowJson(
    settings,
    [
      "force-unlock-job",
      ...commonArgs.slice(0, -1),
      "--reason",
      reason,
      "--confirmed-by",
      confirmedBy,
      "--evidence-ref",
      evidenceRef,
      "--json",
    ],
    "LOCK_RECOVERY_RESULT",
  );
  return {
    jobKey,
    inspection,
    lockRecoveryResult: recovery.output,
    recoveryProcess: recovery.process,
  };
}

export async function waitForRunGraph(settings, businessKey, predicate) {
  return waitFor(async () => {
    const graph = await loadRunGraph(settings, businessKey).catch(() => null);
    return graph && predicate(graph) ? graph : null;
  }, `FlowNet Run状態 (${businessKey})`);
}

export function resolveKsqlFlowCliPath(binArgs) {
  const matches = binArgs
    .filter((argument) => /(?:^|[\\/])dist[\\/]cli\.js$/iu.test(argument))
    .map((argument) => resolve(argument));
  assert.equal(
    matches.length,
    1,
    `KSQL_FLOW_BIN_ARGSからkSQL-Flowのdist\\cli.jsフルパスを1件特定できません: matches=${JSON.stringify(matches)}`,
  );
  return matches[0];
}

function powershellLiteral(value) {
  return String(value).replaceAll("'", "''");
}

async function findKsqlFlowScopeProcesses(scope, ksqlFlowCliPath, attemptId) {
  if (process.platform !== "win32")
    throw new Error("m5-kill-unknown is currently a Windows real-device test");
  const escapedScope = powershellLiteral(scope);
  const escapedCliPath = powershellLiteral(resolve(ksqlFlowCliPath));
  const escapedAttemptId = powershellLiteral(attemptId ?? "");
  const command = [
    `$scope = '${escapedScope}'`,
    `$cliPath = '${escapedCliPath}'`,
    `$attemptId = '${escapedAttemptId}'`,
    `$target = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($cliPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf($scope, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and ($attemptId.Length -eq 0 -or $_.CommandLine -like ('*--attempt-id*' + $attemptId + '*')) -and $_.ProcessId -ne $PID })`,
    `$items = @($target | ForEach-Object { [pscustomobject]@{ processId = $_.ProcessId; parentProcessId = $_.ParentProcessId; commandLine = $_.CommandLine } })`,
    `ConvertTo-Json -InputObject $items -Compress`,
  ].join("; ");
  const result = await startProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { env: process.env },
  ).completion;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = result.stdout.trim();
  return output === "" ? [] : JSON.parse(output);
}

export async function assertNoKsqlFlowScopeProcess(scope, ksqlFlowCliPath) {
  const matches = await findKsqlFlowScopeProcesses(scope, ksqlFlowCliPath);
  assert.deepEqual(
    matches,
    [],
    `開始前に同一scopeのkSQL-Flowプロセスが残存しています: scope=${scope}; matches=${JSON.stringify(matches)}`,
  );
}

export function resolveProcessTreeRootId(matches, description = "processes") {
  assert.ok(
    matches.length >= 1,
    `expected one process tree for ${description}, found ${matches.length}; matches=${JSON.stringify(matches)}`,
  );
  const processIds = new Set(matches.map(({ processId }) => Number(processId)));
  const roots = matches.filter(
    ({ parentProcessId }) => !processIds.has(Number(parentProcessId)),
  );
  assert.equal(
    roots.length,
    1,
    `expected matches for ${description} to form one process tree, found ${roots.length} roots; matches=${JSON.stringify(matches)}`,
  );
  return Number(roots[0].processId);
}

export async function killKsqlFlowAttempt(attemptId, ksqlFlowCliPath, scope) {
  const matches = await findKsqlFlowScopeProcesses(
    scope,
    ksqlFlowCliPath,
    attemptId,
  );
  const rootProcessId = resolveProcessTreeRootId(
    matches,
    `kSQL-Flow cliPath=${resolve(ksqlFlowCliPath)} and scope=${scope}`,
  );
  // taskkill /T はWindowsで "operation not supported" を返すことがある(実測)。
  // 列挙済みのツリーPIDを子→親の順で直接TerminateProcessする。
  const byDepth = [...matches].sort(
    (a, b) => Number(b.processId) - Number(a.processId),
  );
  const killErrors = [];
  for (const { processId } of byDepth) {
    try {
      process.kill(Number(processId), "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        killErrors.push({ processId, error: error.code ?? error.message });
      }
    }
  }
  assert.deepEqual(killErrors, [], "process tree kill failed");
  return rootProcessId;
}

export async function enumerateProcessTree(rootProcessId) {
  if (process.platform !== "win32")
    throw new Error(
      "M6 process-tree drill is currently a Windows real-device test",
    );
  assert.ok(Number.isSafeInteger(rootProcessId) && rootProcessId > 0);
  const command = [
    `$rootId = ${rootProcessId}`,
    "$all = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\")",
    "$selected = New-Object System.Collections.Generic.List[object]",
    "$frontier = @($rootId)",
    "$depth = 0",
    "while ($frontier.Count -gt 0) { $next = @(); foreach ($id in $frontier) { $process = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1; if ($process) { $selected.Add([pscustomobject]@{ processId = $process.ProcessId; parentProcessId = $process.ParentProcessId; depth = $depth }); $next += @($all | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { $_.ProcessId }) } }; $frontier = @($next); $depth += 1 }",
    "ConvertTo-Json -InputObject @($selected.ToArray()) -Compress",
  ].join("; ");
  const result = await startProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { env: process.env },
  ).completion;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const matches = result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
  assert.ok(
    matches.some(({ processId }) => Number(processId) === rootProcessId),
    `FlowNet root PID ${rootProcessId} is no longer running`,
  );
  return matches.map(({ processId, parentProcessId, depth }) => ({
    processId: Number(processId),
    parentProcessId: Number(parentProcessId),
    depth: Number(depth),
  }));
}

export function killProcessList(processes) {
  const killErrors = [];
  for (const { processId } of [...processes].sort(
    (left, right) => right.depth - left.depth,
  )) {
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH")
        killErrors.push({ processId, error: error.code ?? error.message });
    }
  }
  assert.deepEqual(killErrors, [], "FlowNet process tree kill failed");
  return processes;
}

export async function killProcessTree(rootProcessId) {
  return killProcessList(await enumerateProcessTree(rootProcessId));
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

async function deleteRecords(settings, target, records) {
  let deleted = 0;
  for (const group of chunks(records, 100)) {
    const isState = target === "state";
    const app = isState ? settings.stateAppId : settings.auditAppId;
    await kintoneRequest(settings, target, "records", {
      method: "DELETE",
      body: {
        app,
        ids: group.map((record) => String(field(record, "$id"))),
        revisions: group.map((record) => String(field(record, "$revision"))),
      },
    });
    deleted += group.length;
  }
  return deleted;
}

export async function cleanupM5Records(settings, prefix = M5_PREFIX) {
  const runRecords = await getPersistenceRecords(
    settings,
    "state",
    `record_type in ("NETWORK_RUN") and (business_key like ${quote(prefix)} or network_id like ${quote(prefix)})`,
  );
  const runIds = [
    ...new Set(runRecords.map((record) => field(record, "run_id"))),
  ];
  const networkIds = [
    ...new Set(runRecords.map((record) => field(record, "network_id"))),
  ];
  let stateRecords = [];
  let auditRecords = [];
  for (const group of chunks(runIds, 50)) {
    const values = group.map(quote).join(", ");
    stateRecords.push(
      ...(await getPersistenceRecords(
        settings,
        "state",
        `run_id in (${values})`,
      )),
    );
    auditRecords.push(
      ...(await getPersistenceRecords(
        settings,
        "audit",
        `run_id in (${values})`,
      )),
    );
  }
  const lockKeys = networkIds.map((networkId) =>
    networkLockKey(settings.profile, networkId),
  );
  for (const group of chunks(lockKeys, 50)) {
    if (group.length === 0) continue;
    const values = group.map(quote).join(", ");
    stateRecords.push(
      ...(await getPersistenceRecords(
        settings,
        "state",
        `record_type in ("NETWORK_LOCK") and lock_key in (${values})`,
      )),
    );
  }
  const operationAudits = await getPersistenceRecords(
    settings,
    "audit",
    'record_type in ("OPERATION_AUDIT") and result_code in ("NETWORK_LOCK_FORCE_RELEASED") order by $id asc',
  );
  auditRecords.push(
    ...operationAudits.filter((record) => {
      try {
        const value = JSON.parse(field(record, "reason") || "null");
        return String(value?.network_id ?? "").startsWith(prefix);
      } catch {
        return false;
      }
    }),
  );
  stateRecords = [
    ...new Map(
      stateRecords.map((record) => [field(record, "$id"), record]),
    ).values(),
  ];
  auditRecords = [
    ...new Map(
      auditRecords.map((record) => [field(record, "$id"), record]),
    ).values(),
  ];
  const audit = await deleteRecords(settings, "audit", auditRecords);
  const state = await deleteRecords(settings, "state", stateRecords);
  return { prefix, runIds, networkIds, state, audit, total: state + audit };
}

export async function cleanupM5Workdirs(workdirBase, prefix = M5_PREFIX) {
  const entries = await readdir(workdirBase, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    },
  );
  const targets = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(prefix),
  );
  for (const entry of targets)
    await rm(join(workdirBase, entry.name), { recursive: true, force: true });
  return targets.map((entry) => entry.name);
}

export function byNode(values) {
  return new Map(values.map((value) => [value.nodeId, value]));
}

export function summarizeJobLog(record) {
  return {
    recordId: field(record, "$id"),
    correlationId: field(record, "correlation_id"),
    attemptId: field(record, "attempt_id"),
    executionId: field(record, "execution_id"),
    jobId: field(record, "job_id"),
    status: field(record, "status"),
    runnerExecutionStartedAt: field(record, "runner_execution_started_at"),
    finishedAt: field(record, "finished_at"),
  };
}

function summarizeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    status: error?.status ?? null,
    apiCode: error?.apiCode ?? null,
    message: error?.message ?? String(error),
    ...(error?.actual === undefined ? {} : { actual: error.actual }),
    ...(error?.expected === undefined ? {} : { expected: error.expected }),
    ...(error?.jobLogMatches === undefined
      ? {}
      : { jobLogMatches: error.jobLogMatches }),
    ...(error?.timingDiagnostics === undefined
      ? {}
      : { timingDiagnostics: error.timingDiagnostics }),
    ...(error?.lockRecovery === undefined
      ? {}
      : { lockRecovery: error.lockRecovery }),
    ...(error?.resumeDiagnostics === undefined
      ? {}
      : { resumeDiagnostics: error.resumeDiagnostics }),
    ...(error?.lockConflictDiagnostics === undefined
      ? {}
      : { lockConflictDiagnostics: error.lockConflictDiagnostics }),
  };
}

export function createM5Timing(now = () => new Date()) {
  const events = {};
  const eventMilliseconds = new Map();
  const intervalsMs = {};
  return {
    mark(name) {
      assert.equal(
        events[name],
        undefined,
        `timing event '${name}' is duplicate`,
      );
      const value = now();
      assert.ok(value instanceof Date && Number.isFinite(value.getTime()));
      events[name] = value.toISOString();
      eventMilliseconds.set(name, value.getTime());
      return events[name];
    },
    measure(name, startEvent, endEvent) {
      const start = eventMilliseconds.get(startEvent);
      const end = eventMilliseconds.get(endEvent);
      assert.notEqual(
        start,
        undefined,
        `timing event '${startEvent}' is missing`,
      );
      assert.notEqual(end, undefined, `timing event '${endEvent}' is missing`);
      intervalsMs[name] = Math.max(0, end - start);
      return intervalsMs[name];
    },
    snapshot() {
      return {
        events: { ...events },
        intervalsMs: { ...intervalsMs },
      };
    },
  };
}

async function allocateResultPath(importMetaUrl) {
  const directory = join(dirname(fileURLToPath(importMetaUrl)), "results");
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const name = basename(fileURLToPath(importMetaUrl), ".mjs");
  return join(directory, `${stamp}-${name}.json`);
}

async function writeResult(path, result) {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /TOKEN|SECRET|PASSWORD/iu.test(name) && value)
    .map(([, value]) => value);
  const safe = sanitize(result, secrets);
  const serialized = `${JSON.stringify(safe, null, 2)}\n`;
  for (const secret of secrets)
    if (serialized.includes(secret))
      throw new Error("結果JSONにsecret値が含まれるため保存を中止しました。");
  if (/"(?:authorization|[^"\n]*token[^"\n]*)"\s*:/iu.test(serialized))
    throw new Error("結果JSONに秘密フィールドが含まれています。");
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
  return path;
}

export async function runM5(importMetaUrl, name, test, options = {}) {
  return runGate(importMetaUrl, name, test, {
    ...options,
    prefix: M5_PREFIX,
  });
}

export async function runM6(importMetaUrl, name, test, options = {}) {
  return runGate(importMetaUrl, name, test, {
    ...options,
    prefix: M6_PREFIX,
  });
}

export async function runM7(importMetaUrl, name, test, options = {}) {
  return runGate(importMetaUrl, name, test, {
    ...options,
    prefix: M7_PREFIX,
  });
}

export async function runM8(importMetaUrl, name, test, options = {}) {
  return runGate(importMetaUrl, name, test, {
    ...options,
    prefix: M8_PREFIX,
  });
}

async function runGate(importMetaUrl, name, test, options) {
  const timing = createM5Timing();
  timing.mark("testStartedAt");
  const scope = makeScope(options.prefix, name);
  const resultPath = await allocateResultPath(importMetaUrl);
  const evidenceRef = pathToFileURL(resultPath).href;
  let settings;
  let detail;
  let cleanup = null;
  let passed = false;
  try {
    const baseSettings = requireM5Environment();
    settings = {
      ...baseSettings,
      workdir: join(baseSettings.workdirBase, scope),
      ...([M6_PREFIX, M7_PREFIX, M8_PREFIX].includes(options.prefix)
        ? {
            servicePrincipal: `${options.prefix.toLowerCase()}-e2e-service`,
            requestedBy: `${options.prefix.toLowerCase()}-e2e-requester`,
          }
        : {}),
    };
    timing.mark("scenarioStartedAt");
    detail = await test({
      settings,
      scope,
      resultPath,
      evidenceRef,
      timing,
    });
    timing.mark("scenarioFinishedAt");
    timing.measure("scenarioMs", "scenarioStartedAt", "scenarioFinishedAt");
    passed = true;
  } catch (error) {
    if (timing.snapshot().events.scenarioStartedAt !== undefined) {
      timing.mark("scenarioFailedAt");
      timing.measure("scenarioMs", "scenarioStartedAt", "scenarioFailedAt");
    }
    detail = { error: summarizeError(error) };
  } finally {
    if (settings && options.selfCleanup !== false) {
      timing.mark("cleanupStartedAt");
      try {
        cleanup = await cleanupM5Records(settings, scope);
      } catch (error) {
        cleanup = { error: summarizeError(error) };
        passed = false;
      }
      try {
        await rm(settings.workdir, { recursive: true, force: true });
      } catch (error) {
        cleanup = {
          ...(cleanup ?? {}),
          localWorkdirError: summarizeError(error),
        };
        passed = false;
      }
      timing.mark("cleanupFinishedAt");
      timing.measure("cleanupMs", "cleanupStartedAt", "cleanupFinishedAt");
    }
  }
  timing.mark("resultAssembledAt");
  timing.measure("totalMs", "testStartedAt", "resultAssembledAt");
  const result = {
    test: name,
    passed,
    scope,
    observedAt: new Date().toISOString(),
    nodeVersion: process.version,
    timing: timing.snapshot(),
    detail,
    cleanup,
  };
  let path;
  try {
    path = await writeResult(resultPath, result);
  } catch (error) {
    globalThis.console.error(`結果JSON保存失敗: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  globalThis.console[passed ? "log" : "error"](
    `${passed ? "合格" : "不合格"}: ${name}`,
  );
  globalThis.console.log(`詳細JSON: ${path}`);
  process.exitCode = passed ? 0 : 1;
}
