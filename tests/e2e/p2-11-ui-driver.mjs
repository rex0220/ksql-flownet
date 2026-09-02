/* P2-11実機受入5(ボードUI)の手動シナリオドライバ。
 * node tests/e2e/p2-11-ui-driver.mjs prepare <scope>       — fixture2種+allowlist(app_start:true)を作成し、ダイアログ入力値を表示
 * node tests/e2e/p2-11-ui-driver.mjs poll <allowlistPath>  — ポーラーを1回実行(E2E要求アプリ)
 * node tests/e2e/p2-11-ui-driver.mjs status <businessKey>  — Run/Node stateを表示
 * node tests/e2e/p2-11-ui-driver.mjs cleanup <scope>       — scopeの要求/state/auditレコードを清掃
 */
import { join } from "node:path";

import {
  cleanupM5Records,
  loadRunGraph,
  requireM5Environment,
} from "./support.mjs";
import {
  cleanupRequestRecords,
  createAllowlist,
  requireP201Environment,
  runPollRequests,
} from "./p2-01-support.mjs";
import {
  prepareP211Network,
  readTargetPeriodAggregate,
  setScheduledAggregateExpectation,
} from "./p2-11-support.mjs";

const [mode, argument] = process.argv.slice(2);
const base = requireM5Environment();
// 子プロセスのKSQL_FLOW_WORKDIRに必要(p2-09-driverと同じ轍: workdir未設定だと
// run-network childが"KSQL_FLOW_WORKDIR is required"で落ち、RUN_NETWORK_FAILEDになる)
const settings = requireP201Environment({
  ...base,
  workdir: join(base.workdirBase, "p2-11-ui-driver"),
});
const log = globalThis.console.log;

if (mode === "prepare") {
  const scope = argument;
  if (!scope?.startsWith("KSQL_FLOW_TEST_")) throw new Error("scope必須");
  const scoped = { ...settings, workdir: join(base.workdirBase, scope) };
  const explicit = await prepareP211Network(`${scope}_explicit`, "explicit");
  const scheduled = await prepareP211Network(`${scope}_scheduled`, "scheduled");
  await setScheduledAggregateExpectation(
    scheduled,
    await readTargetPeriodAggregate(scoped, {
      fromDate: "2026-08-01",
      toDate: "2026-09-01",
    }),
  );
  const allowlist = await createAllowlist([explicit, scheduled]);
  log(`ALLOWLIST ${allowlist.path}`);
  log("--- ダイアログ入力値(受入5) ---");
  log(`explicitモード: network_id=${explicit.networkId}`);
  log(`  business_key=${scope}_ui_key`);
  log(`定期キーモード: network_id=${scheduled.networkId}`);
  log("  対象日時(JST)=2026-08-15 09:00");
  log(`補正モード: network_id=${scheduled.networkId}`);
  log(`  business_key=${scheduled.networkId}@2026-08-correction-ui`);
  log("  対象日時(JST)=2026-08-15 09:00");
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
  log(
    `RUN ${graph.run.runId} status=${graph.run.status} business_key=${graph.run.businessKey} as_of=${graph.run.asOf}`,
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
