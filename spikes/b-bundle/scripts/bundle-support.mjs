import { createHash, randomUUID } from "node:crypto";

import {
  deleteRecord,
  field,
  getRecordsByKey,
  insertRecord,
} from "../../lib/kintone.mjs";
import { createStoreZip, readStoreZip } from "../../lib/zip-store.mjs";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function makeDeterministicBytes(size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 17) & 0xff;
  }
  return bytes;
}

export function makeVerifiedBundle(payloadSize, entryName = "bundle.bin") {
  const original = makeDeterministicBytes(payloadSize);
  const zip = createStoreZip([{ name: entryName, data: original }]);
  const entries = readStoreZip(zip);
  if (
    entries.length !== 1 ||
    entries[0].name !== entryName ||
    !entries[0].data.equals(original)
  ) {
    throw new Error("生成したstore-only ZIPの自己検証に失敗しました。");
  }
  return zip;
}

export async function uploadFile(client, bytes, fileName) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  const response = await client.request("file", { method: "POST", body: form });
  if (!response?.fileKey)
    throw new Error("file upload応答にfileKeyがありません。");
  return response.fileKey;
}

export async function downloadFile(client, fileKey) {
  const response = await client.request("file", {
    query: { fileKey },
    raw: true,
  });
  return Buffer.from(await response.arrayBuffer());
}

export function makeBundleRecordIdentity(label, uuid = randomUUID()) {
  const shortId = uuid.replaceAll("-", "").slice(0, 20);
  const runId = `spike-b-${label}-${shortId}`;
  return { runId, recordKey: `NETWORK_RUN:${runId}` };
}

export async function attachBundle(client, app, fileKey, expectedHash, label) {
  const { runId, recordKey } = makeBundleRecordIdentity(label);
  const response = await insertRecord(client, app, {
    record_key: field(recordKey),
    record_type: field("NETWORK_RUN"),
    run_id: field(runId),
    network_id: field("spike-b-bundle"),
    business_key: field(runId),
    status: field("CREATED"),
    lifecycle_status: field("ACTIVE"),
    resume_allowed: field("true"),
    source_bundle_sha256: field(expectedHash),
    source_bundle_attachment: { value: [{ fileKey }] },
    created_at: field(new Date().toISOString()),
  });
  return { recordKey, recordId: response.id, revision: response.revision };
}

export async function getAttachedBundleFileKey(client, app, recordKey) {
  const records = await getRecordsByKey(client, app, recordKey);
  const downloadFileKey =
    records[0]?.source_bundle_attachment?.value?.[0]?.fileKey;
  if (!downloadFileKey) {
    throw new Error(
      "添付後のNetwork Runからダウンロード用fileKeyを再取得できませんでした。",
    );
  }
  return downloadFileKey;
}

export async function deleteAttachedRecord(client, app, attached) {
  const records = await getRecordsByKey(client, app, attached.recordKey);
  const record = records[0];
  if (!record)
    throw new Error("後始末対象のNetwork Runを再取得できませんでした。");
  await deleteRecord(client, app, record.$id.value, record.$revision.value);
}
