import { createKintoneClient, getRecordsByKey } from "../../lib/kintone.mjs";
import {
  isMain,
  makeRunMetadata,
  requireExecutionEnvironment,
  writeResult,
} from "../../lib/runtime.mjs";
import {
  attachBundle,
  deleteAttachedRecord,
  downloadFile,
  getAttachedBundleFileKey,
  makeVerifiedBundle,
  sha256,
  uploadFile,
} from "./bundle-support.mjs";

export async function runBundleCorruption() {
  const config = requireExecutionEnvironment();
  const client = createKintoneClient(config);
  const zip = makeVerifiedBundle(4 * 1024, "corruption.bin");
  const expectedHash = sha256(zip);
  const fileKey = await uploadFile(client, zip, "corruption.zip");
  let attached;
  let storedHash;
  let beforeCorruptionHash;
  let corruptedHash;
  try {
    attached = await attachBundle(
      client,
      config.app,
      fileKey,
      expectedHash,
      "corruption",
    );
    const downloadFileKey = await getAttachedBundleFileKey(
      client,
      config.app,
      attached.recordKey,
    );
    const downloaded = await downloadFile(client, downloadFileKey);
    const [record] = await getRecordsByKey(
      client,
      config.app,
      attached.recordKey,
    );
    storedHash = record?.source_bundle_sha256?.value ?? null;
    beforeCorruptionHash = sha256(downloaded);
    const corrupted = Buffer.from(downloaded);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;
    corruptedHash = sha256(corrupted);
  } finally {
    if (attached) await deleteAttachedRecord(client, config.app, attached);
  }
  const beforeMatchesRecord = beforeCorruptionHash === storedHash;
  const corruptionDetected = corruptedHash !== storedHash;

  return {
    ...makeRunMetadata(["B-06"]),
    scenario: "bundle-corruption",
    app: config.app,
    recordKey: attached.recordKey,
    zipBytes: zip.length,
    storedSha256: storedHash,
    downloadedSha256: beforeCorruptionHash,
    corruptedSha256: corruptedHash,
    beforeMatchesRecord,
    corruptionDetected,
    verdict:
      beforeMatchesRecord && corruptionDetected
        ? "CORRUPTION_DETECTED_FAIL_CLOSED"
        : "HASH_VERIFICATION_FAILED",
    apiCalls: client.apiCalls,
    passed: beforeMatchesRecord && corruptionDetected,
  };
}

async function main() {
  const config = requireExecutionEnvironment();
  const result = await runBundleCorruption();
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
