import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  field,
  getAllPersistenceRecords,
  runE2EGate,
  runFlowNetNetwork,
} from "./support.mjs";
import {
  P2_01_PREFIX,
  prepareP201Network,
  requireP201Environment,
} from "./p2-01-support.mjs";

export const CSV1_PREFIX = P2_01_PREFIX;
export const CSV1_KEY_FIELD = "test_key";
export const CSV1_VALUE_FIELD = "test_value";
export const CSV1_APP_NAME = "KSQL_FLOW_TEST_CSV1";
export const CSV1_NODE = "import_csv";
export const PRIVATE_CELL = "CSV1_PRIVATE_CELL_DO_NOT_AUDIT";

const FAULT_HOOK = fileURLToPath(
  new globalThis.URL("csv1-subprocess-hook.mjs", import.meta.url),
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

export function requireCsv1Environment(
  baseSettings,
  environment = process.env,
) {
  const settings = requireP201Environment(baseSettings, environment);
  const targetAppId = positiveInteger(environment, "KSQL_CSV1_TARGET_APP_ID");
  const targetApiToken = required(environment, "KSQL_CSV1_TARGET_API_TOKEN");
  for (const [name, id] of [
    ["state", settings.stateAppId],
    ["audit", settings.auditAppId],
    ["JOB log", settings.jobLogAppId],
    ["request", settings.requestAppId],
  ])
    assert.notEqual(
      targetAppId,
      id,
      `CSV1書込先は${name}アプリと分離してください`,
    );
  for (const [name, token] of [
    ["state", settings.stateApiToken],
    ["audit", settings.auditApiToken],
    ["JOB log write", settings.jobLogWriteToken],
    ["JOB log read", settings.jobLogReadToken],
    ["request write", settings.requestApiToken],
    ["request read", settings.requestReadToken],
  ])
    assert.notEqual(
      targetApiToken,
      token,
      `CSV1書込tokenは${name} tokenと分離してください`,
    );

  const ioBase = resolve(required(environment, "KSQL_FLOWNET_IO_DIR"));
  assert.ok(
    isAbsolute(ioBase),
    "KSQL_FLOWNET_IO_DIR は絶対pathで指定してください",
  );
  return { ...settings, targetAppId, targetApiToken, ioBase };
}

export async function runCsv1(importMetaUrl, name, test) {
  return runE2EGate(
    importMetaUrl,
    name,
    async (context) =>
      test({
        ...context,
        settings: requireCsv1Environment(context.settings),
      }),
    { prefix: CSV1_PREFIX },
  );
}

export async function createIoRoot(settings, scope) {
  const info = await stat(settings.ioBase);
  assert.ok(
    info.isDirectory(),
    "KSQL_FLOWNET_IO_DIR は既存directoryにしてください",
  );
  const root = await mkdtemp(join(settings.ioBase, `${scope}_`));
  await Promise.all([mkdir(join(root, "in")), mkdir(join(root, "out"))]);
  return {
    root,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function prepareCsv1Fixture(settings, scope, options = {}) {
  const encoding = options.encoding ?? "UTF8";
  assert.ok(["UTF8", "SJIS"].includes(encoding));
  const fixture = await prepareP201Network(scope, "network-csv1-import.yaml");
  const sqlPath = join(fixture.directory, "jobs", "csv1-import.sql");
  const sql = await readFile(sqlPath, "utf8");
  await writeFile(sqlPath, sql.replace("__CSV1_ENCODING__", encoding), "utf8");
  const configPath = await createFixtureConfig(settings, fixture.directory);
  return { ...fixture, configPath, encoding };
}

export async function prepareCsv1Case(settings, scope, options = {}) {
  let fixture;
  let io;
  try {
    fixture = await prepareCsv1Fixture(settings, scope, options);
    io = await createIoRoot(settings, scope);
    return {
      fixture,
      ioRoot: io.root,
      async dispose() {
        await Promise.all([fixture.dispose(), io.dispose()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([
      ...(fixture ? [fixture.dispose()] : []),
      ...(io ? [io.dispose()] : []),
    ]);
    throw error;
  }
}

export async function createFixtureConfig(settings, directory) {
  const config = JSON.parse(await readFile(settings.configPath, "utf8"));
  const profile = config.profiles?.[settings.profile];
  assert.ok(
    profile && typeof profile === "object",
    "E2E profileがconfigにありません",
  );
  profile.apps ??= {};
  for (const [name, app] of Object.entries(profile.apps)) {
    if (name !== CSV1_APP_NAME)
      assert.notEqual(
        Number(app?.id),
        settings.targetAppId,
        `CSV1専用アプリIDが既存logical app ${name} と重複しています`,
      );
  }
  profile.apps[CSV1_APP_NAME] = {
    id: settings.targetAppId,
    tokens: ["env:KSQL_CSV1_TARGET_API_TOKEN"],
  };
  const path = join(directory, "ksql.config.csv1.json");
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

export function csvPath(ioRoot, businessKey, profile) {
  return join(
    ioRoot,
    "in",
    "csv1",
    encodeURIComponent(businessKey),
    encodeURIComponent(profile),
    "input.csv",
  );
}

export function csvRows(scope, count, options = {}) {
  const value = options.value ?? PRIVATE_CELL;
  const recordScope = `${CSV1_PREFIX}${createHash("sha256")
    .update(scope)
    .digest("hex")
    .slice(0, 12)}`;
  return Array.from({ length: count }, (_, index) => ({
    key: `${recordScope}_${String(index + 1).padStart(5, "0")}`,
    value: `${value}_${String(index + 1).padStart(5, "0")}`,
  }));
}

export async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const lines = [
    `${CSV1_KEY_FIELD},${CSV1_VALUE_FIELD}`,
    ...rows.map(({ key, value }) => `${csvCell(key)},${csvCell(value)}`),
  ];
  const bytes = Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
  await writeFile(path, bytes);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rows: rows.length,
  };
}

function csvCell(value) {
  const source = String(value);
  return /[",\r\n]/u.test(source)
    ? `"${source.replaceAll('"', '""')}"`
    : source;
}

export function subprocessEnvironment(settings, ioRoot, options = {}) {
  const inherited = process.env.NODE_OPTIONS?.trim() ?? "";
  const useHook = options.failAfterTargetWrites || options.memoryFile;
  return {
    ...(options.environment ?? {}),
    KSQL_FLOWNET_IO_DIR: ioRoot,
    KSQL_CSV1_TARGET_API_TOKEN: settings.targetApiToken,
    ...(useHook
      ? {
          NODE_OPTIONS: [
            inherited,
            `--import=${pathToFileURL(FAULT_HOOK).href}`,
          ]
            .filter(Boolean)
            .join(" "),
          CSV1_HOOK_TARGET_APP_ID: String(settings.targetAppId),
          ...(options.failAfterTargetWrites
            ? {
                CSV1_HOOK_FAIL_AFTER_TARGET_WRITES: String(
                  options.failAfterTargetWrites,
                ),
              }
            : {}),
          ...(options.memoryFile
            ? { CSV1_HOOK_MEMORY_FILE: options.memoryFile }
            : {}),
        }
      : {}),
  };
}

export async function runFixture(
  settings,
  fixture,
  businessKey,
  ioRoot,
  options = {},
) {
  return runFlowNetNetwork(
    { ...settings, configPath: fixture.configPath },
    fixture.networkPath,
    businessKey,
    {
      ...(options.resume ? { resume: true } : {}),
      ...(options.resumeRun === undefined
        ? {}
        : { resumeRun: options.resumeRun }),
      ...(options.rerunFrom === undefined
        ? {}
        : { rerunFrom: options.rerunFrom }),
      environment: subprocessEnvironment(settings, ioRoot, options),
    },
  );
}

export function assertSuccessfulImport(graph, expectedRows, encoding) {
  assert.equal(graph.run.status, "SUCCESS");
  const attempt = graph.attempts.at(-1);
  assert.equal(attempt?.status, "SUCCESS");
  assert.equal(attempt?.resultCode, "OK");
  const summary = JSON.parse(attempt.errorMessage);
  assert.equal(summary.kind, "KSQL_FLOWNET_INPUT_AUDIT");
  assert.equal(summary.version, 1);
  assert.equal(summary.input_files?.length, 1);
  assert.equal(summary.input_files[0].source, "source");
  assert.equal(summary.input_files[0].rows, expectedRows);
  assert.equal(
    summary.input_files[0].encoding.toLowerCase(),
    encoding.toLowerCase(),
  );
  assert.match(summary.baseline[0].sha256, /^[a-f0-9]{64}$/u);
  return summary;
}

async function targetRequest(settings, path, options = {}) {
  const url = new globalThis.URL(`/k/v1/${path}.json`, `${settings.baseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(key, String(value));
  const response = await globalThis.fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "X-Cybozu-API-Token": settings.targetApiToken,
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
      `CSV1 fixture API ${options.method ?? "GET"} ${path} failed (${response.status})`,
    );
    error.status = response.status;
    error.apiCode = body?.code ?? null;
    throw error;
  }
  return body;
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

export async function getTargetRows(settings, keys) {
  const records = [];
  for (const group of chunks([...new Set(keys)], 50)) {
    if (group.length === 0) continue;
    const query = `${CSV1_KEY_FIELD} in (${group.map(quote).join(", ")}) order by $id asc limit 500`;
    const body = await targetRequest(settings, "records", {
      query: { app: settings.targetAppId, query },
    });
    records.push(...(body.records ?? []));
  }
  return records.map((record) => ({
    id: field(record, "$id"),
    revision: field(record, "$revision"),
    key: field(record, CSV1_KEY_FIELD),
    value: field(record, CSV1_VALUE_FIELD),
  }));
}

export async function assertTargetRows(settings, expected) {
  const actual = await getTargetRows(
    settings,
    expected.map(({ key }) => key),
  );
  const counts = new Map();
  for (const row of actual) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  assert.equal(
    actual.length,
    expected.length,
    "CSV1 fixtureの対象件数が一致しません",
  );
  for (const row of expected) {
    assert.equal(
      counts.get(row.key),
      1,
      `key ${row.key} は1件だけ存在すること`,
    );
    assert.equal(actual.find((item) => item.key === row.key)?.value, row.value);
  }
  return { count: actual.length, uniqueKeys: counts.size };
}

export async function cleanupTargetRows(settings, keys) {
  const records = await getTargetRows(settings, keys);
  const allowed = new Set(keys);
  for (const record of records)
    assert.ok(
      record.key.startsWith(CSV1_PREFIX) && allowed.has(record.key),
      "CSV1 cleanup対象が試験scope外です",
    );
  for (const group of chunks(records, 100))
    await targetRequest(settings, "records", {
      method: "DELETE",
      body: {
        app: settings.targetAppId,
        ids: group.map(({ id }) => id),
        revisions: group.map(({ revision }) => revision),
      },
    });
  const remaining = await getTargetRows(settings, keys);
  assert.equal(
    remaining.length,
    0,
    "CSV1 fixture cleanup後に対象レコードが残っています",
  );
  return { requested: keys.length, removed: records.length };
}

export async function assertAuditHasNoLeak(settings, graph, forbidden) {
  const records = (await getAllPersistenceRecords(settings, "audit")).filter(
    (record) => field(record, "run_id") === graph.run.runId,
  );
  const serialized = JSON.stringify(records);
  for (const value of forbidden) {
    assert.ok(value, "漏出検査値は空にできません");
    assert.equal(
      serialized.includes(value),
      false,
      `Run監査に禁止値が含まれています: ${basename(value)}`,
    );
  }
  return { auditRecordsChecked: records.length };
}

export async function createLegacyCli(directory) {
  const path = join(directory, "legacy-no-import-capability.mjs");
  await writeFile(
    path,
    `const result={formatVersion:1,kind:"CAPABILITIES",ksqlFlowVersion:"legacy-e2e",engineVersion:"legacy-e2e",executionContracts:["ksql-flow.execution/v1"],resultSchema:{$id:"https://example.invalid/execution-result-v1.schema.json",contract:"ksql-flow.execution/v1"},features:{resultJson:true,correlationIds:true,describeProfile:true,inspectJob:true,durableExecutionStarted:true,importCsv:false}};\nif(process.argv.includes("capabilities")){process.stdout.write(JSON.stringify(result)+"\\n");}else{process.stderr.write("legacy fixture only supports capabilities\\n");process.exitCode=1;}\n`,
    "utf8",
  );
  return path;
}

export function graphCounts(graph) {
  return {
    attempts: graph.attempts.length,
    invocations: graph.invocations.length,
    runId: graph.run.runId,
  };
}

export async function readMemoryMeasurement(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.equal(value.kind, "CSV1_PROCESS_MEMORY_PEAK");
  for (const fieldName of [
    "rss",
    "heapTotal",
    "heapUsed",
    "external",
    "arrayBuffers",
  ])
    assert.ok(
      Number.isSafeInteger(value.peak[fieldName]) && value.peak[fieldName] >= 0,
    );
  return value;
}
