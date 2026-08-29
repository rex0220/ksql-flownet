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

async function actorUpdate(client, config, recordId, revision, actor) {
  const started = performance.now();
  try {
    const response = await updateRecord(
      client,
      config.app,
      recordId,
      revision,
      {
        owner_invocation_id: field(actor),
        heartbeat_at: field(new Date().toISOString()),
      },
    );
    return {
      actor,
      success: true,
      status: 200,
      code: null,
      revision: response.revision,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return {
      actor,
      success: false,
      ...summarizeError(error),
      durationMs: performance.now() - started,
    };
  }
}

export async function runRevisionConflict() {
  const config = requireExecutionEnvironment();
  const client = createKintoneClient(config);
  const key = `spike-d-revision:${randomUUID()}`;
  await insertRecord(client, config.app, {
    record_key: field(key),
    record_type: field("NETWORK_LOCK"),
    lock_key: field(key),
    profile: field("spike-d-contract"),
    owner_invocation_id: field("initial-holder"),
    lease_token: field(randomUUID()),
    status: field("RUNNING"),
  });
  const [initial] = await getRecordsByKey(client, config.app, key);
  const revision = initial.$revision.value;
  const actors = await Promise.all([
    actorUpdate(client, config, initial.$id.value, revision, "finish-record"),
    actorUpdate(client, config, initial.$id.value, revision, "reclaimer"),
  ]);
  const [finalRecord] = await getRecordsByKey(client, config.app, key);
  const winners = actors.filter((actor) => actor.success);
  const conflicts = actors.filter(
    (actor) => !actor.success && actor.status === 409,
  );
  const passed =
    winners.length === 1 &&
    conflicts.length === 1 &&
    finalRecord?.owner_invocation_id?.value === winners[0].actor;
  await deleteRecord(
    client,
    config.app,
    finalRecord.$id.value,
    finalRecord.$revision.value,
  );
  return {
    ...makeRunMetadata(["D-11"]),
    scenario: "revision-conflict",
    app: config.app,
    key,
    initialRevision: revision,
    actors,
    reget: {
      holder: finalRecord.owner_invocation_id.value,
      revision: finalRecord.$revision.value,
    },
    apiCalls: client.apiCalls,
    passed,
    note: "競合エラーcodeは実行環境の応答を記録する。CB_VA01等の特定codeを事前仮定しない。",
  };
}

async function main() {
  const config = requireExecutionEnvironment();
  const result = await runRevisionConflict();
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
