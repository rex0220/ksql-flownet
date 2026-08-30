import assert from "node:assert/strict";

import {
  byNode,
  describeRunIdentity,
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runM5,
} from "./support.mjs";

await runM5(import.meta.url, "resume", async ({ settings, scope, timing }) => {
  const fixture = await prepareNetwork(scope, "network-midfail.yaml");
  const fixedInput = Object.freeze({
    profile: settings.profile,
    networkPath: fixture.networkPath,
    networkId: fixture.networkId,
    businessKey: scope,
  });
  const resumeDiagnostics = {
    calls: [],
    persistedRun: null,
  };
  const recordCall = (phase) => {
    const call = {
      phase,
      networkPath: fixedInput.networkPath,
      ...describeRunIdentity(
        fixedInput.profile,
        fixedInput.networkId,
        fixedInput.businessKey,
      ),
    };
    resumeDiagnostics.calls.push(call);
    return call;
  };
  try {
    const initialInput = recordCall("initial");
    timing.mark("initialNetworkStartedAt");
    const first = await runFlowNetNetwork(
      settings,
      fixedInput.networkPath,
      fixedInput.businessKey,
    );
    timing.mark("initialNetworkFinishedAt");
    timing.measure(
      "initialNetworkMs",
      "initialNetworkStartedAt",
      "initialNetworkFinishedAt",
    );
    assert.equal(first.exitCode, 1);
    const before = await loadRunGraph(settings, fixedInput.businessKey);
    resumeDiagnostics.persistedRun = {
      recordKey: before.run.recordKey,
      networkId: before.run.networkId,
      businessKey: before.run.businessKey,
      resolvedProfile: before.run.resolvedProfile,
      r1FromPersistedFields:
        before.run.resolvedProfile === null
          ? null
          : describeRunIdentity(
              before.run.resolvedProfile,
              before.run.networkId,
              before.run.businessKey,
            ).r1Key,
    };
    const n1Before = before.attempts.filter(
      ({ nodeId }) => nodeId === "n1_extract",
    );
    assert.equal(n1Before.length, 1);
    assert.equal(n1Before[0].status, "SUCCESS");

    const resumeInput = recordCall("resume");
    assert.deepEqual(
      { ...resumeInput, phase: undefined },
      { ...initialInput, phase: undefined },
      "2回のrun-network呼出しはprofile/networkPath/networkId/businessKey/R1が完全同一であること",
    );
    timing.mark("resumeNetworkStartedAt");
    const resumed = await runFlowNetNetwork(
      settings,
      fixedInput.networkPath,
      fixedInput.businessKey,
      { resume: true },
    );
    timing.mark("resumeNetworkFinishedAt");
    timing.measure(
      "resumeNetworkMs",
      "resumeNetworkStartedAt",
      "resumeNetworkFinishedAt",
    );
    assert.equal(resumed.exitCode, 1);
    const after = await loadRunGraph(settings, fixedInput.businessKey);
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
    const resumeInvocations = after.invocations.filter(
      ({ mode }) => mode === "RESUME",
    );
    assert.equal(resumeInvocations.length, 1);
    const [resumeInvocation] = resumeInvocations;
    assert.deepEqual(resumeInvocation.preservedNodeIds, ["n1_extract"]);
    return {
      firstProcess: first,
      resumeProcess: resumed,
      before,
      after,
      networkId: fixture.networkId,
      resumeDiagnostics,
    };
  } catch (error) {
    error.resumeDiagnostics = resumeDiagnostics;
    throw error;
  } finally {
    await fixture.dispose();
  }
});
