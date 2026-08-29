import { randomUUID } from "node:crypto";

import {
  createKintoneClient,
  deleteRecord,
  field,
  getRecordsByKey,
  insertRecord,
  summarizeError,
  updateRecord,
} from "../../lib/kintone.mjs";
import {
  isMain,
  makeRunMetadata,
  requireExecutionEnvironment,
  writeResult,
} from "../../lib/runtime.mjs";

export async function runStaleReclaim() {
  const config = requireExecutionEnvironment();
  const client = createKintoneClient(config);
  const key = `spike-d-stale:${randomUUID()}`;
  await insertRecord(client, config.app, {
    record_key: field(key),
    record_type: field("NETWORK_LOCK"),
    lock_key: field(key),
    profile: field("spike-d-contract"),
    owner_invocation_id: field("old-holder"),
    lease_token: field(randomUUID()),
    status: field("RUNNING"),
  });
  const [beforeReclaim] = await getRecordsByKey(client, config.app, key);
  const oldRevision = beforeReclaim.$revision.value;
  const newLeaseToken = randomUUID();

  await updateRecord(client, config.app, beforeReclaim.$id.value, oldRevision, {
    owner_invocation_id: field("reclaimer"),
    lease_token: field(newLeaseToken),
    heartbeat_at: field(new Date().toISOString()),
  });

  let oldHolderAttempt;
  try {
    await updateRecord(
      client,
      config.app,
      beforeReclaim.$id.value,
      oldRevision,
      {
        heartbeat_at: field(new Date().toISOString()),
      },
    );
    oldHolderAttempt = { success: true, status: 200, code: null };
  } catch (error) {
    oldHolderAttempt = { success: false, ...summarizeError(error) };
  }
  const [afterAttempt] = await getRecordsByKey(client, config.app, key);
  const passed =
    !oldHolderAttempt.success &&
    oldHolderAttempt.status === 409 &&
    afterAttempt.owner_invocation_id.value === "reclaimer" &&
    afterAttempt.lease_token.value === newLeaseToken;
  await deleteRecord(
    client,
    config.app,
    afterAttempt.$id.value,
    afterAttempt.$revision.value,
  );
  return {
    ...makeRunMetadata(["D-10"]),
    scenario: "stale-reclaim-old-holder-return",
    app: config.app,
    key,
    oldRevision,
    reclaimRevision: afterAttempt.$revision.value,
    oldHolderAttempt,
    reget: {
      holder: afterAttempt.owner_invocation_id.value,
      leaseIdentityPreserved: afterAttempt.lease_token.value === newLeaseToken,
    },
    apiCalls: client.apiCalls,
    passed,
    safetyScope:
      "旧保持者停止を確認済みとする実運用のstale判定は模擬せず、revisionによる旧保持者拒否だけを測定する。",
  };
}

async function main() {
  const config = requireExecutionEnvironment();
  const result = await runStaleReclaim();
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
