/* P2-08実機受入の手動シナリオドライバ(一時ファイル)。
 * 使い方: node tests/e2e/p2-08-driver.mjs <live|kill> <scope>
 *  live: 長尺Runを起動し、RUNNING確認でLIVE-READYを出力、完走まで待つ
 *  kill: 長尺Runを起動し、RUNNING確認後にプロセスツリーをkillして終了(INTERRUPTED作成)
 * 状態確認は別途 status --json / ボードで行う。
 */
import { join } from "node:path";

import {
  enumerateProcessTree,
  killProcessList,
  loadRunGraph,
  prepareNetwork,
  requireM5Environment,
  startFlowNetNetwork,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

const mode = process.argv[2];
const scope = process.argv[3];
if (
  !["live", "kill", "liveloop"].includes(mode) ||
  !scope?.startsWith("KSQL_FLOW_TEST_")
) {
  globalThis.console.error(
    "usage: node p2-08-driver.mjs <live|kill|liveloop> <KSQL_FLOW_TEST_...scope>",
  );
  process.exit(1);
}
const base = requireM5Environment();
const settings = { ...base, workdir: join(base.workdirBase, scope) };

if (mode === "liveloop") {
  // 約4分間、完走するたびに新しいRunを起動し続ける(LIVE観測窓の確保)
  const deadline = Date.now() + 4 * 60_000;
  let iteration = 0;
  while (Date.now() < deadline) {
    iteration += 1;
    const loopScope = `${scope}_i${iteration}`;
    const loopSettings = {
      ...base,
      workdir: join(base.workdirBase, loopScope),
    };
    const loopFixture = await prepareNetwork(
      loopScope,
      "network-p208-live.yaml",
    );
    const loopNetwork = await startFlowNetNetwork(
      loopSettings,
      loopFixture.networkPath,
      loopScope,
    );
    const loopRunning = await waitForRunGraph(
      loopSettings,
      loopScope,
      (graph) => graph.attempts.some(({ status }) => status === "RUNNING"),
    );
    globalThis.console.log(
      `LIVE-READY i=${iteration} run=${loopRunning.run.runId}`,
    );
    const exit = await loopNetwork.completion;
    globalThis.console.log(`ITER-END i=${iteration} code=${exit.exitCode}`);
  }
  globalThis.console.log("LOOP-DONE");
  process.exit(0);
}

const fixture = await prepareNetwork(scope, "network-p208-live.yaml");
globalThis.console.log(`FIXTURE network_id=${fixture.networkId}`);
const network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
const running = await waitForRunGraph(settings, scope, (graph) =>
  graph.attempts.some(({ status }) => status === "RUNNING"),
);
globalThis.console.log(`RUN-ID ${running.run.runId}`);
const attempt = running.attempts.find(({ status }) => status === "RUNNING");
await waitForRunningJobLog(settings, attempt.attemptId, "p208_longread");
globalThis.console.log(
  `LIVE-READY run=${running.run.runId} pid=${network.child.pid}`,
);

if (mode === "kill") {
  const tree = await enumerateProcessTree(network.child.pid);
  const killed = killProcessList(tree);
  globalThis.console.log(`KILLED processes=${killed.length}`);
  const exit = await network.completion;
  globalThis.console.log(
    `CHILD-EXIT code=${exit.exitCode} signal=${exit.signal}`,
  );
  globalThis.console.log(
    "INTERRUPTED-PENDING lease30s+分精度60sの失効後にINTERRUPTEDへ",
  );
  process.exit(0);
}

const completion = await network.completion;
globalThis.console.log(`CHILD-EXIT code=${completion.exitCode}`);
const graph = await loadRunGraph(settings, scope);
globalThis.console.log(
  `FINAL run=${graph.run.runId} status=${graph.run.status}`,
);
