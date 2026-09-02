import assert from "node:assert/strict";

import {
  loadRunGraph,
  runFlowNetCommand,
  runFlowNetNetwork,
} from "./support.mjs";
import {
  createAllowlist,
  createRequest,
  getRequest,
  requestReason,
  runPollRequests,
} from "./p2-01-support.mjs";
import {
  createStartRequest,
  graphIdentity,
  pollAndWait,
  prepareP211Network,
  runP211,
} from "./p2-11-support.mjs";

await runP211(
  import.meta.url,
  "p2-11-05-stale-regression",
  async ({ settings, scope }) => {
    const staleFixture = await prepareP211Network(`${scope}_stale`, "explicit");
    const rerunFixture = await prepareP211Network(`${scope}_rerun`, "explicit");
    rerunFixture.appStart = false;
    const cronFixture = await prepareP211Network(`${scope}_cron`, "scheduled");
    const allowlist = await createAllowlist([
      staleFixture,
      rerunFixture,
      cronFixture,
    ]);
    try {
      const staleKey = `${scope}_stale_key`;
      const completedChild = await runFlowNetNetwork(
        settings,
        staleFixture.networkPath,
        staleKey,
      );
      assert.equal(completedChild.exitCode, 0, completedChild.stderr);
      const beforeStale = await loadRunGraph(settings, staleKey);
      const oldHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
      const crashedClaim = await createStartRequest(
        settings,
        scope,
        "claimed-then-crashed",
        {
          networkId: staleFixture.networkId,
          businessKey: staleKey,
          machine: {
            requestState: "ACCEPTED",
            claimedAt: oldHeartbeat,
            claimedHost: `${scope}_dead_poller`,
            claimHeartbeatAt: oldHeartbeat,
          },
        },
      );
      const stalePoller = await runPollRequests(settings, allowlist.path, {
        heartbeatIntervalMs: 500,
        staleAfterMs: 1_000,
      });
      assert.equal(stalePoller.exitCode, 0, stalePoller.stderr);
      assert.match(stalePoller.stdout, /stale=1/u);
      const staleRequest = await getRequest(settings, crashedClaim.id);
      assert.equal(staleRequest.requestState, "REJECTED");
      assert.equal(staleRequest.resultCode, "STALE");
      assert.deepEqual(
        graphIdentity(await loadRunGraph(settings, staleKey)),
        graphIdentity(beforeStale),
        "START stale回収はRun/Invocationを追加しません",
      );
      const retry = await pollAndWait(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "human-retry-after-stale", {
          networkId: staleFixture.networkId,
          businessKey: staleKey,
        }),
      );
      assert.equal(retry.request.requestState, "DONE");
      assert.equal(retry.request.resultCode, "NOOP_ALREADY_SUCCESS");

      const rerunKey = `${scope}_app_start_false_rerun`;
      const failed = await runFlowNetNetwork(
        settings,
        rerunFixture.networkPath,
        rerunKey,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${scope}_invalid` } },
      );
      assert.equal(failed.exitCode, 1, failed.stderr || failed.stdout);
      const rerunBefore = await loadRunGraph(settings, rerunKey);
      const rerunRequest = await createRequest(settings, {
        requestType: "RERUN",
        runId: rerunBefore.run.runId,
        reason: requestReason(scope, "app-start-false-rerun"),
      });
      const rerunPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(rerunPoller.exitCode, 0, rerunPoller.stderr);
      const rerunResult = await getRequest(settings, rerunRequest.id);
      assert.equal(rerunResult.requestState, "DONE");
      const rerunAfter = await loadRunGraph(settings, rerunKey);
      assert.equal(rerunAfter.run.status, "SUCCESS");
      assert.equal(
        rerunAfter.invocations.length,
        rerunBefore.invocations.length + 1,
      );

      const cronScheduledFor = "2026-09-15T00:00:00.000Z";
      const cron = await runFlowNetCommand(settings, [
        "run-network",
        cronFixture.networkPath,
        "--scheduled-for",
        cronScheduledFor,
        "--resume",
        "--json",
      ]);
      assert.equal(cron.exitCode, 0, cron.stderr || cron.stdout);
      const cronGraph = await loadRunGraph(
        settings,
        `${cronFixture.networkId}@2026-09`,
      );
      assert.equal(cronGraph.run.status, "SUCCESS");
      assert.equal(
        Date.parse(cronGraph.run.asOf),
        Date.parse(cronScheduledFor),
      );
      return {
        stale: { completedChild, request: staleRequest, poller: stalePoller },
        retry,
        appStartFalseRerun: { failed, rerunResult, rerunBefore, rerunAfter },
        cronRegression: { command: cron, graph: cronGraph },
      };
    } finally {
      await Promise.all([
        allowlist.dispose(),
        staleFixture.dispose(),
        rerunFixture.dispose(),
        cronFixture.dispose(),
      ]);
    }
  },
);
