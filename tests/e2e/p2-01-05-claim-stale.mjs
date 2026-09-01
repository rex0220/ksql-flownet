import assert from "node:assert/strict";

import {
  loadRunGraph,
  runFlowNetNetwork,
  waitFor,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";
import {
  createAllowlist,
  createRequest,
  getRequest,
  P2_01_PREFIX,
  prepareP201Network,
  requestReason,
  runP201,
  runPollRequests,
  startPollRequests,
  waitForRequest,
} from "./p2-01-support.mjs";

await runP201(
  import.meta.url,
  "05-claim-stale",
  async ({ settings, scope }) => {
    const claimFixture = await prepareP201Network(
      `${scope}_claim`,
      "network-success.yaml",
    );
    const unexecutedFixture = await prepareP201Network(
      `${scope}_unexecuted`,
      "network-success.yaml",
    );
    const heartbeatFixture = await prepareP201Network(
      `${scope}_heartbeat`,
      "network-drill.yaml",
    );
    const allowlist = await createAllowlist([
      claimFixture,
      unexecutedFixture,
      heartbeatFixture,
    ]);
    const activePollers = new Set();
    try {
      const claimBusinessKey = `${scope}_claim`;
      const claimInitial = await runFlowNetNetwork(
        settings,
        claimFixture.networkPath,
        claimBusinessKey,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${P2_01_PREFIX}invalid` } },
      );
      assert.equal(claimInitial.exitCode, 1);
      const claimBefore = await loadRunGraph(settings, claimBusinessKey);
      const claimRequest = await createRequest(settings, {
        requestType: "RERUN",
        runId: claimBefore.run.runId,
        reason: requestReason(scope, "concurrent-claim"),
      });
      const claimers = [
        startPollRequests(settings, allowlist.path),
        startPollRequests(settings, allowlist.path),
      ];
      for (const claimer of claimers) activePollers.add(claimer);
      const claimResults = await Promise.all(
        claimers.map(({ completion }) => completion),
      );
      for (const claimer of claimers) activePollers.delete(claimer);
      assert.ok(claimResults.every(({ exitCode }) => exitCode === 0));
      assert.deepEqual(
        claimResults
          .map(({ stdout }) => Number(stdout.match(/claimed=(\d+)/u)?.[1]))
          .toSorted(),
        [0, 1],
        "同一要求を実行するclaimは一方だけです",
      );
      const claimed = await getRequest(settings, claimRequest.id);
      assert.equal(claimed.requestState, "DONE");
      const claimAfter = await loadRunGraph(settings, claimBusinessKey);
      assert.equal(
        claimAfter.invocations.length,
        claimBefore.invocations.length + 1,
      );

      const unexecutedBusinessKey = `${scope}_unexecuted`;
      const unexecutedInitial = await runFlowNetNetwork(
        settings,
        unexecutedFixture.networkPath,
        unexecutedBusinessKey,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${P2_01_PREFIX}invalid` } },
      );
      assert.equal(unexecutedInitial.exitCode, 1);
      const unexecutedBefore = await loadRunGraph(
        settings,
        unexecutedBusinessKey,
      );
      const oldHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
      const staleExecuted = await createRequest(settings, {
        requestType: "RERUN",
        runId: claimAfter.run.runId,
        reason: requestReason(scope, "stale-after-executed-child"),
        machine: {
          requestState: "ACCEPTED",
          claimedAt: oldHeartbeat,
          claimedHost: `${P2_01_PREFIX}dead_poller`,
          claimHeartbeatAt: oldHeartbeat,
        },
      });
      const staleUnexecuted = await createRequest(settings, {
        requestType: "RERUN",
        runId: unexecutedBefore.run.runId,
        reason: requestReason(scope, "stale-before-child"),
        machine: {
          requestState: "ACCEPTED",
          claimedAt: oldHeartbeat,
          claimedHost: `${P2_01_PREFIX}dead_poller`,
          claimHeartbeatAt: oldHeartbeat,
        },
      });
      const invocationsBeforeStale = {
        executed: claimAfter.invocations.length,
        unexecuted: unexecutedBefore.invocations.length,
      };
      const stalePoller = await runPollRequests(settings, allowlist.path, {
        heartbeatIntervalMs: 500,
        staleAfterMs: 1_000,
      });
      assert.equal(stalePoller.exitCode, 0, stalePoller.stderr);
      assert.match(stalePoller.stdout, /stale=2/u);
      const staleResults = await Promise.all(
        [staleExecuted.id, staleUnexecuted.id].map((id) =>
          getRequest(settings, id),
        ),
      );
      for (const result of staleResults) {
        assert.equal(result.requestState, "REJECTED");
        assert.equal(result.resultCode, "STALE");
        assert.match(result.resultMessage, /do not request another operation/u);
      }
      assert.equal(
        (await loadRunGraph(settings, claimBusinessKey)).invocations.length,
        invocationsBeforeStale.executed,
      );
      assert.equal(
        (await loadRunGraph(settings, unexecutedBusinessKey)).invocations
          .length,
        invocationsBeforeStale.unexecuted,
      );

      const heartbeatBusinessKey = `${scope}_heartbeat`;
      const heartbeatInitial = await runFlowNetNetwork(
        settings,
        heartbeatFixture.networkPath,
        heartbeatBusinessKey,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${P2_01_PREFIX}invalid` } },
      );
      assert.equal(heartbeatInitial.exitCode, 1);
      const heartbeatBefore = await loadRunGraph(
        settings,
        heartbeatBusinessKey,
      );
      const heartbeatRequest = await createRequest(settings, {
        requestType: "RERUN",
        runId: heartbeatBefore.run.runId,
        reason: requestReason(scope, "heartbeat-long-child"),
      });
      const longPoller = startPollRequests(settings, allowlist.path, {
        heartbeatIntervalMs: 500,
        staleAfterMs: 1_000,
      });
      activePollers.add(longPoller);
      const accepted = await waitForRequest(
        settings,
        heartbeatRequest.id,
        ({ requestState }) => requestState === "ACCEPTED",
        "long child request ACCEPTED",
      );
      const heartbeat1 = accepted.claimHeartbeatAt;
      const heartbeat2 = await waitFor(async () => {
        const current = await getRequest(settings, heartbeatRequest.id);
        return current.requestState === "ACCEPTED" &&
          current.revision > accepted.revision
          ? current
          : null;
      }, "claim heartbeat update");
      assert.ok(heartbeat2.revision > accepted.revision);
      const running = await waitForRunGraph(
        settings,
        heartbeatBusinessKey,
        (graph) =>
          graph.attempts.some(
            ({ nodeId, status }) =>
              nodeId === heartbeatFixture.nodeId("n1_longread") &&
              status === "RUNNING",
          ),
      );
      const runningAttempt = running.attempts.find(
        ({ nodeId, status }) =>
          nodeId === heartbeatFixture.nodeId("n1_longread") &&
          status === "RUNNING",
      );
      await waitForRunningJobLog(
        settings,
        runningAttempt.attemptId,
        heartbeatFixture.jobId("m6_longread"),
      );
      const competingPoller = await runPollRequests(settings, allowlist.path, {
        heartbeatIntervalMs: 500,
        staleAfterMs: 1_000,
      });
      assert.equal(competingPoller.exitCode, 0, competingPoller.stderr);
      assert.match(competingPoller.stdout, /stale=0/u);
      const longPollerResult = await longPoller.completion;
      activePollers.delete(longPoller);
      assert.equal(longPollerResult.exitCode, 0, longPollerResult.stderr);
      const heartbeatDone = await getRequest(settings, heartbeatRequest.id);
      assert.equal(heartbeatDone.requestState, "DONE");
      assert.notEqual(heartbeatDone.resultCode, "STALE");

      return {
        concurrentClaim: {
          processes: claimResults,
          request: claimed,
          before: claimBefore,
          after: claimAfter,
        },
        stale: {
          poller: stalePoller,
          results: staleResults,
          invocationsBeforeStale,
        },
        heartbeat: {
          first: {
            revision: accepted.revision,
            claimHeartbeatAt: heartbeat1,
          },
          second: {
            revision: heartbeat2.revision,
            claimHeartbeatAt: heartbeat2.claimHeartbeatAt,
          },
          competingPoller,
          longPoller: longPollerResult,
          request: heartbeatDone,
        },
      };
    } finally {
      for (const poller of activePollers) {
        if (poller.child.exitCode === null) poller.child.kill("SIGKILL");
      }
      await Promise.all([
        allowlist.dispose(),
        claimFixture.dispose(),
        unexecutedFixture.dispose(),
        heartbeatFixture.dispose(),
      ]);
    }
  },
);
