import assert from "node:assert/strict";

import {
  assertNoKsqlFlowScopeProcess,
  byNode,
  killKsqlFlowAttempt,
  m5ConfirmedBy,
  prepareNetwork,
  recoverM5JobLock,
  resolveKsqlFlowCliPath,
  runM5,
  startFlowNetNetwork,
  summarizeJobLog,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

await runM5(
  import.meta.url,
  "kill-unknown",
  async ({ settings, scope, evidenceRef, timing }) => {
    const confirmedBy = m5ConfirmedBy();
    const fixture = await prepareNetwork(scope, "network-diamond.yaml", {
      longReadNodeId: "n1_customers",
    });
    const ksqlFlowCliPath = resolveKsqlFlowCliPath(settings.ksqlFlowBinArgs);
    let network;
    let killed = false;
    let detail;
    let testError;
    let lockRecovery;
    try {
      await assertNoKsqlFlowScopeProcess(scope, ksqlFlowCliPath);
      timing.mark("scopeProcessPrecheckFinishedAt");
      timing.mark("networkStartedAt");
      network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
      const running = await waitForRunGraph(settings, scope, (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === "n1_customers" && status === "RUNNING",
        ),
      );
      const attempt = running.attempts.find(
        ({ nodeId }) => nodeId === "n1_customers",
      );
      timing.mark("targetAttemptObservedAt");
      const runningLog = await waitForRunningJobLog(
        settings,
        attempt.attemptId,
      );
      timing.mark("runningJobLogConfirmedAt");
      const killedPid = await killKsqlFlowAttempt(
        attempt.attemptId,
        ksqlFlowCliPath,
        scope,
      );
      timing.mark("childKilledAt");
      timing.measure(
        "attemptObservationToKillMs",
        "targetAttemptObservedAt",
        "childKilledAt",
      );
      killed = true;
      const networkProcess = await network.completion;
      timing.mark("networkFinishedAt");
      timing.measure("networkMs", "networkStartedAt", "networkFinishedAt");
      assert.equal(networkProcess.exitCode, 1);
      const graph = await waitForRunGraph(
        settings,
        scope,
        ({ run }) => run.status === "UNKNOWN",
      );
      const states = byNode(graph.states);
      const attempts = byNode(graph.attempts);
      assert.equal(states.get("n1_customers").status, "UNKNOWN");
      assert.equal(attempts.get("n1_customers").status, "UNKNOWN");
      assert.equal(
        attempts.get("n1_customers").resultCode,
        "NO_EXECUTION_RESULT",
      );
      assert.ok(attempts.get("n1_customers").runnerExecutionStartedAt);
      assert.equal(states.get("n2_deals").status, "SUCCESS");
      assert.equal(states.get("n3_join").status, "BLOCKED");
      assert.deepEqual(states.get("n3_join").blockedBy, ["n1_customers"]);
      assert.equal(graph.run.status, "UNKNOWN");
      assert.equal(graph.invocations.at(-1).status, "UNKNOWN");
      detail = {
        killedPid,
        killedAttemptId: attempt.attemptId,
        runningLog: summarizeJobLog(runningLog),
        networkProcess,
        graph,
        networkId: fixture.networkId,
        ksqlFlowCliPath,
      };
    } catch (error) {
      testError = error;
    } finally {
      if (network?.child.exitCode === null) network.child.kill("SIGKILL");
      if (killed) {
        try {
          lockRecovery = await recoverM5JobLock(
            settings,
            evidenceRef,
            confirmedBy,
          );
          if (lockRecovery.lockRecoveryResult !== null) {
            assert.equal(
              lockRecovery.recoveryProcess.exitCode,
              0,
              lockRecovery.recoveryProcess.stderr ||
                lockRecovery.recoveryProcess.stdout,
            );
            assert.ok(
              ["RELEASED", "NOT_FOUND", "NOT_RUNNING"].includes(
                lockRecovery.lockRecoveryResult.outcome,
              ),
            );
          }
        } catch (error) {
          testError ??= error;
        }
      }
      await fixture.dispose();
    }
    if (testError) {
      testError.lockRecovery = lockRecovery;
      throw testError;
    }
    return { ...detail, lockRecovery };
  },
);
