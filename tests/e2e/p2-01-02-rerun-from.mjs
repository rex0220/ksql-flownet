import assert from "node:assert/strict";

import { byNode, loadRunGraph, runFlowNetNetwork } from "./support.mjs";
import {
  createAllowlist,
  createRequest,
  getRequest,
  P2_01_PREFIX,
  prepareP201Network,
  requestReason,
  runP201,
  runPollRequests,
} from "./p2-01-support.mjs";

await runP201(import.meta.url, "02-rerun-from", async ({ settings, scope }) => {
  const rerunFixture = await prepareP201Network(
    `${scope}_rerun`,
    "network-success.yaml",
  );
  const brakeFixture = await prepareP201Network(
    `${scope}_brake`,
    "network-brake.yaml",
  );
  const allowlist = await createAllowlist([rerunFixture, brakeFixture]);
  try {
    const rerunBusinessKey = `${scope}_rerun`;
    const initial = await runFlowNetNetwork(
      settings,
      rerunFixture.networkPath,
      rerunBusinessKey,
      { environment: { KSQL_TOKEN_DEALS: `${P2_01_PREFIX}invalid` } },
    );
    assert.equal(initial.exitCode, 1, initial.stderr || initial.stdout);
    const before = await loadRunGraph(settings, rerunBusinessKey);
    const n1 = rerunFixture.nodeId("n1_extract");
    const n2 = rerunFixture.nodeId("n2_aggregate");
    assert.equal(byNode(before.states).get(n1).status, "SUCCESS");
    assert.equal(byNode(before.states).get(n2).status, "FAILED");
    const n1AttemptsBefore = before.attempts.filter(
      ({ nodeId }) => nodeId === n1,
    ).length;

    const rerunRequest = await createRequest(settings, {
      requestType: "RERUN",
      runId: before.run.runId,
      rerunFromNode: n2,
      reason: requestReason(scope, "rerun-from-idempotent-node"),
    });
    const rerunPoller = await runPollRequests(settings, allowlist.path);
    assert.equal(rerunPoller.exitCode, 0, rerunPoller.stderr);
    const rerunResult = await getRequest(settings, rerunRequest.id);
    assert.equal(rerunResult.requestState, "DONE");
    const after = await loadRunGraph(settings, rerunBusinessKey);
    assert.equal(after.run.status, "SUCCESS");
    assert.equal(after.invocations.at(-1).mode, "RERUN_FROM");
    assert.equal(
      after.attempts.filter(({ nodeId }) => nodeId === n1).length,
      n1AttemptsBefore,
      "rerun-fromより上流のSUCCESS Nodeは再実行しません",
    );

    const brakeBusinessKey = `${scope}_brake`;
    const brakeProcesses = [];
    brakeProcesses.push(
      await runFlowNetNetwork(
        settings,
        brakeFixture.networkPath,
        brakeBusinessKey,
      ),
    );
    let brakedGraph = await loadRunGraph(settings, brakeBusinessKey);
    for (let retry = 0; retry < 2; retry += 1) {
      brakeProcesses.push(
        await runFlowNetNetwork(settings, brakeFixture.networkPath, "", {
          resumeRun: brakedGraph.run.runId,
        }),
      );
      brakedGraph = await loadRunGraph(settings, brakeBusinessKey);
    }
    assert.ok(brakeProcesses.every(({ exitCode }) => exitCode === 1));
    const failingNode = brakeFixture.nodeId("n1_deterministic_fail");
    const failedAttempts = brakedGraph.attempts.filter(
      ({ nodeId }) => nodeId === failingNode,
    ).length;
    assert.equal(failedAttempts, 3);

    const brakeRequest = await createRequest(settings, {
      requestType: "RERUN",
      runId: brakedGraph.run.runId,
      reason: requestReason(scope, "observe-retry-brake"),
    });
    const brakePoller = await runPollRequests(settings, allowlist.path);
    assert.equal(brakePoller.exitCode, 0, brakePoller.stderr);
    const brakeResult = await getRequest(settings, brakeRequest.id);
    assert.equal(brakeResult.requestState, "DONE");
    assert.equal(brakeResult.resultCode, "RETRY_BRAKE");

    const releaseBrakeRequest = await createRequest(settings, {
      requestType: "RERUN",
      runId: brakedGraph.run.runId,
      rerunFromNode: failingNode,
      reason: requestReason(scope, "release-retry-brake"),
    });
    const releaseBrakePoller = await runPollRequests(settings, allowlist.path);
    assert.equal(releaseBrakePoller.exitCode, 0, releaseBrakePoller.stderr);
    const releaseBrakeResult = await getRequest(
      settings,
      releaseBrakeRequest.id,
    );
    assert.equal(releaseBrakeResult.requestState, "DONE");
    assert.notEqual(releaseBrakeResult.resultCode, "RETRY_BRAKE");
    const afterBrakeRelease = await loadRunGraph(settings, brakeBusinessKey);
    assert.equal(afterBrakeRelease.invocations.at(-1).mode, "RERUN_FROM");
    assert.equal(
      afterBrakeRelease.attempts.filter(({ nodeId }) => nodeId === failingNode)
        .length,
      failedAttempts + 1,
    );
    return {
      rerunFrom: {
        networkId: rerunFixture.networkId,
        initial,
        poller: rerunPoller,
        request: rerunResult,
        before,
        after,
      },
      retryBrake: {
        networkId: brakeFixture.networkId,
        setupProcesses: brakeProcesses,
        brakePoller,
        brakeRequest: brakeResult,
        releasePoller: releaseBrakePoller,
        releaseRequest: releaseBrakeResult,
        beforeRelease: brakedGraph,
        afterRelease: afterBrakeRelease,
      },
    };
  } finally {
    await Promise.all([
      allowlist.dispose(),
      rerunFixture.dispose(),
      brakeFixture.dispose(),
    ]);
  }
});
