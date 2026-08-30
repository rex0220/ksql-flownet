import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runM5,
  startStandaloneLongRead,
  summarizeJobLog,
  waitForRunningJobLog,
} from "./support.mjs";

await runM5(import.meta.url, "lock-conflict", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-diamond.yaml");
  const holder = await startStandaloneLongRead(settings, scope);
  try {
    const runningLog = await waitForRunningJobLog(settings, holder.attemptId);
    const networkProcess = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
    );
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
        process: holderResult,
      },
      networkProcess,
      graph,
      networkId: fixture.networkId,
    };
  } finally {
    if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
    await fixture.dispose();
  }
});
