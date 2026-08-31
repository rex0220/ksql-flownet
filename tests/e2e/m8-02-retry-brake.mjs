import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  runFlowNetCommand,
  runFlowNetNetwork,
  runM8,
} from "./support.mjs";

await runM8(import.meta.url, "02-retry-brake", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-brake.yaml");
  try {
    const processes = [];
    processes.push(
      await runFlowNetNetwork(settings, fixture.networkPath, scope),
    );
    assert.equal(processes[0].exitCode, 1);
    let graph = await loadRunGraph(settings, scope);
    assert.equal(
      graph.attempts.filter(({ nodeId }) => nodeId === "n1_deterministic_fail")
        .length,
      1,
    );
    assert.equal(byNode(graph.states).get("n2_independent").status, "SUCCESS");

    for (let retry = 1; retry <= 2; retry += 1) {
      const process = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        "",
        { resumeRun: graph.run.runId },
      );
      processes.push(process);
      assert.equal(process.exitCode, 1, process.stderr || process.stdout);
      graph = await loadRunGraph(settings, scope);
      assert.equal(
        graph.attempts.filter(
          ({ nodeId }) => nodeId === "n1_deterministic_fail",
        ).length,
        retry + 1,
      );
    }

    const beforeBrakeAttempts = graph.attempts.length;
    const brakeProcess = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      "",
      { resumeRun: graph.run.runId },
    );
    assert.equal(brakeProcess.exitCode, 1);
    const braked = await loadRunGraph(settings, scope);
    const brakedStates = byNode(braked.states);
    assert.equal(braked.attempts.length, beforeBrakeAttempts);
    assert.match(
      brakedStates.get("n1_deterministic_fail").statusReason,
      /^RETRY_BRAKE:.+x3$/u,
    );
    assert.equal(brakedStates.get("n2_independent").status, "SUCCESS");
    assert.equal(braked.invocations.at(-1).mode, "RESUME");

    const failedAttemptsBeforeRerun = braked.attempts.filter(
      ({ nodeId }) => nodeId === "n1_deterministic_fail",
    ).length;
    const rerun = await runFlowNetCommand(settings, [
      "run-network",
      fixture.networkPath,
      "--resume-run",
      braked.run.runId,
      "--rerun-from",
      "n1_deterministic_fail",
    ]);
    assert.equal(rerun.exitCode, 1);
    assert.doesNotMatch(rerun.stderr, /RETRY_BRAKE/u);
    const afterRerun = await loadRunGraph(settings, scope);
    assert.equal(
      afterRerun.attempts.filter(
        ({ nodeId }) => nodeId === "n1_deterministic_fail",
      ).length,
      failedAttemptsBeforeRerun + 1,
    );
    assert.equal(afterRerun.invocations.at(-1).mode, "RERUN_FROM");

    return {
      networkId: fixture.networkId,
      runId: graph.run.runId,
      failedProcesses: processes,
      brakeProcess,
      braked,
      rerun,
      afterRerun,
    };
  } finally {
    await fixture.dispose();
  }
});
