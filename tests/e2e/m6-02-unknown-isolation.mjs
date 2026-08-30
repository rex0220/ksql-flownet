import assert from "node:assert/strict";

import {
  byNode,
  killKsqlFlowAttempt,
  prepareNetwork,
  recoverJobLock,
  resolveKsqlFlowCliPath,
  runM6,
  startFlowNetNetwork,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

await runM6(
  import.meta.url,
  "unknown-isolation",
  async ({ settings, scope, evidenceRef }) => {
    const fixture = await prepareNetwork(scope, "network-drill.yaml");
    const ksqlFlowCliPath = resolveKsqlFlowCliPath(settings.ksqlFlowBinArgs);
    let network;
    let killed = false;
    let lockRecovery;
    try {
      network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
      const running = await waitForRunGraph(settings, scope, (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === "n1_longread" && status === "RUNNING",
        ),
      );
      const attempt = running.attempts.find(
        ({ nodeId, status }) =>
          nodeId === "n1_longread" && status === "RUNNING",
      );
      await waitForRunningJobLog(settings, attempt.attemptId, "m6_longread");
      const killedPid = await killKsqlFlowAttempt(
        attempt.attemptId,
        ksqlFlowCliPath,
        scope,
      );
      killed = true;
      const processResult = await network.completion;
      assert.equal(processResult.exitCode, 1);
      const graph = await waitForRunGraph(
        settings,
        scope,
        ({ run }) => run.status === "UNKNOWN",
      );
      const states = byNode(graph.states);
      assert.equal(states.get("n1_longread").status, "UNKNOWN");
      assert.equal(states.get("n3_join").status, "BLOCKED");
      assert.deepEqual(states.get("n3_join").blockedBy, ["n1_longread"]);
      assert.equal(
        states.get("n2_independent").status,
        "SUCCESS",
        "independent branch must continue to SUCCESS",
      );
      return {
        process: processResult,
        killedPid,
        killedAttemptId: attempt.attemptId,
        networkId: fixture.networkId,
        graph,
        get lockRecovery() {
          return lockRecovery;
        },
      };
    } finally {
      if (network?.child.exitCode === null) network.child.kill("SIGKILL");
      if (killed) {
        lockRecovery = await recoverJobLock(
          settings,
          "m6_longread",
          evidenceRef,
          settings.requestedBy,
          "M6 UNKNOWN isolation kill cleanup",
        );
        if (lockRecovery.lockRecoveryResult !== null) {
          assert.equal(lockRecovery.recoveryProcess.exitCode, 0);
        }
      }
      await fixture.dispose();
    }
  },
);
