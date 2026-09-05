import assert from "node:assert/strict";

import {
  loadRunGraph,
  runFlowNetNetwork,
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
  assertPersistenceUnchanged,
  persistenceSnapshot,
} from "./p2-11-support.mjs";
import {
  cleanupFaultBarrier,
  createCloseRequest,
  getRunHold,
  loadRunArchivedAudits,
  loadRunLifecycle,
  networkLockSnapshot,
  prepareFaultBarrier,
  releaseFaultBarrier,
  summarizeRequest,
  waitForBarrier,
} from "./p2-16-support.mjs";

const processSummary = ({ exitCode, signal }) => ({ exitCode, signal });

async function rejectClose(
  settings,
  scope,
  allowlistPath,
  runId,
  label,
  expectedCodes,
) {
  const request = await createCloseRequest(settings, scope, label, runId);
  const before = await persistenceSnapshot(settings);
  const poller = await runPollRequests(settings, allowlistPath);
  assert.equal(poller.exitCode, 0, poller.stderr || poller.stdout);
  const result = await getRequest(settings, request.id);
  assert.equal(result.requestState, "REJECTED");
  assert.ok(
    expectedCodes.includes(result.resultCode),
    `expected ${expectedCodes.join("/")}, got ${result.resultCode}`,
  );
  await assertPersistenceUnchanged(settings, before);
  return {
    request: summarizeRequest(result),
    poller: processSummary(poller),
  };
}

await runP201(
  import.meta.url,
  "p2-16-04-close",
  async ({ settings, scope }) => {
    const archiveFixture = await prepareP201Network(
      `${scope}_archive`,
      "network-midfail.yaml",
    );
    const successFixture = await prepareP201Network(
      `${scope}_success`,
      "network-success.yaml",
    );
    const liveFixture = await prepareP201Network(
      `${scope}_live`,
      "network-p216-longfail.yaml",
    );
    const allowlist = await createAllowlist([
      archiveFixture,
      successFixture,
      liveFixture,
    ]);
    let liveProcess;
    let finalizeBarrier;
    try {
      const archiveBusinessKey = `${scope}_archive`;
      const failedProcess = await runFlowNetNetwork(
        settings,
        archiveFixture.networkPath,
        archiveBusinessKey,
      );
      assert.equal(failedProcess.exitCode, 1);
      const failed = await loadRunGraph(settings, archiveBusinessKey);
      assert.equal(failed.run.status, "FAILED");
      const attemptsBeforeArchive = failed.attempts.length;
      const locksBeforeArchive = await networkLockSnapshot(settings);

      const close = await createCloseRequest(
        settings,
        scope,
        "archive-failed-run",
        failed.run.runId,
      );
      const closePoller = await runPollRequests(settings, allowlist.path);
      assert.equal(
        closePoller.exitCode,
        0,
        closePoller.stderr || closePoller.stdout,
      );
      const closeResult = await getRequest(settings, close.id);
      assert.equal(closeResult.requestState, "DONE");
      assert.equal(closeResult.resultCode, "RUN_ARCHIVED");
      const eventId = /(?:^|;)\s*event_id=([^;\s]+)/u.exec(
        closeResult.resultMessage ?? "",
      )?.[1];
      assert.match(eventId ?? "", /^archive_/u);

      const lifecycle = await loadRunLifecycle(settings, failed.run.runId);
      assert.equal(lifecycle.status, "FAILED");
      assert.equal(lifecycle.lifecycleStatus, "ARCHIVED");
      const audits = await loadRunArchivedAudits(settings, failed.run.runId);
      assert.equal(audits.length, 1);
      const audit = audits[0];
      assert.equal(audit.eventId, eventId);
      assert.equal(
        audit.requested_by,
        `app-request:${close.id}:${encodeURIComponent(close.creatorCode)}`,
      );
      assert.equal(audit.reason, close.reason);
      assert.equal(audit.previous_status, "FAILED");
      // 物理列 resolved_at は kintone DATETIME(分精度)。reason JSON の archived_at は秒付き。
      assert.equal(
        Math.floor(Date.parse(audit.resolvedAt) / 60_000),
        Math.floor(Date.parse(audit.archived_at) / 60_000),
        "resolved_at は archived_at の分精度切り捨てと一致する",
      );
      assert.equal(audit.run_revision_before, lifecycle.revision - 1);

      const locksAfterArchive = await networkLockSnapshot(settings);
      const archiveLocks = Object.entries(locksAfterArchive)
        .filter(([id]) => !Object.hasOwn(locksBeforeArchive, id))
        .map(([, lock]) => lock);
      assert.equal(
        archiveLocks.length,
        1,
        "archive-run must create one lock record",
      );
      assert.match(archiveLocks[0].recordKey, /^LOCKDONE:/u);
      assert.equal(archiveLocks[0].lockKey, "");
      assert.equal(archiveLocks[0].status, "SUCCESS");
      const archivedStatus = await getRunHold(
        settings,
        archiveFixture.networkId,
        failed.run.runId,
      );
      assert.equal(archivedStatus.run.lifecycle_status, "ARCHIVED");
      assert.equal(archivedStatus.hold, null);

      const resumeArchived = await runFlowNetNetwork(
        settings,
        archiveFixture.networkPath,
        "",
        { resumeRun: failed.run.runId },
      );
      assert.equal(resumeArchived.exitCode, 1);
      assert.match(
        `${resumeArchived.stdout}\n${resumeArchived.stderr}`,
        /RUN_NOT_RESUMABLE/u,
      );
      assert.equal(
        (await loadRunGraph(settings, archiveBusinessKey)).attempts.length,
        attemptsBeforeArchive,
        "ARCHIVED Run must not start another Node Attempt",
      );

      const repeatedClose = await createCloseRequest(
        settings,
        scope,
        "archive-already-archived",
        failed.run.runId,
      );
      const beforeRepeated = await persistenceSnapshot(settings);
      const repeatedPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(repeatedPoller.exitCode, 0);
      const repeatedResult = await getRequest(settings, repeatedClose.id);
      assert.equal(repeatedResult.requestState, "DONE");
      assert.equal(repeatedResult.resultCode, "RUN_ALREADY_ARCHIVED");
      await assertPersistenceUnchanged(settings, beforeRepeated);

      const successBusinessKey = `${scope}_success`;
      const successProcess = await runFlowNetNetwork(
        settings,
        successFixture.networkPath,
        successBusinessKey,
      );
      assert.equal(successProcess.exitCode, 0);
      const success = await loadRunGraph(settings, successBusinessKey);
      const successRejection = await rejectClose(
        settings,
        scope,
        allowlist.path,
        success.run.runId,
        "reject-success",
        ["RUN_STATUS_NOT_CLOSABLE"],
      );

      const liveBusinessKey = `${scope}_live`;
      // 実行中Runの拒否とSTOP→hold作成を決定的にするため、n1のAttempt finalize
      // (監査アプリへの finished_at を含む PUT。実行開始時の部分PUTには含まれない)
      // をbarrierで止め、その間はRunがRUNNINGのまま(heartbeatは継続)であることを固定する。
      finalizeBarrier = await prepareFaultBarrier(liveFixture.directory, {
        label: "live-finalize",
        barrierId: `${scope}_finalize_before`,
        app: settings.auditAppId,
        field: "finished_at",
        phase: "before",
      });
      liveProcess = await startFlowNetNetwork(
        settings,
        liveFixture.networkPath,
        liveBusinessKey,
        { environment: finalizeBarrier.environment },
      );
      const live = await waitForRunGraph(settings, liveBusinessKey, (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === liveFixture.nodeId("n1_longfail") &&
            status === "RUNNING",
        ),
      );
      const liveAttempt = live.attempts.find(
        ({ nodeId, status }) =>
          nodeId === liveFixture.nodeId("n1_longfail") && status === "RUNNING",
      );
      await waitForRunningJobLog(
        settings,
        liveAttempt.attemptId,
        liveFixture.jobId("p216_longfail"),
      );
      // n1のSQLが失敗して finalize PUT に到達した時点で停止する(以後、release までRunはRUNNING)
      const finalizeEvent = await waitForBarrier(finalizeBarrier);
      assert.equal(finalizeEvent.phase, "before");
      const liveRejection = await rejectClose(
        settings,
        scope,
        allowlist.path,
        live.run.runId,
        "reject-live",
        ["RUN_NOT_TERMINAL"],
      );

      const stop = await createRequest(settings, {
        requestType: "STOP",
        runId: live.run.runId,
        reason: requestReason(scope, "prepare-held-failure"),
      });
      const stopPoller = await runPollRequests(settings, allowlist.path);
      assert.equal(stopPoller.exitCode, 0);
      const stopResult = await getRequest(settings, stop.id);
      assert.equal(stopResult.requestState, "DONE");
      assert.equal(stopResult.resultCode, "STOP_REQUESTED");
      // holdが作成された後にfinalizeを解放し、n1をFAILEDで終端させる → Run FAILED + hold
      await releaseFaultBarrier(finalizeBarrier);
      const heldProcess = await liveProcess.completion;
      liveProcess = undefined;
      assert.equal(heldProcess.exitCode, 1);
      const held = await loadRunGraph(settings, liveBusinessKey);
      assert.equal(held.run.status, "FAILED");
      assert.ok(
        (await getRunHold(settings, liveFixture.networkId, held.run.runId))
          .hold,
      );
      const holdRejection = await rejectClose(
        settings,
        scope,
        allowlist.path,
        held.run.runId,
        "reject-held",
        ["RUN_ON_HOLD"],
      );

      // UNKNOWN作成にはm6-02相当のprocess tree killとstale lock回収が必要になる。
      // RUN_UNKNOWN_NOT_CLOSABLEの判定順はM2単体で固定済みのため、本E2Eでは扱わない。
      return {
        archive: {
          networkId: archiveFixture.networkId,
          runId: failed.run.runId,
          initialProcess: processSummary(failedProcess),
          request: summarizeRequest(closeResult),
          eventId,
          lifecycle,
          audit: {
            count: audits.length,
            eventIdMatchesMessage: eventId === audit.eventId,
            requestedByMatches: true,
            reasonMatches: true,
            archivedAt: audit.archived_at,
            previousStatus: audit.previous_status,
            runRevisionBefore: audit.run_revision_before,
          },
          lockTombstone: archiveLocks[0],
          resumeArchived: processSummary(resumeArchived),
          repeatedClose: summarizeRequest(repeatedResult),
        },
        rejections: {
          success: successRejection,
          live: liveRejection,
          hold: holdRejection,
          unknown:
            "covered by M2 unit tests; E2E kill/recovery is intentionally omitted",
        },
        preparation: {
          success: processSummary(successProcess),
          heldFailure: processSummary(heldProcess),
          stop: summarizeRequest(stopResult),
        },
      };
    } finally {
      if (finalizeBarrier) await releaseFaultBarrier(finalizeBarrier);
      if (liveProcess?.child.exitCode === null)
        liveProcess.child.kill("SIGKILL");
      await cleanupFaultBarrier(finalizeBarrier);
      await Promise.all([
        allowlist.dispose(),
        archiveFixture.dispose(),
        successFixture.dispose(),
        liveFixture.dispose(),
      ]);
    }
  },
);
