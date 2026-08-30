import assert from "node:assert/strict";

import {
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runM6,
} from "./support.mjs";

await runM6(import.meta.url, "resume-identity", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-m6-midfail.yaml");
  try {
    const initial = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
    );
    assert.equal(initial.exitCode, 1);
    const before = await loadRunGraph(settings, scope);
    assert.equal(before.run.status, "FAILED");
    assert.equal(
      before.invocations.length,
      1,
      "initial invocation must be unique",
    );
    const successfulBefore = before.attempts.filter(
      ({ status }) => status === "SUCCESS",
    );
    assert.ok(successfulBefore.length > 0);

    const resumed = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
      { resume: true },
    );
    assert.equal(
      resumed.exitCode,
      1,
      `resume exit: ${resumed.stderr || resumed.stdout}`,
    );
    assert.match(
      resumed.stdout,
      /^RESUME: /mu,
      `resume must take the RESUME path: ${resumed.stderr || resumed.stdout}`,
    );
    const after = await loadRunGraph(settings, scope);
    assert.equal(
      after.run.runId,
      before.run.runId,
      "resume must preserve run_id",
    );
    assert.equal(
      after.invocations.length,
      2,
      "resume must append one invocation",
    );
    assert.equal(
      new Set(after.invocations.map(({ invocationId }) => invocationId)).size,
      2,
      "invocation_id must change",
    );
    assert.ok(after.invocations.every(({ invocationId }) => invocationId));
    for (const successful of successfulBefore) {
      assert.equal(
        after.attempts.filter(({ nodeId }) => nodeId === successful.nodeId)
          .length,
        before.attempts.filter(({ nodeId }) => nodeId === successful.nodeId)
          .length,
        `SUCCESS node ${successful.nodeId} must not get a new Attempt`,
      );
    }
    return {
      initialProcess: initial,
      resumeProcess: resumed,
      networkId: fixture.networkId,
      before,
      after,
    };
  } finally {
    await fixture.dispose();
  }
});
