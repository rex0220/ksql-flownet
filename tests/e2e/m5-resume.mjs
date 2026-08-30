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
  try {
    const first = await runFlowNetNetwork(settings, fixture.networkPath, scope);
    assert.equal(first.exitCode, 1);
    const before = await loadRunGraph(settings, scope);
    const n1Before = before.attempts.filter(
      ({ nodeId }) => nodeId === "n1_extract",
    );
    assert.equal(n1Before.length, 1);
    assert.equal(n1Before[0].status, "SUCCESS");

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
    assert.equal(attemptsByNode.get("n1_extract").length, 1);
    assert.equal(attemptsByNode.get("n2_fail").length, 2);
    assert.deepEqual(
      attemptsByNode.get("n2_fail").map(({ attemptNo }) => attemptNo),
      [1, 2],
    );
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
    };
  } finally {
    await fixture.dispose();
  }
});
