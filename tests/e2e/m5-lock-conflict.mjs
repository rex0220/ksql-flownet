import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  runM5,
  startFlowNetNetwork,
  startStandaloneLongRead,
  waitForRunGraph,
} from "./support.mjs";

const MAX_ORDER_ATTEMPTS = 3;

function classifyOrdering(graph, holderResult, eligibleWaiting) {
  const state = graph.states.find(({ nodeId }) => nodeId === "n1_customers");
  const attempt = graph.attempts.find(
    ({ nodeId }) => nodeId === "n1_customers",
  );
  if (
    state?.status === "WAITING" &&
    state.statusReason === "PREPARE_FAILED" &&
    attempt?.status === "CANCELLED" &&
    attempt.resultCode === "PREPARE_FAILED" &&
    holderResult.exitCode === 0 &&
    eligibleWaiting
  ) {
    return "STANDALONE_FIRST";
  }
  if (holderResult.exitCode !== 0 && attempt?.status !== "CANCELLED") {
    return "N1_FIRST";
  }
  return "NO_CONFLICT";
}

await runM5(
  import.meta.url,
  "lock-conflict",
  async ({ settings, scope, timing }) => {
    const diagnostics = { maxAttempts: MAX_ORDER_ATTEMPTS, trials: [] };

    for (let trialNo = 1; trialNo <= MAX_ORDER_ATTEMPTS; trialNo += 1) {
      const trialScope = `${scope}_trial${trialNo}`;
      const fixture = await prepareNetwork(trialScope, "network-diamond.yaml");
      const trial = {
        trialNo,
        scope: trialScope,
        networkId: fixture.networkId,
        gateObservation: null,
        holder: null,
        networkProcess: null,
        ordering: null,
      };
      diagnostics.trials.push(trial);
      let network;
      let holder;
      try {
        timing.mark(`trial${trialNo}NetworkStartedAt`);
        network = await startFlowNetNetwork(
          settings,
          fixture.networkPath,
          trialScope,
        );

        const gateGraph = await waitForRunGraph(settings, trialScope, (graph) =>
          graph.states.some(({ nodeId }) => nodeId === "n1_customers"),
        );
        timing.mark(`trial${trialNo}GateObservedAt`);
        const observedState = gateGraph.states.find(
          ({ nodeId }) => nodeId === "n1_customers",
        );
        const observedAttempts = gateGraph.attempts.filter(
          ({ nodeId }) => nodeId === "n1_customers",
        );
        trial.gateObservation = {
          runId: gateGraph.run.runId,
          state: observedState,
          targetAttemptCount: observedAttempts.length,
          eligibleWaiting:
            observedState.status === "WAITING" && observedAttempts.length === 0,
        };
        timing.measure(
          `trial${trialNo}NetworkToGateMs`,
          `trial${trialNo}NetworkStartedAt`,
          `trial${trialNo}GateObservedAt`,
        );

        timing.mark(`trial${trialNo}StandaloneStartedAt`);
        holder = await startStandaloneLongRead(settings, trialScope);
        const [networkProcess, holderResult] = await Promise.all([
          network.completion,
          holder.completion,
        ]);
        timing.mark(`trial${trialNo}ProcessesFinishedAt`);
        timing.measure(
          `trial${trialNo}FromGateMs`,
          `trial${trialNo}GateObservedAt`,
          `trial${trialNo}ProcessesFinishedAt`,
        );
        timing.measure(
          `trial${trialNo}StandaloneRunMs`,
          `trial${trialNo}StandaloneStartedAt`,
          `trial${trialNo}ProcessesFinishedAt`,
        );

        const graph = await loadRunGraph(settings, trialScope);
        trial.networkProcess = networkProcess;
        trial.holder = {
          attemptId: holder.attemptId,
          correlationId: holder.correlationId,
          cwd: holder.cwd,
          flowNetCwd: holder.flowNetCwd,
          process: holderResult,
        };
        trial.ordering = classifyOrdering(
          graph,
          holderResult,
          trial.gateObservation.eligibleWaiting,
        );

        if (trial.ordering !== "STANDALONE_FIRST") continue;

        assert.equal(networkProcess.exitCode, 1);
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
          successfulTrial: trialNo,
          holder: trial.holder,
          networkProcess,
          graph,
          networkId: fixture.networkId,
          lockConflictDiagnostics: diagnostics,
        };
      } catch (error) {
        error.lockConflictDiagnostics = diagnostics;
        throw error;
      } finally {
        if (network?.child.exitCode === null) network.child.kill("SIGKILL");
        if (holder?.child.exitCode === null) holder.child.kill("SIGKILL");
        await Promise.allSettled(
          [network?.completion, holder?.completion].filter(Boolean),
        );
        await fixture.dispose();
      }
    }

    const reversed = diagnostics.trials.every(
      ({ ordering }) => ordering === "N1_FIRST",
    );
    const error = new Error(
      reversed
        ? `ロック取得の順序逆転が3回連続しました: n1がstandaloneより先にロックを取得しました; trials=${JSON.stringify(diagnostics.trials)}`
        : `3回試行してもstandalone先行のロック競合を観測できませんでした; trials=${JSON.stringify(diagnostics.trials)}`,
    );
    error.code = reversed
      ? "M5_LOCK_ORDER_REVERSED"
      : "M5_LOCK_CONFLICT_NOT_OBSERVED";
    error.lockConflictDiagnostics = diagnostics;
    throw error;
  },
);
