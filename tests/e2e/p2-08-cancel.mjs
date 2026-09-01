/* P2-08実機受入: cancel-run要求/解除の一時スクリプト。
 * 使い方: node p2-08-cancel.mjs <request|release> <run_id> <network_id>
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  requireM5Environment,
  runFlowNetCommand,
  runFlowNetStatus,
} from "./support.mjs";

const [mode, runId, networkId] = process.argv.slice(2);
if (!["request", "release"].includes(mode) || !runId || !networkId) {
  console.error(
    "usage: node p2-08-cancel.mjs <request|release> <run_id> <network_id>",
  );
  process.exit(1);
}
const base = requireM5Environment();
const settings = { ...base, workdir: join(base.workdirBase, "p208-cancel") };
const reasonFile = join(tmpdir(), `p208-cancel-${Date.now()}.txt`);
await writeFile(
  reasonFile,
  "P2-08プラグイン実機受入のSTOP/RELEASE観測\n",
  "utf8",
);

const args = ["cancel-run", "--run-id", runId, "--reason-file", reasonFile];
if (mode === "release") args.splice(1, 0, "--release");
// cancel-run --release は --run-id より前でも後でも良いが、既存テストに合わせ末尾へ
const finalArgs =
  mode === "release"
    ? [
        "cancel-run",
        "--run-id",
        runId,
        "--release",
        "--reason-file",
        reasonFile,
      ]
    : args;
const result = await runFlowNetCommand(settings, finalArgs);
console.log(`exit=${result.exitCode}`);
console.log(result.stdout.trim() || result.stderr.trim());
const status = await runFlowNetStatus(settings, networkId, { runId });
const run = status.output.runs[0];
console.log(
  `CLI: status=${run.status} activity=${run.activity ?? "(終端)"} at ${new Date().toISOString()}`,
);
