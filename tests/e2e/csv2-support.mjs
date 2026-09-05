import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import {
  CSV1_KEY_FIELD,
  CSV1_PREFIX,
  CSV1_VALUE_FIELD,
  assertAuditHasNoLeak,
  createFixtureConfig,
  createIoRoot,
  csvRows,
  runCsv1,
  insertTargetRows,
  subprocessEnvironment,
  writeCsv,
} from "./csv1-support.mjs";
import { prepareP201Network } from "./p2-01-support.mjs";
import { runFlowNetNetwork } from "./support.mjs";

export const CSV2_IMPORT_NODE = "import_csv";
export const CSV2_TRANSFORM_NODE = "transform_gate";
export const CSV2_EXPORT_NODE = "export_csv";
const CSV2_FIXTURE = "network-csv2-export.yaml";
const EXPECTED_KSQL_FLOW = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../ksql-flow/dist/cli.js",
);
const ENCODING_WRAPPER = fileURLToPath(
  new globalThis.URL("csv2-encoding-wrapper.mjs", import.meta.url),
);

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function runCsv2(importMetaUrl, name, test) {
  return runCsv1(importMetaUrl, name, async (context) => {
    assert.ok(
      context.settings.ksqlFlowBinArgs.some(
        (value) => resolve(value) === EXPECTED_KSQL_FLOW,
      ),
      `CSV2 E2Eは隣接kSQL-Flow distを使用してください: ${EXPECTED_KSQL_FLOW}`,
    );
    return test(context);
  });
}

export function makeCsv2Rows(scope, count, options = {}) {
  const valuePrefix =
    options.valuePrefix ??
    `v${createHash("sha256").update(scope).digest("hex").slice(0, 10)}_`;
  return csvRows(scope, count, { value: valuePrefix });
}

export function destinationRows(rows, destinationPrefix) {
  assert.ok(destinationPrefix.startsWith(CSV1_PREFIX));
  return rows.map((row) => ({
    key: `${destinationPrefix}${row.value}`,
    value: row.value,
  }));
}

export function destinationPrefix(scope, label) {
  assert.match(label, /^[A-Z0-9]{1,8}$/u);
  return `${CSV1_PREFIX}${createHash("sha256")
    .update(`${scope}:${label}`)
    .digest("hex")
    .slice(0, 12)}_${label}_`;
}

export async function prepareCsv2Case(settings, scope, options = {}) {
  const importEncoding = options.importEncoding ?? "UTF8";
  assert.ok(["UTF8", "SJIS"].includes(importEncoding));
  assert.ok(
    Array.isArray(options.sourceKeys) &&
      options.sourceKeys.length === options.expectedRows &&
      options.sourceKeys.every((key) => key.startsWith(CSV1_PREFIX)),
  );
  assert.ok(options.destinationPrefix?.startsWith(CSV1_PREFIX));
  assert.ok(
    Number.isSafeInteger(options.expectedRows) && options.expectedRows > 0,
  );
  let fixture;
  let io;
  try {
    fixture = await prepareP201Network(scope, CSV2_FIXTURE);
    if (options.includeFreshOutput) {
      const network = await readFile(fixture.networkPath, "utf8");
      const marker = "      report: csv2/{business_key}/{profile}/report.csv";
      assert.ok(network.includes(marker));
      await writeFile(
        fixture.networkPath,
        network.replace(
          marker,
          `${marker}\n      fresh: csv2/{business_key}/{profile}/fresh.csv`,
        ),
        "utf8",
      );
    }
    // 一意制約付き文字列1行は64文字まで(kintone既知の制約)のため、
    // scope全体ではなく短縮ハッシュでマーカーキーを作る。
    const finalizeMarkerKey =
      options.finalizeMarkerKey ??
      `${CSV1_PREFIX}${createHash("sha256")
        .update(`${scope}:FMK`)
        .digest("hex")
        .slice(0, 12)}_FMK`;
    const replacements = new Map([
      ["__CSV2_MARKER_KEY__", sqlLiteral(finalizeMarkerKey)],
      ["__CSV2_IMPORT_ENCODING__", importEncoding],
      [
        "__CSV2_SOURCE_FILTER__",
        `test_key IN (${options.sourceKeys
          .map((key) => `'${sqlLiteral(key)}'`)
          .join(", ")})`,
      ],
      ["__CSV2_DEST_PREFIX__", sqlLiteral(options.destinationPrefix)],
      ["__CSV2_EXPECTED_ROWS__", String(options.expectedRows)],
      [
        "__CSV2_AFTER_EXPORT_SELECT__",
        options.afterExportSelect ?? "SELECT * FROM #report;",
      ],
    ]);
    for (const name of [
      "csv2-import.sql",
      "csv2-transform.sql",
      "csv2-export.sql",
      "csv2-finalize.sql",
    ]) {
      const path = join(fixture.directory, "jobs", name);
      let sql = await readFile(path, "utf8");
      for (const [from, to] of replacements) sql = sql.replaceAll(from, to);
      assert.doesNotMatch(sql, /__CSV2_[A-Z_]+__/u);
      await writeFile(path, sql, "utf8");
    }
    fixture.configPath = await createFixtureConfig(settings, fixture.directory);
    io = await createIoRoot(settings, scope);
    return {
      fixture,
      ioRoot: io.root,
      finalizeMarkerKey,
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

export function csv2InputPath(ioRoot, businessKey, profile) {
  return join(
    ioRoot,
    "in",
    "csv2",
    encodeURIComponent(businessKey),
    encodeURIComponent(profile),
    "input.csv",
  );
}

export function csv2OutputPath(ioRoot, businessKey, profile) {
  return join(
    ioRoot,
    "out",
    "csv2",
    encodeURIComponent(businessKey),
    encodeURIComponent(profile),
    "report.csv",
  );
}

export function csv2FreshOutputPath(ioRoot, businessKey, profile) {
  return join(
    ioRoot,
    "out",
    "csv2",
    encodeURIComponent(businessKey),
    encodeURIComponent(profile),
    "fresh.csv",
  );
}

export async function seedCsv2Input(ioRoot, businessKey, profile, rows) {
  return writeCsv(csv2InputPath(ioRoot, businessKey, profile), rows);
}

function sjisSettings(settings) {
  return {
    ...settings,
    ksqlFlowBin: process.execPath,
    ksqlFlowBinArgs: [ENCODING_WRAPPER],
  };
}

export async function runCsv2Fixture(
  settings,
  testCase,
  businessKey,
  options = {},
) {
  const outputEncoding = options.outputEncoding ?? "utf8";
  assert.ok(["utf8", "sjis"].includes(outputEncoding));
  const effectiveSettings =
    outputEncoding === "sjis" ? sjisSettings(settings) : settings;
  const environment = {
    ...(outputEncoding === "sjis"
      ? {
          CSV2_REAL_KSQL_FLOW_BIN: settings.ksqlFlowBin,
          CSV2_REAL_KSQL_FLOW_BIN_ARGS: JSON.stringify(
            settings.ksqlFlowBinArgs,
          ),
        }
      : {}),
  };
  return runFlowNetNetwork(
    { ...effectiveSettings, configPath: testCase.fixture.configPath },
    testCase.fixture.networkPath,
    businessKey,
    {
      ...(options.resumeRun === undefined
        ? {}
        : { resumeRun: options.resumeRun }),
      ...(options.rerunFrom === undefined
        ? {}
        : { rerunFrom: options.rerunFrom }),
      environment: subprocessEnvironment(settings, testCase.ioRoot, {
        environment,
      }),
    },
  );
}

export function outputAudit(
  graph,
  fixture,
  expectedRows,
  encoding,
  options = {},
) {
  assert.equal(graph.run.status, options.runStatus ?? "SUCCESS");
  const attempt = graph.attempts
    .filter(({ nodeId }) => nodeId === fixture.nodeId(CSV2_EXPORT_NODE))
    .at(-1);
  assert.equal(attempt?.status, "SUCCESS");
  assert.equal(attempt?.resultCode, "OK");
  const summary = JSON.parse(attempt.errorMessage);
  assert.equal(summary.kind, "KSQL_FLOWNET_OUTPUT_AUDIT");
  assert.deepEqual(
    summary.output_files?.map(({ sink }) => sink),
    ["report"],
  );
  const receipt = summary.output_files[0];
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.rows, expectedRows);
  assert.equal(receipt.encoding, encoding);
  assert.ok(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0);
  return receipt;
}

export function ioAudit(graph, fixture, expectedRows, encoding) {
  const attempt = graph.attempts.find(
    ({ nodeId }) => nodeId === fixture.nodeId(CSV2_IMPORT_NODE),
  );
  assert.equal(attempt?.status, "SUCCESS");
  const summary = JSON.parse(attempt.errorMessage);
  assert.ok(
    ["KSQL_FLOWNET_INPUT_AUDIT", "KSQL_FLOWNET_IO_AUDIT"].includes(
      summary.kind,
    ),
  );
  assert.equal(summary.input_files[0].rows, expectedRows);
  assert.equal(summary.input_files[0].encoding, encoding.toUpperCase());
  return summary;
}

export async function assertCsvArtifact(path, expectedRows, encoding) {
  const bytes = await readFile(path);
  const text = new TextDecoder(encoding === "sjis" ? "shift_jis" : "utf-8", {
    fatal: true,
  }).decode(bytes);
  const expected = [
    `${CSV1_KEY_FIELD},${CSV1_VALUE_FIELD}`,
    ...expectedRows.map(({ key, value }) => `${key},${value}`),
    "",
  ].join("\r\n");
  assert.equal(text, expected);
  return {
    bytes: bytes.length,
    sha256: hash(bytes),
    rows: expectedRows.length,
  };
}

export async function copyArtifactToInput(
  artifactPath,
  ioRoot,
  businessKey,
  profile,
) {
  const target = csv2InputPath(ioRoot, businessKey, profile);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(artifactPath, target);
  return target;
}

export async function assertNoTemporaryFiles(directory) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assert.deepEqual(
    names.filter((name) => name.endsWith(".tmp")),
    [],
    "export一時fileが残っています",
  );
  return { directoryEntries: names.length, temporaryFiles: 0 };
}

function executableOnPath(name) {
  const extensions = process.platform === "win32" ? [".ps1"] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter))
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  return null;
}

export async function runCliKintoneImport(settings, csvPath) {
  const token = settings.targetApiToken;
  const cli = executableOnPath("cli-kintone");
  assert.ok(cli, "cli-kintoneがPATHにありません");
  const args = [
    "record",
    "import",
    "--base-url",
    settings.baseUrl,
    "--app",
    String(settings.targetAppId),
    "--api-token",
    token,
    "--file-path",
    csvPath,
    "--update-key",
    CSV1_KEY_FIELD,
    "--fields",
    `${CSV1_KEY_FIELD},${CSV1_VALUE_FIELD}`,
    "--encoding",
    "utf8",
  ];
  const command = process.platform === "win32" ? "pwsh.exe" : cli;
  const commandArgs =
    process.platform === "win32" ? ["-NoProfile", "-File", cli, ...args] : args;
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(command, commandArgs, {
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolveResult({ exitCode, stdout, stderr }),
    );
  });
  const diagnostic = `${result.stdout}\n${result.stderr}`.replaceAll(
    token,
    "[REDACTED]",
  );
  assert.equal(result.exitCode, 0, diagnostic.slice(-4_000));
  assert.equal(diagnostic.includes(token), false);
  return { exitCode: result.exitCode };
}

export { assertAuditHasNoLeak };

/** 受入17のfinalizeゲート用マーカーを投入する(成功系シナリオはrun前に必須)。 */
export async function seedFinalizeMarker(settings, exportCase) {
  await insertTargetRows(settings, [
    { key: exportCase.finalizeMarkerKey, value: "finalize" },
  ]);
  return exportCase.finalizeMarkerKey;
}
