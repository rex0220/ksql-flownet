import { createKintoneClient } from "../../lib/kintone.mjs";
import {
  isMain,
  makeRunMetadata,
  requireExecutionEnvironment,
  writeResult,
} from "../../lib/runtime.mjs";
import { readStoreZip } from "../../lib/zip-store.mjs";
import {
  attachBundle,
  deleteAttachedRecord,
  downloadFile,
  getAttachedBundleFileKey,
  makeVerifiedBundle,
  sha256,
  uploadFile,
} from "./bundle-support.mjs";

function parseSizeMegabytes(arguments_) {
  const index = arguments_.indexOf("--size-mb");
  if (index === -1) return 10;
  const value = Number(arguments_[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--size-mb は0より大きい数で指定してください。");
  }
  return value;
}

async function measureSize(client, config, definition) {
  const callsBefore = client.apiCalls;
  const generationStarted = performance.now();
  const zip = makeVerifiedBundle(
    definition.payloadBytes,
    `${definition.label}.bin`,
  );
  const generationMs = performance.now() - generationStarted;
  const sourceHashStarted = performance.now();
  const sourceHash = sha256(zip);
  const sourceHashMs = performance.now() - sourceHashStarted;

  const uploadStarted = performance.now();
  const fileKey = await uploadFile(client, zip, `${definition.label}.zip`);
  const uploadMs = performance.now() - uploadStarted;
  let attached;
  let attachMs;
  let downloadMs;
  let downloadedHash;
  let downloadHashMs;
  let readEntries;
  try {
    const attachStarted = performance.now();
    attached = await attachBundle(
      client,
      config.app,
      fileKey,
      sourceHash,
      definition.label,
    );
    attachMs = performance.now() - attachStarted;
    const downloadFileKey = await getAttachedBundleFileKey(
      client,
      config.app,
      attached.recordKey,
    );
    const downloadStarted = performance.now();
    const downloaded = await downloadFile(client, downloadFileKey);
    downloadMs = performance.now() - downloadStarted;
    const downloadHashStarted = performance.now();
    downloadedHash = sha256(downloaded);
    downloadHashMs = performance.now() - downloadHashStarted;
    readEntries = readStoreZip(downloaded);
  } finally {
    if (attached) await deleteAttachedRecord(client, config.app, attached);
  }

  return {
    label: definition.label,
    measurementIds: definition.measurementIds,
    payloadBytes: definition.payloadBytes,
    zipBytes: zip.length,
    sourceSha256: sourceHash,
    downloadedSha256: downloadedHash,
    hashMatches: sourceHash === downloadedHash,
    zipSelfCheck: readEntries.length === 1,
    timingsMs: {
      generation: generationMs,
      sourceHash: sourceHashMs,
      upload: uploadMs,
      attach: attachMs,
      download: downloadMs,
      downloadHash: downloadHashMs,
    },
    apiCalls: client.apiCalls - callsBefore,
    passed: sourceHash === downloadedHash && readEntries.length === 1,
  };
}

export async function runBundleRoundtrip(sizeMegabytes = 10) {
  const config = requireExecutionEnvironment();
  const client = createKintoneClient(config);
  const sizes = [
    { label: "small", payloadBytes: 4 * 1024, measurementIds: ["B-01"] },
    { label: "medium", payloadBytes: 1024 * 1024, measurementIds: ["B-02"] },
    {
      label: "limit-candidate",
      payloadBytes: Math.round(sizeMegabytes * 1024 * 1024),
      measurementIds: ["B-03"],
    },
  ];
  const results = [];
  for (const definition of sizes) {
    results.push(await measureSize(client, config, definition));
  }
  return {
    ...makeRunMetadata(["B-01", "B-02", "B-03", "B-04", "B-05"]),
    scenario: "bundle-roundtrip",
    app: config.app,
    sizeMegabytes,
    apiCalls: client.apiCalls,
    passed: results.every((result) => result.passed),
    results,
    observationBoundary:
      "指定サイズは製品上限の候補であり、kintoneの公式上限ではありません。",
  };
}

async function main() {
  const config = requireExecutionEnvironment();
  const result = await runBundleRoundtrip(parseSizeMegabytes(process.argv));
  const path = await writeResult(import.meta.url, result, [config.token]);
  console.log(`測定結果を保存しました: ${path}`);
  if (!result.passed) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
