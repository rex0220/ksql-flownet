/* P2-16 ボード受入(M4)の手動シナリオドライバ。
 * node tests/e2e/p2-16-ui-driver.mjs prepare <scope>       — FAILED Run(holdなし)・FAILED Run(holdあり)・START用fixtureとallowlistを作成
 * node tests/e2e/p2-16-ui-driver.mjs poll <allowlistPath>  — ポーラーを1回実行(E2E要求アプリ)
 * node tests/e2e/p2-16-ui-driver.mjs status <businessKey>  — Run/Node state・lifecycle・holdを表示
 * node tests/e2e/p2-16-ui-driver.mjs cleanup <scope>       — scopeの要求/state/auditレコードを清掃
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupM5Records,
  loadRunGraph,
  requireM5Environment,
  runFlowNetCommand,
  runFlowNetNetwork,
  startFlowNetNetwork,
  waitForRunGraph,
} from "./support.mjs";
import {
  cleanupRequestRecords,
  createAllowlist,
  prepareP201Network,
  requireP201Environment,
  runPollRequests,
} from "./p2-01-support.mjs";
import { prepareP211Network } from "./p2-11-support.mjs";
import {
  cleanupFaultBarrier,
  getRunHold,
  loadRunLifecycle,
  prepareFaultBarrier,
  releaseFaultBarrier,
  waitForBarrier,
} from "./p2-16-support.mjs";

const [mode, argument] = process.argv.slice(2);
const base = requireM5Environment();
const settings = requireP201Environment({
  ...base,
  workdir: join(base.workdirBase, "p2-16-ui-driver"),
});
const log = globalThis.console.log;

if (mode === "prepare") {
  const scope = argument;
  if (!scope?.startsWith("KSQL_FLOW_TEST_")) throw new Error("scope必須");
  const scoped = { ...settings, workdir: join(base.workdirBase, scope) };

  // 1. FAILED Run(holdなし) — クローズ要求とリラン要求の対象
  const closable = await prepareP201Network(
    `${scope}_closable`,
    "network-midfail.yaml",
  );
  const closableKey = `${scope}_closable_key`;
  const closableRun = await runFlowNetNetwork(
    scoped,
    closable.networkPath,
    closableKey,
  );
  if (closableRun.exitCode !== 1)
    throw new Error(
      `closable fixture did not fail: exit=${closableRun.exitCode}`,
    );
  const closableGraph = await loadRunGraph(scoped, closableKey);

  // 2. FAILED Run(holdあり) — 解除要求の対象。longfailのfinalizeをbarrierで止め、その間にSTOPを入れる
  const held = await prepareP201Network(
    `${scope}_held`,
    "network-p216-longfail.yaml",
  );
  const heldKey = `${scope}_held_key`;
  const barrier = await prepareFaultBarrier(held.directory, {
    label: "ui-held-finalize",
    barrierId: `${scope}_ui_finalize_before`,
    app: settings.auditAppId,
    field: "finished_at",
    phase: "before",
  });
  const heldProcess = await startFlowNetNetwork(
    scoped,
    held.networkPath,
    heldKey,
    { environment: barrier.environment },
  );
  await waitForRunGraph(scoped, heldKey, (graph) =>
    graph.attempts.some(({ status }) => status === "RUNNING"),
  );
  await waitForBarrier(barrier);
  const runningGraph = await loadRunGraph(scoped, heldKey);
  const reasonFile = join(held.directory, "stop-reason.txt");
  await writeFile(reasonFile, `${scope}: UI受入用の停止要求\n`, "utf8");
  const stop = await runFlowNetCommand(scoped, [
    "cancel-run",
    "--run-id",
    runningGraph.run.runId,
    "--reason-file",
    reasonFile,
  ]);
  if (stop.exitCode !== 0)
    throw new Error(`cancel-run failed: ${stop.stderr || stop.stdout}`);
  await releaseFaultBarrier(barrier);
  const heldResult = await heldProcess.completion;
  await cleanupFaultBarrier(barrier);
  const heldGraph = await loadRunGraph(scoped, heldKey);
  const heldHold = await getRunHold(
    scoped,
    held.networkId,
    heldGraph.run.runId,
  );

  // 3. START用fixture(取消ボタン確認用。ボードの新規実行で起票→取消)
  const start = await prepareP211Network(`${scope}_start`, "explicit");

  const allowlist = await createAllowlist([closable, held, start]);
  log(`ALLOWLIST ${allowlist.path}`);
  log("--- ボード受入の対象(E2E実行管理アプリの00_Run状況) ---");
  log(
    `A. クローズ/リラン対象(FAILED・holdなし): run_id=${closableGraph.run.runId} business_key=${closableKey} status=${closableGraph.run.status}`,
  );
  log(
    `B. 解除対象(FAILED・holdあり): run_id=${heldGraph.run.runId} business_key=${heldKey} status=${heldGraph.run.status} hold=${heldHold.hold ? heldHold.hold.state : "null"} exit=${heldResult.exitCode}`,
  );
  log(`C. START用network(プラグインCSVへ登録): ${start.networkId}`);
  log(`   CSV行: 受入用, ${start.networkId}, 任意キー`);
  log(`   business_key例: ${scope}_ui_start`);
  process.exit(0);
}

if (mode === "poll") {
  const poller = await runPollRequests(settings, argument);
  log(`POLL exit=${poller.exitCode}`);
  log(poller.stdout);
  if (poller.stderr) log(poller.stderr);
  process.exit(poller.exitCode ?? 1);
}

if (mode === "status") {
  const graph = await loadRunGraph(settings, argument);
  const lifecycle = await loadRunLifecycle(settings, graph.run.runId);
  const hold = await getRunHold(settings, graph.run.networkId, graph.run.runId);
  log(
    `RUN ${graph.run.runId} status=${graph.run.status} lifecycle=${lifecycle.lifecycleStatus} hold=${hold.hold ? hold.hold.state : "null"} business_key=${graph.run.businessKey}`,
  );
  for (const state of graph.states) {
    log(`  NODE ${state.nodeId} status=${state.status}`);
  }
  process.exit(0);
}

if (mode === "cleanup") {
  const scope = argument;
  if (!scope?.startsWith("KSQL_FLOW_TEST_")) throw new Error("scope必須");
  const requests = await cleanupRequestRecords(settings, `${scope}:`);
  const persistence = await cleanupM5Records(settings, scope);
  log(
    `CLEANUP requests=${requests.removed} state=${persistence.state} audit=${persistence.audit}`,
  );
  process.exit(0);
}

throw new Error(`unknown mode: ${mode}`);
