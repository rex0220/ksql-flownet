import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  field,
  getJobLogs,
  prepareNetwork,
  runFlowNetCommand,
  runFlowNetNetwork,
  runFlowNetStatus,
  runM8,
  startFlowNetNetwork,
  waitFor,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

await runM8(import.meta.url, "03-activity", async ({ settings, scope }) => {
  const interruptedFixture = await prepareNetwork(
    `${scope}_interrupted`,
    "network-drill.yaml",
  );
  const terminalFixture = await prepareNetwork(
    `${scope}_terminal`,
    "network-success.yaml",
  );
  const reasonFile = join(interruptedFixture.directory, "cancel-reason.txt");
  await writeFile(reasonFile, "M8 activity STOPPED observation.\n", "utf8");
  let network;
  try {
    network = await startFlowNetNetwork(
      settings,
      interruptedFixture.networkPath,
      `${scope}_interrupted`,
    );
    const runningGraph = await waitForRunGraph(
      settings,
      `${scope}_interrupted`,
      (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === "n1_longread" && status === "RUNNING",
        ),
    );
    const runningAttempt = runningGraph.attempts.find(
      ({ nodeId, status }) => nodeId === "n1_longread" && status === "RUNNING",
    );
    await waitForRunningJobLog(
      settings,
      runningAttempt.attemptId,
      "m6_longread",
    );
    const live = await runFlowNetStatus(
      settings,
      interruptedFixture.networkId,
      { runId: runningGraph.run.runId },
    );
    assert.equal(live.output.runs[0].activity, "LIVE");

    network.child.kill("SIGKILL");
    const killedParent = await network.completion;
    network = undefined;
    assert.notEqual(killedParent.signal, null);
    await waitFor(
      async () => {
        const records = await getJobLogs(
          settings,
          `attempt_id = "${runningAttempt.attemptId}" and job_id = "m6_longread" order by $id asc`,
        );
        return (
          records.find((record) =>
            ["SUCCESS", "FAILED", "ABORTED", "CANCELLED"].includes(
              field(record, "status"),
            ),
          ) ?? null
        );
      },
      "orphaned M8 kSQL-Flow child terminal JOB log",
      { timeoutMs: 180_000, intervalMs: 2_000 },
    );
    const interrupted = await waitFor(
      async () => {
        const status = await runFlowNetStatus(
          settings,
          interruptedFixture.networkId,
          { runId: runningGraph.run.runId },
        );
        return status.output.runs[0].activity === "INTERRUPTED" ? status : null;
      },
      "M8 activity INTERRUPTED after lease expiry",
      { timeoutMs: 150_000, intervalMs: 1_000 },
    );

    const requested = await runFlowNetCommand(settings, [
      "cancel-run",
      "--run-id",
      runningGraph.run.runId,
      "--reason-file",
      reasonFile,
    ]);
    assert.equal(requested.exitCode, 0, requested.stderr || requested.stdout);
    const stopped = await runFlowNetStatus(
      settings,
      interruptedFixture.networkId,
      { runId: runningGraph.run.runId },
    );
    assert.equal(stopped.output.runs[0].activity, "STOPPED");

    const terminalProcess = await runFlowNetNetwork(
      settings,
      terminalFixture.networkPath,
      `${scope}_terminal`,
    );
    assert.equal(
      terminalProcess.exitCode,
      0,
      terminalProcess.stderr || terminalProcess.stdout,
    );
    const terminal = await runFlowNetStatus(
      settings,
      terminalFixture.networkId,
      { businessKey: `${scope}_terminal` },
    );
    assert.equal(terminal.output.runs[0].status, "SUCCESS");
    assert.equal(terminal.output.runs[0].activity, undefined);

    return {
      interruptedNetworkId: interruptedFixture.networkId,
      interruptedRunId: runningGraph.run.runId,
      live: live.output,
      killedParent,
      interrupted: interrupted.output,
      requested,
      stopped: stopped.output,
      terminalNetworkId: terminalFixture.networkId,
      terminalProcess,
      terminal: terminal.output,
    };
  } finally {
    if (network?.child.exitCode === null) network.child.kill("SIGKILL");
    await Promise.all([
      interruptedFixture.dispose(),
      terminalFixture.dispose(),
    ]);
  }
});
