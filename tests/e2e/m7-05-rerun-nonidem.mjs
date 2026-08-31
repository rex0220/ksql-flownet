import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  runFlowNetCommand,
  runFlowNetNetwork,
  runM7,
} from "./support.mjs";

await runM7(
  import.meta.url,
  "05-rerun-nonidem",
  async ({ settings, scope }) => {
    const unexecuted = await prepareNetwork(
      `${scope}_a`,
      "network-rerun-nonidem.yaml",
    );
    const executed = await prepareNetwork(
      `${scope}_b`,
      "network-rerun-nonidem2.yaml",
    );
    try {
      const unexecutedBusinessKey = `${scope}_unexecuted`;
      const unexecutedInitial = await runFlowNetNetwork(
        settings,
        unexecuted.networkPath,
        unexecutedBusinessKey,
      );
      assert.equal(
        unexecutedInitial.exitCode,
        1,
        unexecutedInitial.stderr || unexecutedInitial.stdout,
      );
      const unexecutedBefore = await loadRunGraph(
        settings,
        unexecutedBusinessKey,
      );
      const unexecutedBeforeStates = byNode(unexecutedBefore.states);
      assert.equal(unexecutedBefore.run.status, "FAILED");
      assert.equal(unexecutedBeforeStates.get("n1_extract").status, "SUCCESS");
      assert.equal(unexecutedBeforeStates.get("n2_aggregate").status, "FAILED");
      assert.equal(unexecutedBeforeStates.get("n3_notify").status, "BLOCKED");
      assert.equal(unexecutedBeforeStates.get("n3_notify").latestAttemptNo, 0);
      assert.equal(
        unexecutedBefore.attempts.filter(({ nodeId }) => nodeId === "n3_notify")
          .length,
        0,
      );

      const unexecutedRerun = await runFlowNetCommand(settings, [
        "run-network",
        unexecuted.networkPath,
        "--resume-run",
        unexecutedBefore.run.runId,
        "--rerun-from",
        "n2_aggregate",
      ]);
      assert.equal(
        unexecutedRerun.exitCode,
        1,
        unexecutedRerun.stderr || unexecutedRerun.stdout,
      );
      assert.doesNotMatch(unexecutedRerun.stderr, /RERUN_FROM_NON_IDEMPOTENT/u);
      assert.match(unexecutedRerun.stdout, /^RESUME: /mu);
      const unexecutedAfter = await loadRunGraph(
        settings,
        unexecutedBusinessKey,
      );
      const unexecutedAfterStates = byNode(unexecutedAfter.states);
      assert.equal(unexecutedAfter.run.runId, unexecutedBefore.run.runId);
      assert.equal(unexecutedAfterStates.get("n3_notify").status, "BLOCKED");
      assert.equal(unexecutedAfterStates.get("n3_notify").latestAttemptNo, 0);
      assert.equal(
        unexecutedAfter.attempts.filter(
          ({ nodeId }) => nodeId === "n2_aggregate",
        ).length,
        2,
      );
      assert.equal(
        unexecutedAfter.attempts.filter(({ nodeId }) => nodeId === "n3_notify")
          .length,
        0,
      );
      assert.equal(unexecutedAfter.invocations.at(-1).mode, "RERUN_FROM");

      const executedBusinessKey = `${scope}_executed`;
      const executedInitial = await runFlowNetNetwork(
        settings,
        executed.networkPath,
        executedBusinessKey,
      );
      assert.equal(
        executedInitial.exitCode,
        1,
        executedInitial.stderr || executedInitial.stdout,
      );
      const executedBefore = await loadRunGraph(settings, executedBusinessKey);
      const executedBeforeStates = byNode(executedBefore.states);
      assert.equal(executedBefore.run.status, "FAILED");
      assert.equal(executedBeforeStates.get("n3_notify").status, "SUCCESS");
      assert.ok(executedBeforeStates.get("n3_notify").latestAttemptNo > 0);
      assert.equal(executedBeforeStates.get("n4_fail").status, "FAILED");

      const executedRerun = await runFlowNetCommand(settings, [
        "run-network",
        executed.networkPath,
        "--resume-run",
        executedBefore.run.runId,
        "--rerun-from",
        "n3_notify",
      ]);
      assert.equal(executedRerun.exitCode, 1);
      assert.match(
        executedRerun.stderr,
        /Error \[RERUN_FROM_NON_IDEMPOTENT\]:/u,
      );
      assert.match(executedRerun.stderr, /executed idempotent=false/u);
      const executedAfter = await loadRunGraph(settings, executedBusinessKey);
      assert.equal(
        executedAfter.attempts.length,
        executedBefore.attempts.length,
      );
      assert.equal(
        executedAfter.invocations.length,
        executedBefore.invocations.length,
      );

      return {
        unexecutedNonIdempotentAccepted: {
          initialProcess: unexecutedInitial,
          rerunProcess: unexecutedRerun,
          networkId: unexecuted.networkId,
          before: unexecutedBefore,
          after: unexecutedAfter,
        },
        executedNonIdempotentRejected: {
          initialProcess: executedInitial,
          rerunProcess: executedRerun,
          networkId: executed.networkId,
          before: executedBefore,
          after: executedAfter,
        },
      };
    } finally {
      await Promise.all([unexecuted.dispose(), executed.dispose()]);
    }
  },
);
