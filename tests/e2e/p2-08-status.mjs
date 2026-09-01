/* P2-08実機受入: CLI status --jsonのactivityを表示(証跡用・一時ファイル) */
import { join } from "node:path";

import { requireM5Environment, runFlowNetStatus } from "./support.mjs";

const networkId = process.argv[2];
const runId = process.argv[3];
const base = requireM5Environment();
const settings = { ...base, workdir: join(base.workdirBase, "p208-status") };
const status = await runFlowNetStatus(
  settings,
  networkId,
  runId ? { runId } : {},
);
for (const run of status.output.runs) {
  console.log(
    `run=${run.run_id} status=${run.status} activity=${run.activity ?? "(終端: なし)"} started_at=${run.started_at}`,
  );
}
if (status.output.lock) {
  console.log(
    `lock owner=${status.output.lock.owner_invocation_id} lease=${status.output.lock.lease_expires_at} stale_candidate=${status.output.lock.stale_candidate}`,
  );
} else {
  console.log("lock: なし");
}
