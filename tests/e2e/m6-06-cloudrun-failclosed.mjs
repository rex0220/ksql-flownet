import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  field,
  getJobLogs,
  prepareNetwork,
  runFlowNetCommand,
  runFlowNetStatus,
  runM6,
  startFlowNetNetwork,
  waitFor,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";

function forceUnlockArguments(recovery, reasonFile, evidenceRef, stopMethod) {
  return [
    "force-unlock-network",
    recovery.network_id,
    "--profile",
    recovery.profile,
    "--expected-owner-invocation-id",
    recovery.expected_owner_invocation_id,
    "--reason-file",
    reasonFile,
    "--evidence-ref",
    evidenceRef,
    "--stop-confirmed-by",
    "m6-e2e-operator",
    "--stop-evidence-ref",
    evidenceRef,
    "--stop-method",
    stopMethod,
  ];
}

async function createStaleLock(settings, fixture, businessKey, environment) {
  const network = await startFlowNetNetwork(
    settings,
    fixture.networkPath,
    businessKey,
    { environment },
  );
  try {
    const running = await waitForRunGraph(settings, businessKey, (graph) =>
      graph.attempts.some(
        ({ nodeId, status }) =>
          nodeId === "n1_longread" && status === "RUNNING",
      ),
    );
    const attempt = running.attempts.find(
      ({ nodeId, status }) => nodeId === "n1_longread" && status === "RUNNING",
    );
    await waitForRunningJobLog(settings, attempt.attemptId, "m6_longread");
    network.child.kill("SIGKILL");
    const killedParent = await network.completion;
    assert.notEqual(killedParent.signal, null);
    await waitFor(async () => {
      const records = await getJobLogs(
        settings,
        `attempt_id = "${attempt.attemptId}" and job_id = "m6_longread" order by $id asc`,
      );
      return (
        records.find((record) => field(record, "status") === "SUCCESS") ?? null
      );
    }, "orphaned kSQL-Flow child SUCCESS");
    const stale = await waitFor(
      async () => {
        const status = await runFlowNetStatus(settings, fixture.networkId, {
          runId: running.run.runId,
        });
        return status.output.lock?.stale_candidate ? status : null;
      },
      `stale lock for ${fixture.networkId}`,
      { timeoutMs: 40_000, intervalMs: 500 },
    );
    return {
      killedParent,
      status: stale.output,
      recovery: stale.output.runs[0].recovery_identifiers.force_unlock_network,
    };
  } finally {
    if (network.child.exitCode === null) network.child.kill("SIGKILL");
  }
}

await runM6(
  import.meta.url,
  "cloudrun-failclosed",
  async ({ settings, scope, evidenceRef }) => {
    const localFixture = await prepareNetwork(
      `${scope}_local`,
      "network-drill.yaml",
    );
    const cloudFixture = await prepareNetwork(
      `${scope}_cloud`,
      "network-drill.yaml",
    );
    const reasonFile = join(localFixture.directory, "force-unlock-reason.txt");
    await writeFile(
      reasonFile,
      "M6 Cloud Run fail-closed adapter probe.\n",
      "utf8",
    );
    try {
      const local = await createStaleLock(
        settings,
        localFixture,
        `${scope}_local`,
        {},
      );
      const localPidFormat = await runFlowNetCommand(
        settings,
        forceUnlockArguments(
          local.recovery,
          reasonFile,
          evidenceRef,
          "cloud_run_job_execution",
        ),
        { environment: { KSQL_FLOWNET_GCP_ACCESS_TOKEN: "" } },
      );
      assert.equal(localPidFormat.exitCode, 1);
      assert.match(localPidFormat.stderr, /\[STOP_NOT_CONFIRMED\]/u);
      assert.match(localPidFormat.stderr, /not a valid Cloud Run/u);

      const cloud = await createStaleLock(
        settings,
        cloudFixture,
        `${scope}_cloud`,
        {
          KSQL_FLOWNET_OWNER_INSTANCE_ID:
            "projects/m6-test/locations/asia-northeast1/jobs/m6-job/executions/m6-execution",
        },
      );
      const missingToken = await runFlowNetCommand(
        settings,
        forceUnlockArguments(
          cloud.recovery,
          reasonFile,
          evidenceRef,
          "cloud_run_job_execution",
        ),
        { environment: { KSQL_FLOWNET_GCP_ACCESS_TOKEN: "" } },
      );
      assert.equal(missingToken.exitCode, 1);
      assert.match(missingToken.stderr, /\[STOP_NOT_CONFIRMED\]/u);
      assert.match(missingToken.stderr, /GCP_ACCESS_TOKEN is not configured/u);

      const unknownMethod = await runFlowNetCommand(
        settings,
        forceUnlockArguments(
          cloud.recovery,
          reasonFile,
          evidenceRef,
          "m6_unknown_method",
        ),
        { environment: { KSQL_FLOWNET_GCP_ACCESS_TOKEN: "" } },
      );
      assert.equal(unknownMethod.exitCode, 1);
      assert.match(unknownMethod.stderr, /\[STOP_NOT_CONFIRMED\]/u);
      assert.match(unknownMethod.stderr, /unknown stop confirmation method/u);
      return {
        localPidFormatProbe: localPidFormat,
        missingTokenProbe: missingToken,
        unknownMethodProbe: unknownMethod,
        localStatus: local.status,
        cloudStatus: cloud.status,
        unitCoverageNote:
          "Permission denied, transport failure, RUNNING, PENDING, and unknown Cloud Run states are covered by tests/unit/network-lock-recovery.test.mjs; this E2E intentionally performs no GCP request.",
      };
    } finally {
      await Promise.all([localFixture.dispose(), cloudFixture.dispose()]);
    }
  },
);
