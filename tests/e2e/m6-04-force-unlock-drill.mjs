import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  enumerateProcessTree,
  killProcessList,
  loadNetworkForceReleaseAudits,
  loadRunGraph,
  prepareNetwork,
  recoverJobLock,
  runFlowNetCommand,
  runFlowNetNetwork,
  runFlowNetStatus,
  runM6,
  startFlowNetNetwork,
  waitFor,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

function forceUnlockArguments(identifiers, reasonFile, evidenceRef, owner) {
  return [
    "force-unlock-network",
    identifiers.network_id,
    "--profile",
    identifiers.profile,
    "--expected-owner-invocation-id",
    owner,
    "--reason-file",
    reasonFile,
    "--evidence-ref",
    evidenceRef,
    "--stop-confirmed-by",
    "m6-e2e-operator",
    "--stop-evidence-ref",
    evidenceRef,
    "--stop-method",
    "local_pid",
  ];
}

await runM6(
  import.meta.url,
  "force-unlock-drill",
  async ({ settings, scope, evidenceRef }) => {
    const fixture = await prepareNetwork(scope, "network-drill.yaml");
    const reasonFile = join(fixture.directory, "force-unlock-reason.txt");
    const resolveReasonFile = join(fixture.directory, "resolve-reason.txt");
    await writeFile(reasonFile, "M6 E2E stale Network lock drill.\n", "utf8");
    await writeFile(
      resolveReasonFile,
      "M6 E2E confirmed completion after the killed execution was investigated.\n",
      "utf8",
    );
    let network;
    let killedAttemptId;
    let jobLockRecovery;
    try {
      network = await startFlowNetNetwork(settings, fixture.networkPath, scope);
      const running = await waitForRunGraph(settings, scope, (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === "n1_longread" && status === "RUNNING",
        ),
      );
      const runningAttempt = running.attempts.find(
        ({ nodeId, status }) =>
          nodeId === "n1_longread" && status === "RUNNING",
      );
      killedAttemptId = runningAttempt.attemptId;
      // ジョブは~10秒で完走するため、列挙とlog確認を並行しRUNNING確認後に即kill
      const [processTree] = await Promise.all([
        enumerateProcessTree(network.child.pid),
        waitForRunningJobLog(settings, killedAttemptId, "m6_longread"),
      ]);
      const killedProcesses = killProcessList(processTree);
      const killedNetwork = await network.completion;
      // Windowsの外部killはsignal=null+非0 exitCodeになる
      assert.ok(
        killedNetwork.signal !== null || killedNetwork.exitCode !== 0,
        `killed FlowNet must not exit normally: ${JSON.stringify(killedNetwork)}`,
      );
      const statusBeforeKill = await runFlowNetStatus(
        settings,
        fixture.networkId,
        { runId: running.run.runId },
      );
      assert.equal(statusBeforeKill.output.lock.stale_candidate, false);
      const recovery =
        statusBeforeKill.output.runs[0].recovery_identifiers
          .force_unlock_network;
      assert.ok(recovery);

      const activeLease = await runFlowNetCommand(
        settings,
        forceUnlockArguments(
          recovery,
          reasonFile,
          evidenceRef,
          recovery.expected_owner_invocation_id,
        ),
      );
      assert.equal(
        activeLease.exitCode,
        1,
        `activeLease: ${activeLease.stderr || activeLease.stdout}`,
      );
      assert.match(activeLease.stderr, /\[LEASE_STILL_ACTIVE\]/u);

      const staleStatus = await waitFor(
        async () => {
          const status = await runFlowNetStatus(settings, fixture.networkId, {
            runId: running.run.runId,
          });
          return status.output.lock?.stale_candidate ? status : null;
        },
        "Network lock lease expiry",
        // lease 30秒 + DATETIME切り捨て上限60秒の保守判定に合わせて待つ
        { timeoutMs: 150_000, intervalMs: 1_000 },
      );
      const staleRecovery =
        staleStatus.output.runs[0].recovery_identifiers.force_unlock_network;
      assert.equal(
        staleRecovery.expected_owner_invocation_id,
        recovery.expected_owner_invocation_id,
      );

      const wrongOwner = await runFlowNetCommand(
        settings,
        forceUnlockArguments(
          staleRecovery,
          reasonFile,
          evidenceRef,
          `${staleRecovery.expected_owner_invocation_id}_wrong`,
        ),
      );
      assert.equal(
        wrongOwner.exitCode,
        1,
        `wrongOwner: ${wrongOwner.stderr || wrongOwner.stdout}`,
      );
      assert.match(wrongOwner.stderr, /\[OWNER_MISMATCH\]/u);

      const released = await runFlowNetCommand(
        settings,
        forceUnlockArguments(
          staleRecovery,
          reasonFile,
          evidenceRef,
          staleRecovery.expected_owner_invocation_id,
        ),
      );
      assert.equal(released.exitCode, 0, released.stderr);
      assert.match(released.stdout, /^RELEASED:/mu);
      const audits = await loadNetworkForceReleaseAudits(
        settings,
        fixture.networkId,
      );
      assert.equal(audits.length, 1, "force-release audit record count");
      assert.deepEqual(
        {
          eventType: audits[0].eventType,
          previousOwnerInvocationId: audits[0].previousOwnerInvocationId,
          servicePrincipal: audits[0].servicePrincipal,
          requestedBy: audits[0].requestedBy,
          stopConfirmedBy: audits[0].stopConfirmedBy,
          stopMethod: audits[0].stopMethod,
          stopEvidenceRef: audits[0].stopEvidenceRef,
          evidenceRef: audits[0].evidenceRef,
          reason: audits[0].reason,
        },
        {
          eventType: "NETWORK_LOCK_FORCE_RELEASED",
          previousOwnerInvocationId: staleRecovery.expected_owner_invocation_id,
          servicePrincipal: settings.servicePrincipal,
          requestedBy: settings.requestedBy,
          stopConfirmedBy: "m6-e2e-operator",
          stopMethod: "local_pid",
          stopEvidenceRef: evidenceRef,
          evidenceRef,
          reason: "M6 E2E stale Network lock drill.\n",
        },
      );
      assert.ok(Number.isSafeInteger(audits[0].postReleaseRevision));

      const resumeRun =
        staleStatus.output.runs[0].recovery_identifiers.run_network.resume_run;
      const adjudicationResume = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        "",
        { resumeRun },
      );
      assert.equal(
        adjudicationResume.exitCode,
        1,
        `adjudicationResume: ${adjudicationResume.stderr || adjudicationResume.stdout}`,
      );
      const adjudicatedGraph = await loadRunGraph(settings, scope);
      const adjudicatedState = adjudicatedGraph.states.find(
        ({ nodeId }) => nodeId === "n1_longread",
      );
      const adjudicatedAttempt = adjudicatedGraph.attempts.find(
        ({ attemptId }) => attemptId === killedAttemptId,
      );
      assert.equal(adjudicatedState?.status, "UNKNOWN");
      assert.equal(adjudicatedAttempt?.status, "UNKNOWN");
      assert.equal(adjudicatedAttempt?.resultCode, "NO_EXECUTION_RESULT");
      // FlowNet側の耐久開始マーカー。runner側マーカーはE2Eログ(kill前にRUNNING確認済み)
      assert.ok(
        adjudicatedAttempt?.executionStartedAt,
        "killed Attempt must keep its durable execution-started marker",
      );
      const adjudicatedStatus = await runFlowNetStatus(
        settings,
        fixture.networkId,
        { runId: resumeRun },
      );
      const resolveIdentifier =
        adjudicatedStatus.output.runs[0].recovery_identifiers.resolve_node.find(
          ({ node_id }) => node_id === "n1_longread",
        );
      assert.ok(
        resolveIdentifier,
        "status must expose killed node recovery IDs",
      );
      const resolved = await runFlowNetCommand(settings, [
        "resolve-node",
        "--run-id",
        resolveIdentifier.run_id,
        "--node-id",
        resolveIdentifier.node_id,
        "--to",
        "SUCCESS",
        "--manual-completion",
        "--reason-file",
        resolveReasonFile,
        "--evidence-ref",
        evidenceRef,
        "--stop-confirmed-by",
        "m6-e2e-operator",
        "--stop-evidence-ref",
        evidenceRef,
      ]);
      assert.equal(resolved.exitCode, 0, resolved.stderr);
      const completed = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        "",
        { resumeRun },
      );
      assert.equal(completed.exitCode, 0, completed.stderr);
      const finalGraph = await loadRunGraph(settings, scope);
      assert.equal(finalGraph.run.status, "SUCCESS");
      return {
        networkId: fixture.networkId,
        killedAttemptId,
        killedProcesses,
        killedNetwork,
        activeLeaseProbe: activeLease,
        staleStatus: staleStatus.output,
        wrongOwnerProbe: wrongOwner,
        releaseProcess: released,
        forceReleaseAudit: audits[0],
        adjudicationResume,
        adjudicatedGraph,
        resolvedProcess: resolved,
        completedProcess: completed,
        finalGraph,
        get jobLockRecovery() {
          return jobLockRecovery;
        },
      };
    } finally {
      if (network?.child.exitCode === null) network.child.kill("SIGKILL");
      if (killedAttemptId) {
        jobLockRecovery = await recoverJobLock(
          settings,
          "m6_longread",
          evidenceRef,
          settings.requestedBy,
          "M6 force-unlock drill job-lock cleanup",
        );
        if (jobLockRecovery.lockRecoveryResult !== null)
          assert.equal(jobLockRecovery.recoveryProcess.exitCode, 0);
      }
      await fixture.dispose();
    }
  },
);
