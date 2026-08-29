import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { releaseWhenReady } from "../../lib/barrier.mjs";
import {
  isClosedIpcError,
  recordChildError,
  safeChildDisconnect,
  safeChildSend,
} from "../../lib/child-ipc.mjs";
import {
  createKintoneClient,
  deleteRecord,
  field,
  getRecordsByKey,
  insertRecord,
  summarizeError,
} from "../../lib/kintone.mjs";
import {
  isMain,
  makeRunMetadata,
  parsePositiveIntegerOption,
  requireExecutionEnvironment,
  writeResult,
} from "../../lib/runtime.mjs";

function lockRecord(key, holder) {
  const now = new Date().toISOString();
  return {
    record_key: field(key),
    record_type: field("NETWORK_LOCK"),
    lock_key: field(key),
    profile: field("spike-d-contract"),
    owner_invocation_id: field(holder),
    lease_token: field(randomUUID()),
    status: field("RUNNING"),
    heartbeat_at: field(now),
    lease_expires_at: field(new Date(Date.now() + 300_000).toISOString()),
  };
}

async function runWorker() {
  const config = requireExecutionEnvironment();
  const client = createKintoneClient(config);
  const workerId = process.argv[3];
  await sendToParent({ type: "ready", workerId });
  const [start] = await once(process, "message");
  if (start?.type !== "start")
    throw new Error("worker開始メッセージが不正です。");
  const started = performance.now();
  let result;
  try {
    const response = await insertRecord(
      client,
      config.app,
      lockRecord(start.key, workerId),
    );
    result = {
      type: "result",
      workerId,
      success: true,
      status: 200,
      code: null,
      recordId: response.id,
      revision: response.revision,
      reget: null,
    };
  } catch (error) {
    const failure = summarizeError(error);
    let reget;
    try {
      const records = await getRecordsByKey(client, config.app, start.key);
      reget = {
        count: records.length,
        holder: records[0]?.owner_invocation_id?.value ?? null,
        status: records[0]?.status?.value ?? null,
        verdict:
          records.length === 1 && records[0]?.status?.value === "RUNNING"
            ? "LOCK_CONFLICT"
            : "LOCK_UNAVAILABLE",
      };
    } catch (getError) {
      reget = {
        count: null,
        holder: null,
        status: null,
        verdict: "LOCK_UNAVAILABLE",
        error: summarizeError(getError),
      };
    }
    result = { type: "result", workerId, success: false, ...failure, reget };
  }
  await sendToParent({
    ...result,
    durationMs: performance.now() - started,
    apiCalls: client.apiCalls,
  });

  const [finish] = await once(process, "message");
  if (finish?.type === "release" && result.success) {
    try {
      await deleteRecord(client, config.app, result.recordId, result.revision);
      await sendToParent({
        type: "released",
        workerId,
        success: true,
        apiCalls: 1,
      });
    } catch (error) {
      await sendToParent({
        type: "released",
        workerId,
        success: false,
        error: summarizeError(error),
        apiCalls: 1,
      });
    }
  }
  disconnectFromParent();
}

function sendToParent(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("親プロセスとのIPC channelが閉じています。"));
      return;
    }
    try {
      process.send(message, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function disconnectFromParent() {
  if (!process.connected) return;
  try {
    process.disconnect();
  } catch (error) {
    if (!isClosedIpcError(error)) throw error;
  }
}

function nextMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type === "fatal") {
        onError(
          new Error(
            message.error?.message ?? "workerで致命的エラーが発生しました。",
          ),
        );
        return;
      }
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      if (isClosedIpcError(error)) return;
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      onError(
        new Error(
          code === 0
            ? `workerが${type}メッセージを送信せず正常終了しました。`
            : `workerが異常終了しました (exit ${code})。`,
        ),
      );
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

export async function runContention({ workers = 2, iterations = 10 } = {}) {
  const config = requireExecutionEnvironment();
  const observer = createKintoneClient(config);
  const runId = randomUUID();
  const iterationResults = [];

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const iterationStarted = performance.now();
    const key = `spike-d-lock:${runId}:${iteration}`;
    const childErrors = [];
    const recordError = (error) => recordChildError(childErrors, error);
    const children = Array.from({ length: workers }, (_, index) => {
      const child = fork(fileURLToPath(import.meta.url), [
        "--worker",
        `worker-${index + 1}`,
      ]);
      child.on("error", recordError);
      return child;
    });
    const resultPromises = children.map((child) =>
      nextMessage(child, "result"),
    );
    await releaseWhenReady(
      children,
      { type: "start", key },
      (child, message) => {
        if (!safeChildSend(child, message, recordError)) {
          throw new Error("worker開始前にIPC channelが閉じました。");
        }
      },
    );
    const workerResults = await Promise.all(resultPromises);
    const winners = workerResults.filter((result) => result.success);
    const persisted = await getRecordsByKey(observer, config.app, key);
    const duplicateCount = Math.max(0, persisted.length - 1);

    let release = {
      success: false,
      error: "勝者が1件ではないため解放しません。",
    };
    if (winners.length === 1 && persisted.length === 1) {
      const winnerIndex = workerResults.findIndex(
        (result) => result.workerId === winners[0].workerId,
      );
      const releasePromise = nextMessage(children[winnerIndex], "released");
      if (
        !safeChildSend(children[winnerIndex], { type: "release" }, recordError)
      ) {
        throw new Error("lock解放前にworkerのIPC channelが閉じました。");
      }
      release = await releasePromise;
    }
    for (const [index, child] of children.entries()) {
      if (
        workerResults[index].workerId !== winners[0]?.workerId ||
        !release.success
      ) {
        safeChildSend(child, { type: "stop" }, recordError);
      }
      safeChildDisconnect(child, recordError);
    }
    if (childErrors.length > 0) throw childErrors[0];

    iterationResults.push({
      iteration,
      key,
      successWorker: winners[0]?.workerId ?? null,
      workers: workerResults,
      persistentRecordCount: persisted.length,
      persistentRecord: {
        holder: persisted[0]?.owner_invocation_id?.value ?? null,
        status: persisted[0]?.status?.value ?? null,
        revision: persisted[0]?.$revision?.value ?? null,
      },
      duplicateCount,
      release,
      durationMs: performance.now() - iterationStarted,
      apiCalls:
        workerResults.reduce((sum, result) => sum + result.apiCalls, 0) +
        1 +
        (release.apiCalls ?? 0),
      passed:
        winners.length === 1 &&
        workerResults.every(
          (result) =>
            result.success ||
            (result.status === 400 &&
              result.reget?.verdict === "LOCK_CONFLICT"),
        ) &&
        persisted.length === 1 &&
        duplicateCount === 0 &&
        release.success,
    });
  }

  return {
    ...makeRunMetadata(["D-03", "D-05", "D-06", "D-13"]),
    scenario: "lock-contention",
    workers,
    iterations,
    app: config.app,
    apiCalls: iterationResults.reduce((sum, item) => sum + item.apiCalls, 0),
    passed: iterationResults.every((item) => item.passed),
    results: iterationResults,
    observationBoundary:
      "この結果は検証環境での観測であり、kintoneの公式保証ではありません。",
  };
}

async function main() {
  const config = requireExecutionEnvironment();
  const workers = parsePositiveIntegerOption(process.argv, "--workers", 2, {
    minimum: 2,
  });
  const iterations = parsePositiveIntegerOption(
    process.argv,
    "--iterations",
    10,
  );
  const result = await runContention({ workers, iterations });
  const path = await writeResult(import.meta.url, result, [config.token]);
  console.log(`測定結果を保存しました: ${path}`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[2] === "--worker") {
  runWorker().catch(async (error) => {
    if (process.connected) {
      try {
        await sendToParent({ type: "fatal", error: summarizeError(error) });
      } catch (sendError) {
        if (!isClosedIpcError(sendError)) console.error(sendError.message);
      }
      disconnectFromParent();
    }
    process.exitCode = 1;
  });
} else if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
