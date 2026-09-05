import assert from "node:assert/strict";

import {
  loadRunGraph,
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
import {
  getRunHold,
  summarizeProcess,
  summarizeRequest,
} from "./p2-16-support.mjs";

await runP201(
  import.meta.url,
  "p2-16-03-terminal-hold-release",
  async ({ settings, scope }) => {
    const fixture = await prepareP201Network(
      scope,
      "network-p216-longfail.yaml",
    );
    const allowlist = await createAllowlist([fixture]);
    let network;
    try {
      network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
      const running = await waitForRunGraph(settings, scope, (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === fixture.nodeId("n1_longfail") && status === "RUNNING",
        ),
      );
      const runningAttempt = running.attempts.find(
        ({ nodeId, status }) =>
          nodeId === fixture.nodeId("n1_longfail") && status === "RUNNING",
      );
      await waitForRunningJobLog(
        settings,
        runningAttempt.attemptId,
        fixture.jobId("p216_longfail"),
      );

      const stop = await createRequest(settings, {
        requestType: "STOP",
        runId: running.run.runId,
        reason: requestReason(scope, "stop-before-longfail"),
      });
      const stopPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(
        stopPoller.exitCode,
        0,
        stopPoller.stderr || stopPoller.stdout,
      );
      const stopResult = await getRequest(settings, stop.id);
      assert.equal(stopResult.requestState, "DONE");
      assert.equal(stopResult.resultCode, "STOP_REQUESTED");

      const failedProcess = await network.completion;
      network = undefined;
      assert.equal(failedProcess.exitCode, 1);
      const heldGraph = await loadRunGraph(settings, scope);
      assert.equal(heldGraph.run.status, "FAILED");
      const heldStatus = await getRunHold(
        settings,
        fixture.networkId,
        heldGraph.run.runId,
      );
      assert.ok(heldStatus.hold, "terminal FAILED Run must retain its hold");
      assert.ok(["REQUESTED", "ACCEPTED"].includes(heldStatus.hold.state));

      const invocationsBeforeRelease = heldGraph.invocations.length;
      const release = await createRequest(settings, {
        requestType: "RELEASE",
        runId: heldGraph.run.runId,
        reason: requestReason(scope, "release-terminal-hold"),
      });
      const releasePoller = await runPollRequests(settings, allowlist.path);
      assert.equal(
        releasePoller.exitCode,
        0,
        releasePoller.stderr || releasePoller.stdout,
      );
      const releaseResult = await getRequest(settings, release.id);
      assert.equal(releaseResult.requestState, "DONE");
      assert.equal(releaseResult.resultCode, "RELEASED");
      const releasedStatus = await getRunHold(
        settings,
        fixture.networkId,
        heldGraph.run.runId,
      );
      assert.equal(releasedStatus.hold, null);
      assert.equal(
        (await loadRunGraph(settings, scope)).invocations.length,
        invocationsBeforeRelease,
        "RELEASE must not start an Invocation",
      );

      const rerun = await createRequest(settings, {
        requestType: "RERUN",
        runId: heldGraph.run.runId,
        reason: requestReason(scope, "rerun-after-terminal-release"),
      });
      const rerunPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(
        rerunPoller.exitCode,
        0,
        rerunPoller.stderr || rerunPoller.stdout,
      );
      const rerunResult = await getRequest(settings, rerun.id);
      assert.equal(rerunResult.requestState, "DONE");
      const rerunGraph = await loadRunGraph(settings, scope);
      assert.equal(rerunGraph.run.status, "FAILED");
      assert.equal(rerunGraph.invocations.length, invocationsBeforeRelease + 1);
      assert.ok(
        rerunGraph.attempts.length > heldGraph.attempts.length,
        "RERUN must create a Node Attempt",
      );

      return {
        networkId: fixture.networkId,
        runId: heldGraph.run.runId,
        stop: {
          request: summarizeRequest(stopResult),
          poller: summarizeProcess(stopPoller),
        },
        terminalFailure: {
          process: summarizeProcess(failedProcess),
          status: heldGraph.run.status,
          holdState: heldStatus.hold.state,
        },
        release: {
          request: summarizeRequest(releaseResult),
          poller: summarizeProcess(releasePoller),
          holdAfter: releasedStatus.hold,
        },
        rerun: {
          request: summarizeRequest(rerunResult),
          poller: summarizeProcess(rerunPoller),
          invocationCount: rerunGraph.invocations.length,
          attemptCount: rerunGraph.attempts.length,
        },
      };
    } finally {
      if (network?.child.exitCode === null) network.child.kill("SIGKILL");
      await Promise.all([allowlist.dispose(), fixture.dispose()]);
    }
  },
);
