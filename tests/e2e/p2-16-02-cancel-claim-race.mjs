import assert from "node:assert/strict";

import {
  createAllowlist,
  getRequest,
  runPollRequests,
  startPollRequests,
} from "./p2-01-support.mjs";
import {
  assertStartCorrelation,
  createStartRequest,
  prepareP211Network,
  runP211,
  waitForTerminalRequest,
} from "./p2-11-support.mjs";
import {
  cleanupFaultBarrier,
  prepareFaultBarrier,
  putCancelRequested,
  readFaultBarrierEvents,
  releaseFaultBarrier,
  summarizeProcess,
  summarizeRequest,
  waitForBarrier,
} from "./p2-16-support.mjs";

function summarizeBarrier(event) {
  return {
    barrierId: event.barrier_id,
    phase: event.phase,
    method: event.method,
    path: event.path,
    ...(event.response_status === undefined
      ? {}
      : { responseStatus: event.response_status }),
  };
}

await runP211(
  import.meta.url,
  "p2-16-02-cancel-claim-race",
  async ({ settings, scope }) => {
    const fixture = await prepareP211Network(scope, "explicit");
    const allowlist = await createAllowlist([fixture]);
    let cancelFirstBarrier;
    let claimFirstBarrier;
    let poller;
    try {
      const cancelFirst = await createStartRequest(
        settings,
        scope,
        "cancel-wins",
        {
          networkId: fixture.networkId,
          businessKey: `${scope}_cancel_wins`,
        },
      );
      cancelFirstBarrier = await prepareFaultBarrier(fixture.directory, {
        label: "cancel-wins",
        barrierId: `${scope}_claim_before`,
        app: settings.requestAppId,
        recordId: cancelFirst.id,
        field: "claimed_at",
        phase: "before",
      });
      poller = await startPollRequests(settings, allowlist.path, {
        environment: cancelFirstBarrier.environment,
      });
      const cancelFirstEvent = await waitForBarrier(cancelFirstBarrier);
      assert.equal(cancelFirstEvent.phase, "before");
      assert.equal(cancelFirstEvent.response_status, undefined);
      const cancellation = await putCancelRequested(settings, cancelFirst);
      assert.equal(cancellation.status, 200);
      await releaseFaultBarrier(cancelFirstBarrier);
      const conflictedPoller = await poller.completion;
      poller = undefined;
      assert.equal(
        conflictedPoller.exitCode,
        0,
        conflictedPoller.stderr || conflictedPoller.stdout,
      );
      const afterConflict = await getRequest(settings, cancelFirst.id);
      assert.equal(afterConflict.requestState, "REQUESTED");
      assert.equal(afterConflict.cancelRequested, true);

      const nextPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(
        nextPoller.exitCode,
        0,
        nextPoller.stderr || nextPoller.stdout,
      );
      const cancelled = await waitForTerminalRequest(settings, cancelFirst.id);
      assert.equal(cancelled.requestState, "CANCELLED");
      assert.equal(cancelled.resultCode, "CANCELLED_BY_REQUESTER");
      assert.equal(cancelled.claimedAt, null);
      await assertStartCorrelation(settings, cancelled, "unused");

      const claimFirst = await createStartRequest(
        settings,
        scope,
        "claim-wins",
        {
          networkId: fixture.networkId,
          businessKey: `${scope}_claim_wins`,
        },
      );
      claimFirstBarrier = await prepareFaultBarrier(fixture.directory, {
        label: "claim-wins",
        barrierId: `${scope}_claim_after`,
        app: settings.requestAppId,
        recordId: claimFirst.id,
        field: "claimed_at",
        phase: "after-success",
      });
      poller = await startPollRequests(settings, allowlist.path, {
        environment: claimFirstBarrier.environment,
      });
      const claimFirstEvent = await waitForBarrier(claimFirstBarrier);
      assert.equal(claimFirstEvent.phase, "after-success");
      assert.ok(
        claimFirstEvent.response_status >= 200 &&
          claimFirstEvent.response_status < 300,
      );
      const accepted = await getRequest(settings, claimFirst.id);
      assert.equal(accepted.requestState, "ACCEPTED");
      const lateCancellation = await putCancelRequested(settings, claimFirst);
      assert.equal(lateCancellation.status, 409);
      await releaseFaultBarrier(claimFirstBarrier);
      const claimFirstPoller = await poller.completion;
      poller = undefined;
      assert.equal(
        claimFirstPoller.exitCode,
        0,
        claimFirstPoller.stderr || claimFirstPoller.stdout,
      );
      const terminal = await waitForTerminalRequest(settings, claimFirst.id);
      assert.ok(["DONE", "REJECTED"].includes(terminal.requestState));
      assert.notEqual(terminal.requestState, "CANCELLED");
      const correlation =
        terminal.requestState === "DONE"
          ? await assertStartCorrelation(
              settings,
              terminal,
              `${scope}_claim_wins`,
            )
          : null;

      const cancelFirstEvents = (
        await readFaultBarrierEvents(cancelFirstBarrier)
      ).map(summarizeBarrier);
      const claimFirstEvents = (
        await readFaultBarrierEvents(claimFirstBarrier)
      ).map(summarizeBarrier);
      assert.equal(cancelFirstEvents.length, 1);
      assert.equal(claimFirstEvents.length, 1);
      assert.equal(claimFirstEvents[0].responseStatus, 200);
      return {
        networkId: fixture.networkId,
        cancelFirst: {
          barrier: cancelFirstEvents[0],
          firstPoller: summarizeProcess(conflictedPoller),
          nextPoller: summarizeProcess(nextPoller),
          request: summarizeRequest(cancelled),
        },
        claimFirst: {
          barrier: claimFirstEvents[0],
          cancelPutStatus: lateCancellation.status,
          poller: summarizeProcess(claimFirstPoller),
          request: summarizeRequest(terminal),
          invocationCount: correlation?.graph.invocations.length ?? 0,
        },
      };
    } finally {
      if (cancelFirstBarrier) await releaseFaultBarrier(cancelFirstBarrier);
      if (claimFirstBarrier) await releaseFaultBarrier(claimFirstBarrier);
      if (poller?.child.exitCode === null) poller.child.kill("SIGKILL");
      await Promise.allSettled([
        cleanupFaultBarrier(cancelFirstBarrier),
        cleanupFaultBarrier(claimFirstBarrier),
      ]);
      await Promise.all([allowlist.dispose(), fixture.dispose()]);
    }
  },
);
