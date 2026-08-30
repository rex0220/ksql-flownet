import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runM5,
} from "./support.mjs";

await runM5(import.meta.url, "mid-failure", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-midfail.yaml");
  try {
    const processResult = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
    );
    assert.equal(processResult.exitCode, 1);
    const graph = await loadRunGraph(settings, scope);
    const states = byNode(graph.states);
    const attempts = byNode(graph.attempts);
    assert.equal(graph.run.status, "FAILED");
    assert.equal(states.get("n1_extract").status, "SUCCESS");
    assert.equal(states.get("n2_fail").status, "FAILED");
    assert.equal(states.get("n2_fail").statusReason, "ASSERT_FAILED");
    assert.equal(states.get("n3_finalize").status, "BLOCKED");
    assert.deepEqual(states.get("n3_finalize").blockedBy, ["n2_fail"]);
    assert.equal(attempts.get("n2_fail").status, "FAILED");
    assert.equal(attempts.get("n2_fail").resultCode, "ASSERT_FAILED");
    assert.equal(graph.invocations.at(-1).status, "FAILED");
    return { process: processResult, graph, networkId: fixture.networkId };
  } finally {
    await fixture.dispose();
  }
});
