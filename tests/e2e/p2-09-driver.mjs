/* P2-09実機受入の手動シナリオドライバ(一時ファイル)。
 * node tests/e2e/p2-09-driver.mjs kill <scope>    — 長尺Run起動→RUNNINGでkill(LIVE→INTERRUPTED素材)+allowlist出力
 * node tests/e2e/p2-09-driver.mjs failed <scope>  — トークン汚染でFAILED Runを作成+allowlist出力
 * node tests/e2e/p2-09-driver.mjs poll <allowlistPath> — ポーラーを1回実行(要求アプリ4267)
 * node tests/e2e/p2-09-driver.mjs status <networkId> [runId] — CLI activity表示
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  enumerateProcessTree,
  killProcessList,
  loadRunGraph,
  prepareNetwork,
  requireM5Environment,
  runFlowNetNetwork,
  runFlowNetStatus,
  startFlowNetNetwork,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";
import { requireP201Environment, runPollRequests } from "./p2-01-support.mjs";

const [mode, argument, runIdArg] = process.argv.slice(2);
const base = requireM5Environment();

async function writeAllowlist(fixture) {
  const path = join(tmpdir(), `p2-09-allowlist-${Date.now()}.yaml`);
  await writeFile(
    path,
    `networks:\n  - network_id: ${fixture.networkId}\n    definition_path: ${fixture.networkPath.replaceAll("\\", "/")}\n`,
    "utf8",
  );
  globalThis.console.log(`ALLOWLIST ${path}`);
}

if (mode === "kill" || mode === "failed") {
  const scope = argument;
  if (!scope?.startsWith("KSQL_FLOW_TEST_")) throw new Error("scope必須");
  const settings = { ...base, workdir: join(base.workdirBase, scope) };
  const fixtureName =
    mode === "kill" ? "network-p209-live.yaml" : "network-success.yaml";
  const fixture = await prepareNetwork(scope, fixtureName);
  globalThis.console.log(`FIXTURE network_id=${fixture.networkId}`);
  await writeAllowlist(fixture);
  if (mode === "failed") {
    const result = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
      {
        environment: { KSQL_TOKEN_CUSTOMERS: "KSQL_FLOW_TEST_invalid" },
      },
    );
    const graph = await loadRunGraph(settings, scope);
    globalThis.console.log(
      `FAILED-READY run=${graph.run.runId} status=${graph.run.status} exit=${result.exitCode}`,
    );
    process.exit(0);
  }
  const network = await startFlowNetNetwork(
    settings,
    fixture.networkPath,
    scope,
  );
  const running = await waitForRunGraph(settings, scope, (graph) =>
    graph.attempts.some(({ status }) => status === "RUNNING"),
  );
  const attempt = running.attempts.find(({ status }) => status === "RUNNING");
  await waitForRunningJobLog(settings, attempt.attemptId, "p208_longread");
  const tree = await enumerateProcessTree(network.child.pid);
  killProcessList(tree);
  await network.completion;
  globalThis.console.log(
    `KILLED run=${running.run.runId} — 今からlease約30秒+60秒はLIVE、その後INTERRUPTED`,
  );
  process.exit(0);
}

if (mode === "poll") {
  const settings = requireP201Environment({
    ...base,
    workdir: join(base.workdirBase, "p2-09-poll"),
  });
  const result = await runPollRequests(settings, argument);
  globalThis.console.log(result.stdout.trim() || result.stderr.trim());
  globalThis.console.log(`EXIT=${result.exitCode}`);
  process.exit(result.exitCode);
}

if (mode === "status") {
  const settings = { ...base, workdir: join(base.workdirBase, "p2-09-status") };
  const status = await runFlowNetStatus(
    settings,
    argument,
    runIdArg ? { runId: runIdArg } : {},
  );
  for (const run of status.output.runs) {
    globalThis.console.log(
      `run=${run.run_id} status=${run.status} activity=${run.activity ?? "(終端)"} resume_allowed=${run.resume_allowed}`,
    );
  }
  process.exit(0);
}

if (mode === "unlock") {
  const settings = { ...base, workdir: join(base.workdirBase, "p2-09-unlock") };
  const status = await runFlowNetStatus(settings, argument, {
    runId: runIdArg,
  });
  const recovery =
    status.output.runs[0].recovery_identifiers.force_unlock_network;
  const reasonFile = join(tmpdir(), `p209-unlock-${Date.now()}.txt`);
  await writeFile(
    reasonFile,
    "P2-09実機受入: kill済みRunのstale lock解放(二次対応者役)\n",
    "utf8",
  );
  const { runFlowNetCommand } = await import("./support.mjs");
  const released = await runFlowNetCommand(settings, [
    "force-unlock-network",
    recovery.network_id,
    "--profile",
    recovery.profile,
    "--expected-owner-invocation-id",
    recovery.expected_owner_invocation_id,
    "--reason-file",
    reasonFile,
    "--evidence-ref",
    "file:///p2-09-m3",
    "--stop-confirmed-by",
    "p2-09-m3-operator",
    "--stop-evidence-ref",
    "file:///p2-09-m3",
    "--stop-method",
    "local_pid",
  ]);
  globalThis.console.log(`unlock exit=${released.exitCode}`);
  globalThis.console.log(released.stdout.trim() || released.stderr.trim());
  process.exit(released.exitCode);
}

throw new Error("usage: kill|failed|poll|status|unlock");

// (追記) unlock <networkId> <runId> — 二次対応者役のforce-unlock(m6手順)
