import assert from "node:assert/strict";

import {
  loadRunGraph,
  runFlowNetNetwork,
  startFlowNetNetwork,
} from "./support.mjs";
import {
  prepareP201Network,
  requestReason,
  runP201,
} from "./p2-01-support.mjs";
import {
  cleanupFaultBarrier,
  loadRunLifecycle,
  prepareFaultBarrier,
  readFaultBarrierEvents,
  releaseFaultBarrier,
  runArchiveRun,
  waitForBarrier,
} from "./p2-16-support.mjs";

const processSummary = ({ exitCode, signal }) => ({ exitCode, signal });

await runP201(
  import.meta.url,
  "p2-16-05-close-rerun-race",
  async ({ settings, scope }) => {
    const fixture = await prepareP201Network(
      scope,
      "network-p216-longfail.yaml",
    );
    let barrier;
    let resumed;
    try {
      const initial = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        scope,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${scope}_invalid` } },
      );
      assert.equal(initial.exitCode, 1);
      const failed = await loadRunGraph(settings, scope);
      assert.equal(failed.run.status, "FAILED");
      const attemptsBeforeResume = failed.attempts.length;

      barrier = await prepareFaultBarrier(fixture.directory, {
        label: "resume-heartbeat",
        barrierId: `${scope}_heartbeat_after`,
        app: settings.stateAppId,
        field: "heartbeat_at",
        phase: "after-success",
      });
      resumed = await startFlowNetNetwork(settings, fixture.networkPath, "", {
        resumeRun: failed.run.runId,
        environment: barrier.environment,
      });
      const heartbeat = await waitForBarrier(barrier);
      assert.equal(heartbeat.phase, "after-success");
      assert.ok(
        heartbeat.response_status >= 200 && heartbeat.response_status < 300,
      );

      const closeWhileLocked = await runArchiveRun(
        settings,
        fixture.networkPath,
        failed.run.runId,
        {
          requestedBy: `${scope}_archive_harness`,
          reason: requestReason(scope, "close-while-rerun-locked"),
        },
      );
      assert.equal(closeWhileLocked.process.exitCode, 1);
      assert.equal(closeWhileLocked.output?.outcome, "REJECTED");
      assert.equal(closeWhileLocked.output?.code, "LOCK_CONFLICT");
      assert.equal(closeWhileLocked.output?.lock_released, true);
      assert.equal(
        (await loadRunLifecycle(settings, failed.run.runId)).lifecycleStatus,
        "ACTIVE",
      );

      await releaseFaultBarrier(barrier);
      const resumedProcess = await resumed.completion;
      resumed = undefined;
      assert.equal(resumedProcess.exitCode, 1);
      const afterResume = await loadRunGraph(settings, scope);
      assert.equal(afterResume.run.status, "FAILED");
      assert.ok(afterResume.attempts.length > attemptsBeforeResume);

      const archive = await runArchiveRun(
        settings,
        fixture.networkPath,
        failed.run.runId,
        {
          requestedBy: `${scope}_archive_harness`,
          reason: requestReason(scope, "close-after-rerun"),
        },
      );
      assert.equal(archive.process.exitCode, 0);
      assert.equal(archive.output?.outcome, "ARCHIVED");
      assert.equal(archive.output?.audit, "RECORDED");
      assert.equal(archive.output?.lock_released, true);
      assert.equal(
        (await loadRunLifecycle(settings, failed.run.runId)).lifecycleStatus,
        "ARCHIVED",
      );

      const attemptsBeforeArchivedResume = afterResume.attempts.length;
      const resumeArchived = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        "",
        { resumeRun: failed.run.runId },
      );
      assert.equal(resumeArchived.exitCode, 1);
      assert.match(
        `${resumeArchived.stdout}\n${resumeArchived.stderr}`,
        /RUN_NOT_RESUMABLE/u,
      );
      assert.equal(
        (await loadRunGraph(settings, scope)).attempts.length,
        attemptsBeforeArchivedResume,
        "ARCHIVED Run must not execute a Node",
      );

      const barrierEvents = await readFaultBarrierEvents(barrier);
      assert.equal(barrierEvents.length, 1);
      assert.equal(barrierEvents[0].response_status, 200);
      return {
        networkId: fixture.networkId,
        runId: failed.run.runId,
        initial: processSummary(initial),
        heartbeatBarrier: {
          barrierId: barrierEvents[0].barrier_id,
          phase: barrierEvents[0].phase,
          responseStatus: barrierEvents[0].response_status,
          method: barrierEvents[0].method,
          path: barrierEvents[0].path,
        },
        closeWhileLocked: {
          process: processSummary(closeWhileLocked.process),
          outcome: closeWhileLocked.output?.outcome,
          code: closeWhileLocked.output?.code,
          lockReleased: closeWhileLocked.output?.lock_released,
        },
        resumed: {
          process: processSummary(resumedProcess),
          status: afterResume.run.status,
          attemptCount: afterResume.attempts.length,
        },
        archive: {
          process: processSummary(archive.process),
          outcome: archive.output?.outcome,
          audit: archive.output?.audit,
          lockReleased: archive.output?.lock_released,
          eventId: archive.output?.event_id,
        },
        resumeArchived: processSummary(resumeArchived),
      };
    } finally {
      if (barrier) await releaseFaultBarrier(barrier);
      if (resumed?.child.exitCode === null) resumed.child.kill("SIGKILL");
      await cleanupFaultBarrier(barrier);
      await fixture.dispose();
    }
  },
);
