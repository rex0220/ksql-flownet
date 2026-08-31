import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  runFlowNetCommand,
  runFlowNetNetwork,
  runFlowNetStatus,
  runM8,
  startFlowNetNetwork,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

await runM8(import.meta.url, "01-cancel-hold", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-drill.yaml");
  const reasonFile = join(fixture.directory, "cancel-reason.txt");
  const releaseReasonFile = join(fixture.directory, "release-reason.txt");
  await writeFile(reasonFile, "M8 stop at the next node boundary.\n", "utf8");
  await writeFile(
    releaseReasonFile,
    "M8 verified the hold and approved resume.\n",
    "utf8",
  );
  let network;
  try {
    network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
    const runningGraph = await waitForRunGraph(settings, scope, (graph) =>
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

    const live = await runFlowNetStatus(settings, fixture.networkId, {
      runId: runningGraph.run.runId,
    });
    assert.equal(live.output.runs[0].activity, "LIVE");

    const requested = await runFlowNetCommand(settings, [
      "cancel-run",
      "--run-id",
      runningGraph.run.runId,
      "--reason-file",
      reasonFile,
    ]);
    assert.equal(requested.exitCode, 0, requested.stderr || requested.stdout);
    assert.match(requested.stdout, /^REQUESTED: /mu);
    const stopped = await runFlowNetStatus(settings, fixture.networkId, {
      runId: runningGraph.run.runId,
    });
    assert.equal(stopped.output.runs[0].activity, "STOPPED");

    const stoppedProcess = await network.completion;
    network = undefined;
    assert.equal(stoppedProcess.exitCode, 1);
    const heldGraph = await loadRunGraph(settings, scope);
    const heldStates = byNode(heldGraph.states);
    assert.equal(heldStates.get("n1_longread").status, "SUCCESS");
    assert.equal(heldStates.get("n2_independent").latestAttemptNo, 0);
    assert.equal(heldStates.get("n3_join").latestAttemptNo, 0);
    assert.equal(heldGraph.invocations.at(-1).status, "CANCELLED");
    assert.equal(heldGraph.invocations.at(-1).resultCode, "STOP_REQUESTED");
    const heldStatus = await runFlowNetStatus(settings, fixture.networkId, {
      runId: heldGraph.run.runId,
    });
    assert.equal(heldStatus.output.lock, null);
    assert.equal(heldStatus.output.runs[0].activity, "STOPPED");

    const rejectedResume = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      "",
      { resumeRun: heldGraph.run.runId },
    );
    assert.equal(rejectedResume.exitCode, 1);
    assert.match(rejectedResume.stderr, /Error \[RUN_ON_HOLD\]:/u);

    const released = await runFlowNetCommand(settings, [
      "cancel-run",
      "--run-id",
      heldGraph.run.runId,
      "--release",
      "--reason-file",
      releaseReasonFile,
    ]);
    assert.equal(released.exitCode, 0, released.stderr || released.stdout);
    assert.match(released.stdout, /^RELEASED: /mu);
    const releasedStatus = await runFlowNetStatus(settings, fixture.networkId, {
      runId: heldGraph.run.runId,
    });
    assert.equal(releasedStatus.output.runs[0].activity, "INTERRUPTED");

    const resumed = await runFlowNetNetwork(settings, fixture.networkPath, "", {
      resumeRun: heldGraph.run.runId,
    });
    assert.equal(resumed.exitCode, 0, resumed.stderr || resumed.stdout);
    const completedGraph = await loadRunGraph(settings, scope);
    assert.equal(completedGraph.run.status, "SUCCESS");
    assert.deepEqual(
      [...byNode(completedGraph.states).values()].map(({ status }) => status),
      ["SUCCESS", "SUCCESS", "SUCCESS"],
    );
    const completedStatus = await runFlowNetStatus(
      settings,
      fixture.networkId,
      { runId: heldGraph.run.runId },
    );
    assert.equal(completedStatus.output.runs[0].activity, undefined);

    return {
      networkId: fixture.networkId,
      runId: heldGraph.run.runId,
      live: live.output,
      requested,
      stopped: heldStatus.output,
      stoppedProcess,
      rejectedResume,
      released,
      releasedStatus: releasedStatus.output,
      resumed,
      completed: completedGraph,
      completedStatus: completedStatus.output,
    };
  } finally {
    if (network?.child.exitCode === null) network.child.kill("SIGKILL");
    await fixture.dispose();
  }
});
