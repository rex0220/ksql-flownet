import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runM5,
} from "./support.mjs";

await runM5(import.meta.url, "resume", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-midfail.yaml");
  const timingDiagnostics = {
    standaloneStartedAt: null,
    runningConfirmedAt: null,
    networkStartedAt: { initial: null, resume: null },
    targetAttemptStartedAt: { initial: null, resume: null },
  };
  try {
    timingDiagnostics.networkStartedAt.initial = new Date().toISOString();
    const first = await runFlowNetNetwork(settings, fixture.networkPath, scope);
    assert.equal(first.exitCode, 1);
    const before = await loadRunGraph(settings, scope);
    const n1Before = before.attempts.filter(
      ({ nodeId }) => nodeId === "n1_extract",
    );
    assert.equal(n1Before.length, 1);
    assert.equal(n1Before[0].status, "SUCCESS");
    const n2Before = before.attempts.find(({ nodeId }) => nodeId === "n2_fail");
    timingDiagnostics.targetAttemptStartedAt.initial =
      n2Before?.executionStartedAt ?? null;

    timingDiagnostics.networkStartedAt.resume = new Date().toISOString();
    const resumed = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
      { resume: true },
    );
    assert.equal(resumed.exitCode, 1);
    const after = await loadRunGraph(settings, scope);
    assert.equal(after.run.runId, before.run.runId);
    const attemptsByNode = Map.groupBy(after.attempts, ({ nodeId }) => nodeId);
    const n1Attempts = attemptsByNode.get("n1_extract") ?? [];
    const n2Attempts = attemptsByNode.get("n2_fail") ?? [];
    assert.equal(
      n1Attempts.length,
      1,
      "n1はpreservedされAttemptが増えないこと",
    );
    assert.equal(n2Attempts.length, 2, "n2はresumeでAttemptが1件増えること");
    const n2AttemptNos = n2Attempts
      .map(({ attemptNo }) => attemptNo)
      .toSorted((left, right) => left - right);
    assert.deepEqual(
      n2AttemptNos,
      [1, 2],
      "n2のattempt_no集合が{1,2}であること",
    );
    timingDiagnostics.targetAttemptStartedAt.resume =
      n2Attempts.find(({ attemptNo }) => attemptNo === 2)?.executionStartedAt ??
      null;
    assert.ok(
      attemptsByNode
        .get("n2_fail")
        .every(
          ({ status, resultCode }) =>
            status === "FAILED" && resultCode === "ASSERT_FAILED",
        ),
    );
    const states = byNode(after.states);
    assert.equal(states.get("n1_extract").status, "SUCCESS");
    assert.equal(states.get("n2_fail").status, "FAILED");
    assert.equal(states.get("n3_finalize").status, "BLOCKED");
    assert.equal(after.invocations.length, 2);
    const resumeInvocation = after.invocations.at(-1);
    assert.equal(resumeInvocation.mode, "RESUME");
    assert.deepEqual(resumeInvocation.preservedNodeIds, ["n1_extract"]);
    return {
      firstProcess: first,
      resumeProcess: resumed,
      before,
      after,
      networkId: fixture.networkId,
      timingDiagnostics,
    };
  } catch (error) {
    error.timingDiagnostics = timingDiagnostics;
    throw error;
  } finally {
    await fixture.dispose();
  }
});
