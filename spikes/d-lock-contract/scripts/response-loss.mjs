import { randomUUID } from "node:crypto";

import {
  createKintoneClient,
  deleteRecord,
  field,
  getRecordsByKey,
  summarizeError,
} from "../../lib/kintone.mjs";
import {
  isMain,
  makeRunMetadata,
  requireExecutionEnvironment,
  writeResult,
} from "../../lib/runtime.mjs";

export async function runResponseLoss() {
  const config = requireExecutionEnvironment();
  const client = createKintoneClient(config);
  const holder = `response-loss-${randomUUID()}`;
  const key = `spike-d-lock:${holder}`;
  const started = performance.now();
  let transportObservation;

  try {
    const response = await client.request("record", {
      method: "POST",
      body: {
        app: config.app,
        record: {
          record_key: field(key),
          record_type: field("NETWORK_LOCK"),
          lock_key: field(key),
          profile: field("spike-d-contract"),
          owner_invocation_id: field(holder),
          lease_token: field(randomUUID()),
          status: field("RUNNING"),
        },
      },
      raw: true,
    });
    // 成功応答のbodyを読まず、取得結果だけで裁定する。
    await response.body?.cancel();
    transportObservation = "response-discarded";
  } catch (error) {
    transportObservation = { requestError: summarizeError(error) };
  }

  let records = [];
  let getError = null;
  try {
    records = await getRecordsByKey(client, config.app, key);
  } catch (error) {
    getError = summarizeError(error);
  }
  const ownRecord =
    records.length === 1 && records[0].owner_invocation_id?.value === holder;
  const verdict = ownRecord ? "ACQUIRED_BY_REGET" : "FAIL_CLOSED";
  let cleanup = null;
  if (ownRecord) {
    await deleteRecord(
      client,
      config.app,
      records[0].$id.value,
      records[0].$revision.value,
    );
    cleanup = "deleted";
  }
  return {
    ...makeRunMetadata(["D-07"]),
    scenario: "response-loss",
    app: config.app,
    key,
    transportObservation,
    reget: {
      count: records.length,
      holder: records[0]?.owner_invocation_id?.value ?? null,
      getError,
    },
    verdict,
    failClosed: verdict === "FAIL_CLOSED",
    cleanup,
    durationMs: performance.now() - started,
    apiCalls: client.apiCalls,
    passed: verdict === "ACQUIRED_BY_REGET",
  };
}

async function main() {
  const config = requireExecutionEnvironment();
  const result = await runResponseLoss();
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
