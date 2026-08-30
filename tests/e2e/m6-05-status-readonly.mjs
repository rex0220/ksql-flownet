import assert from "node:assert/strict";

import {
  field,
  getJobLogs,
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runFlowNetStatus,
  runM6,
  snapshotPersistenceRevisions,
  startFlowNetNetwork,
  waitFor,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

await runM6(import.meta.url, "status-readonly", async ({ settings, scope }) => {
  const executedFixture = await prepareNetwork(scope, "network-nonidem.yaml");
  const staleScope = `${scope}_stale`;
  const staleFixture = await prepareNetwork(staleScope, "network-drill.yaml");
  let runningNetwork;
  try {
    const executed = await runFlowNetNetwork(
      settings,
      executedFixture.networkPath,
      scope,
    );
    assert.equal(executed.exitCode, 1);
    const graph = await loadRunGraph(settings, scope);
    const beforeRevisions = await snapshotPersistenceRevisions(settings);
    const textStatus = await runFlowNetStatus(
      settings,
      executedFixture.networkId,
      { runId: graph.run.runId, json: false },
    );
    assert.match(textStatus.process.stdout, /Network:/u);
    assert.match(textStatus.process.stdout, /run_id:/u);
    const jsonStatus = await runFlowNetStatus(
      settings,
      executedFixture.networkId,
      { runId: graph.run.runId },
    );
    const afterRevisions = await snapshotPersistenceRevisions(settings);
    assert.deepEqual(
      afterRevisions,
      beforeRevisions,
      "status text/json must not change any state or audit record revision",
    );
    assert.doesNotMatch(
      JSON.stringify(jsonStatus.output),
      /lease_token/iu,
      "status JSON must not expose lease_token",
    );
    const executedRecovery = jsonStatus.output.runs[0].recovery_identifiers;
    assert.ok(
      executedRecovery.resolve_node.some(
        ({ run_id, node_id }) =>
          run_id === graph.run.runId && node_id === "n2_nonidem",
      ),
    );
    assert.equal(executedRecovery.run_network.resume_run, graph.run.runId);

    runningNetwork = await startFlowNetNetwork(
      settings,
      staleFixture.networkPath,
      staleScope,
    );
    const runningGraph = await waitForRunGraph(settings, staleScope, (value) =>
      value.attempts.some(
        ({ nodeId, status }) =>
          nodeId === "n1_longread" && status === "RUNNING",
      ),
    );
    const runningAttempt = runningGraph.attempts.find(
      ({ nodeId, status }) => nodeId === "n1_longread" && status === "RUNNING",
    );
    await waitForRunningJobLog(
      settings,
      runningAttempt.attemptId,
      "m6_longread",
    );
    const liveStatus = await runFlowNetStatus(
      settings,
      staleFixture.networkId,
      { runId: runningGraph.run.runId },
    );
    assert.equal(liveStatus.output.lock.stale_candidate, false);
    const forceUnlockIds =
      liveStatus.output.runs[0].recovery_identifiers.force_unlock_network;
    assert.equal(forceUnlockIds.network_id, staleFixture.networkId);
    assert.equal(forceUnlockIds.profile, settings.profile);
    assert.ok(forceUnlockIds.expected_owner_invocation_id);

    runningNetwork.child.kill("SIGKILL");
    const killedParent = await runningNetwork.completion;
    assert.notEqual(killedParent.signal, null);
    const terminalJobLog = await waitFor(
      async () => {
        const records = await getJobLogs(
          settings,
          `attempt_id = "${runningAttempt.attemptId}" and job_id = "m6_longread" order by $id asc`,
        );
        return (
          records.find((record) =>
            ["SUCCESS", "FAILED", "ABORTED", "CANCELLED"].includes(
              field(record, "status"),
            ),
          ) ?? null
        );
      },
      "orphaned kSQL-Flow child terminal JOB log",
      { timeoutMs: 180_000, intervalMs: 2_000 },
    );
    const staleStatus = await waitFor(
      async () => {
        const status = await runFlowNetStatus(
          settings,
          staleFixture.networkId,
          { runId: runningGraph.run.runId },
        );
        return status.output.lock?.stale_candidate ? status : null;
      },
      "status stale_candidate=true",
      // lease 30秒 + DATETIME切り捨て上限60秒の保守判定に合わせて待つ
      { timeoutMs: 150_000, intervalMs: 1_000 },
    );
    return {
      executedProcess: executed,
      executedNetworkId: executedFixture.networkId,
      statusText: textStatus.process.stdout,
      statusJson: jsonStatus.output,
      revisionCounts: {
        state: Object.keys(beforeRevisions.state).length,
        audit: Object.keys(beforeRevisions.audit).length,
      },
      runningNetworkId: staleFixture.networkId,
      liveStatus: liveStatus.output,
      killedParent,
      terminalJobStatus: field(terminalJobLog, "status"),
      staleStatus: staleStatus.output,
    };
  } finally {
    if (runningNetwork?.child.exitCode === null)
      runningNetwork.child.kill("SIGKILL");
    await Promise.all([executedFixture.dispose(), staleFixture.dispose()]);
  }
});
