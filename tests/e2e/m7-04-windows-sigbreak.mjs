import assert from "node:assert/strict";

import {
  loadRunGraph,
  prepareNetwork,
  runM7,
  startFlowNetNetwork,
  summarizeJobLog,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";
import {
  forceUnlockAndAdjudicate,
  waitForCompletion,
  waitForTerminalJobLog,
} from "./m7-support.mjs";

const TERMINAL = new Set(["SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"]);

function assertSafeGraph(graph) {
  const attemptsById = new Map(
    graph.attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  for (const state of graph.states) {
    assert.ok(
      [
        "WAITING",
        "RUNNING",
        "SUCCESS",
        "FAILED",
        "BLOCKED",
        "CANCELLED",
        "UNKNOWN",
      ].includes(state.status),
      `unexpected Node State status: ${state.status}`,
    );
    if (TERMINAL.has(state.status))
      assert.ok(
        state.finishedAt,
        `${state.nodeId} terminal state needs finished_at`,
      );
  }
  for (const attempt of graph.attempts) {
    assert.ok(
      ["RUNNING", "SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"].includes(
        attempt.status,
      ),
      `unexpected Attempt status: ${attempt.status}`,
    );
    if (TERMINAL.has(attempt.status))
      assert.ok(attempt.finishedAt, `${attempt.attemptId} needs finished_at`);
    assert.equal(attemptsById.get(attempt.attemptId), attempt);
  }
  if (TERMINAL.has(graph.run.status)) {
    assert.ok(graph.run.finishedAt, "terminal Run needs finished_at");
    assert.ok(
      graph.states.every(({ status }) => status !== "RUNNING"),
      "terminal Run must not contain a RUNNING Node State",
    );
  }
}

await runM7(
  import.meta.url,
  "04-windows-sigbreak",
  async ({ settings, scope, evidenceRef }) => {
    assert.equal(process.platform, "win32", "M7-04 is a Windows-only drill");
    const fixture = await prepareNetwork(scope, "network-drill.yaml");
    let network;
    try {
      network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
      const running = await waitForRunGraph(settings, scope, (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === "n1_longread" && status === "RUNNING",
        ),
      );
      const runningAttempt = running.attempts.find(
        ({ nodeId, status }) =>
          nodeId === "n1_longread" && status === "RUNNING",
      );
      await waitForRunningJobLog(
        settings,
        runningAttempt.attemptId,
        "m6_longread",
      );

      // Windowsで他プロセスへのprocess.killはENOSYS。子ハンドル経由でCTRL_BREAK相当を配送する
      network.child.kill("SIGBREAK");
      const interruptedProcess = await waitForCompletion(
        network.completion,
        "M7 SIGBREAK FlowNet",
        60_000,
      );
      const terminalJob = await waitForTerminalJobLog(
        settings,
        runningAttempt.attemptId,
      );
      const observedGraph = await loadRunGraph(settings, scope);
      assertSafeGraph(observedGraph);
      const observedAttempt = observedGraph.attempts.find(
        ({ attemptId }) => attemptId === runningAttempt.attemptId,
      );
      const observedInvocation = observedGraph.invocations.at(-1);
      const stopObservation =
        observedAttempt.status !== "RUNNING" &&
        observedInvocation.status !== "RUNNING"
          ? "graceful-drain"
          : "simple-termination";

      let orphanRecovery = null;
      let finalGraph = observedGraph;
      if (
        observedGraph.states.some(({ status }) => status === "RUNNING") ||
        observedGraph.attempts.some(({ status }) => status === "RUNNING") ||
        observedGraph.invocations.some(({ status }) => status === "RUNNING")
      ) {
        orphanRecovery = await forceUnlockAndAdjudicate({
          settings,
          fixture,
          runId: observedGraph.run.runId,
          evidenceRef,
          reason: "M7 SIGBREAK orphan recovery",
        });
        finalGraph = await loadRunGraph(settings, scope);
        assertSafeGraph(finalGraph);
        assert.ok(
          finalGraph.attempts.every(({ status }) => status !== "RUNNING"),
          "orphan adjudication must recover RUNNING attempts",
        );
        assert.ok(
          finalGraph.invocations.every(({ status }) => status !== "RUNNING"),
          "orphan adjudication must recover RUNNING invocations",
        );
      }

      return {
        networkId: fixture.networkId,
        signalSent: "SIGBREAK",
        stopObservation,
        interruptedProcess,
        interruptedAttemptId: runningAttempt.attemptId,
        terminalJob: summarizeJobLog(terminalJob),
        observedGraph,
        orphanRecovery,
        finalGraph,
      };
    } finally {
      if (network?.child.exitCode === null) network.child.kill("SIGKILL");
      await fixture.dispose();
    }
  },
);
