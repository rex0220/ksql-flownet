import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  requireRunningJobLog,
  runM5,
  startFlowNetNetwork,
  startStandaloneLongRead,
  summarizeJobLog,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

await runM5(import.meta.url, "lock-conflict", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-diamond.yaml");
  const timingDiagnostics = {
    standaloneStartedAt: new Date().toISOString(),
    runningConfirmedAt: {
      initial: null,
      beforeNetwork: null,
      atTargetAttempt: null,
    },
    networkStartedAt: null,
    targetAttemptStartedAt: null,
    targetAttemptObservedAt: null,
  };
  const holder = await startStandaloneLongRead(settings, scope);
  let network;
  try {
    const runningLog = await waitForRunningJobLog(settings, holder.attemptId);
    timingDiagnostics.runningConfirmedAt.initial = new Date().toISOString();
    const preNetworkRunningLog = await requireRunningJobLog(
      settings,
      holder.attemptId,
      "network起動直前",
    );
    timingDiagnostics.runningConfirmedAt.beforeNetwork =
      new Date().toISOString();
    timingDiagnostics.networkStartedAt = new Date().toISOString();
    network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
    const observedGraph = await waitForRunGraph(settings, scope, (candidate) =>
      candidate.attempts.some(({ nodeId }) => nodeId === "n1_customers"),
    );
    const observedAttempt = observedGraph.attempts.find(
      ({ nodeId }) => nodeId === "n1_customers",
    );
    timingDiagnostics.targetAttemptObservedAt = new Date().toISOString();
    timingDiagnostics.targetAttemptStartedAt =
      observedAttempt?.executionStartedAt ?? null;
    const targetObservationRunningLog = await requireRunningJobLog(
      settings,
      holder.attemptId,
      "対象Attempt観測時",
    );
    timingDiagnostics.runningConfirmedAt.atTargetAttempt =
      new Date().toISOString();
    const networkProcess = await network.completion;
    assert.equal(networkProcess.exitCode, 1);
    const graph = await loadRunGraph(settings, scope);
    const holderResult = await holder.completion;
    assert.equal(holderResult.exitCode, 0, holderResult.stderr);

    const states = byNode(graph.states);
    const attempts = byNode(graph.attempts);
    assert.equal(states.get("n1_customers").status, "WAITING");
    assert.equal(states.get("n1_customers").statusReason, "PREPARE_FAILED");
    assert.equal(states.get("n1_customers").latestAttemptNo, 1);
    assert.equal(attempts.get("n1_customers").status, "CANCELLED");
    assert.equal(attempts.get("n1_customers").resultCode, "PREPARE_FAILED");
    assert.equal(states.get("n2_deals").status, "SUCCESS");
    assert.equal(attempts.get("n2_deals").status, "SUCCESS");
    assert.equal(states.get("n3_join").status, "WAITING");
    assert.equal(graph.run.status, "RUNNING");
    assert.equal(graph.invocations.at(-1).status, "CANCELLED");
    assert.equal(graph.invocations.at(-1).resultCode, "NODES_DEFERRED");
    return {
      holder: {
        attemptId: holder.attemptId,
        correlationId: holder.correlationId,
        cwd: holder.cwd,
        flowNetCwd: holder.flowNetCwd,
        runningLog: summarizeJobLog(runningLog),
        preNetworkRunningLog: summarizeJobLog(preNetworkRunningLog),
        targetObservationRunningLog: summarizeJobLog(
          targetObservationRunningLog,
        ),
        process: holderResult,
      },
      networkProcess,
      graph,
      networkId: fixture.networkId,
      timingDiagnostics,
    };
  } catch (error) {
    error.timingDiagnostics = timingDiagnostics;
    throw error;
  } finally {
    if (network?.child.exitCode === null) network.child.kill("SIGKILL");
    if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
    await fixture.dispose();
  }
});
