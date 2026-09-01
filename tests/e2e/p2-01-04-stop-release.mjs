import assert from "node:assert/strict";

import {
  byNode,
  loadRunGraph,
  runFlowNetStatus,
  startFlowNetNetwork,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";
import {
  createAllowlist,
  createRequest,
  getRequest,
  prepareP201Network,
  requestReason,
  runP201,
  runPollRequests,
} from "./p2-01-support.mjs";

await runP201(
  import.meta.url,
  "04-stop-release",
  async ({ settings, scope }) => {
    const fixture = await prepareP201Network(scope, "network-drill.yaml");
    const allowlist = await createAllowlist([fixture]);
    let network;
    try {
      network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
      const running = await waitForRunGraph(settings, scope, (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === fixture.nodeId("n1_longread") && status === "RUNNING",
        ),
      );
      const runningAttempt = running.attempts.find(
        ({ nodeId, status }) =>
          nodeId === fixture.nodeId("n1_longread") && status === "RUNNING",
      );
      await waitForRunningJobLog(
        settings,
        runningAttempt.attemptId,
        fixture.jobId("m6_longread"),
      );

      const stopRequest = await createRequest(settings, {
        requestType: "STOP",
        runId: running.run.runId,
        reason: requestReason(scope, "stop-at-node-boundary"),
      });
      const stopPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(stopPoller.exitCode, 0, stopPoller.stderr);
      const stopResult = await getRequest(settings, stopRequest.id);
      assert.equal(stopResult.requestState, "DONE");
      assert.equal(stopResult.resultCode, "STOP_REQUESTED");

      const stoppedProcess = await network.completion;
      network = undefined;
      assert.equal(stoppedProcess.exitCode, 1);
      const held = await loadRunGraph(settings, scope);
      assert.equal(held.invocations.at(-1).status, "CANCELLED");
      assert.equal(held.invocations.at(-1).resultCode, "STOP_REQUESTED");
      assert.equal(
        byNode(held.states).get(fixture.nodeId("n2_independent"))
          .latestAttemptNo,
        0,
      );
      const heldStatus = await runFlowNetStatus(settings, fixture.networkId, {
        runId: held.run.runId,
      });
      assert.equal(heldStatus.output.runs[0].activity, "STOPPED");

      const invocationsBeforeRelease = held.invocations.length;
      const releaseRequest = await createRequest(settings, {
        requestType: "RELEASE",
        runId: held.run.runId,
        reason: requestReason(scope, "release-hold-only"),
      });
      const releasePoller = await runPollRequests(settings, allowlist.path);
      assert.equal(releasePoller.exitCode, 0, releasePoller.stderr);
      const releaseResult = await getRequest(settings, releaseRequest.id);
      assert.equal(releaseResult.requestState, "DONE");
      assert.equal(releaseResult.resultCode, "RELEASED");
      const released = await loadRunGraph(settings, scope);
      assert.equal(
        released.invocations.length,
        invocationsBeforeRelease,
        "RELEASE単独ではRunを起動しません",
      );
      const releasedStatus = await runFlowNetStatus(
        settings,
        fixture.networkId,
        { runId: held.run.runId },
      );
      assert.equal(releasedStatus.output.runs[0].activity, "INTERRUPTED");

      const rerunRequest = await createRequest(settings, {
        requestType: "RERUN",
        runId: held.run.runId,
        reason: requestReason(scope, "rerun-after-release"),
      });
      assert.notEqual(rerunRequest.id, releaseRequest.id);
      const rerunPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(rerunPoller.exitCode, 0, rerunPoller.stderr);
      const rerunResult = await getRequest(settings, rerunRequest.id);
      assert.equal(rerunResult.requestState, "DONE");
      const completed = await loadRunGraph(settings, scope);
      assert.equal(completed.run.status, "SUCCESS");
      assert.equal(completed.invocations.length, invocationsBeforeRelease + 1);

      const releaseWithoutHoldRequest = await createRequest(settings, {
        requestType: "RELEASE",
        runId: completed.run.runId,
        reason: requestReason(scope, "reject-release-without-hold"),
      });
      const releaseWithoutHoldPoller = await runPollRequests(
        settings,
        allowlist.path,
      );
      assert.equal(releaseWithoutHoldPoller.exitCode, 0);
      const releaseWithoutHold = await getRequest(
        settings,
        releaseWithoutHoldRequest.id,
      );
      assert.equal(releaseWithoutHold.requestState, "REJECTED");
      assert.equal(releaseWithoutHold.resultCode, "RUN_NOT_ON_HOLD");
      assert.equal(
        (await loadRunGraph(settings, scope)).invocations.length,
        completed.invocations.length,
        "holdなしRELEASEはRunを起動しません",
      );
      return {
        networkId: fixture.networkId,
        runId: held.run.runId,
        releaseWithoutHold: {
          poller: releaseWithoutHoldPoller,
          request: releaseWithoutHold,
        },
        stop: { poller: stopPoller, request: stopResult, stoppedProcess },
        held,
        release: {
          poller: releasePoller,
          request: releaseResult,
          status: releasedStatus.output,
        },
        rerun: { poller: rerunPoller, request: rerunResult, completed },
      };
    } finally {
      if (network?.child.exitCode === null) network.child.kill("SIGKILL");
      await Promise.all([allowlist.dispose(), fixture.dispose()]);
    }
  },
);
