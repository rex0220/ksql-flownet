import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadRunGraph,
  prepareNetwork,
  runFlowNetCommand,
  runFlowNetNetwork,
  runM7,
} from "./support.mjs";
import {
  faultEnvironment,
  readFaultEvents,
  setFaultMode,
  summarizeControlPlaneCalls,
} from "./m7-support.mjs";

function assertSane(summary, label, upperBound = 500) {
  assert.ok(summary.total > 0, `${label} must make control-plane API calls`);
  assert.ok(
    summary.total <= upperBound,
    `${label} call count exceeds sanity bound ${upperBound}`,
  );
  assert.equal(summary.blocked, 0, `${label} is measurement-only`);
}

await runM7(
  import.meta.url,
  "03-control-plane-api-calls",
  async ({ settings, scope, evidenceRef }) => {
    const fixture = await prepareNetwork(
      scope,
      "network-m7-control-plane.yaml",
    );
    const controlFile = join(fixture.directory, "fault-control.txt");
    const runLog = join(fixture.directory, "run-api-calls.jsonl");
    const statusLog = join(fixture.directory, "status-api-calls.jsonl");
    const unlockLog = join(fixture.directory, "unlock-api-calls.jsonl");
    const reasonFile = join(fixture.directory, "force-unlock-reason.txt");
    await setFaultMode(controlFile, "pass");
    await writeFile(reasonFile, "M7 missing-lock fail-closed probe.\n", "utf8");
    try {
      const runProcess = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        scope,
        { environment: faultEnvironment(controlFile, runLog) },
      );
      assert.equal(
        runProcess.exitCode,
        0,
        runProcess.stderr || runProcess.stdout,
      );
      const graph = await loadRunGraph(settings, scope);
      assert.equal(graph.run.status, "SUCCESS");

      const statusProcess = await runFlowNetCommand(
        settings,
        [
          "status",
          fixture.networkId,
          "--profile",
          settings.profile,
          "--run-id",
          graph.run.runId,
          "--json",
        ],
        { environment: faultEnvironment(controlFile, statusLog) },
      );
      assert.equal(
        statusProcess.exitCode,
        0,
        statusProcess.stderr || statusProcess.stdout,
      );
      const statusOutput = JSON.parse(statusProcess.stdout);

      const missingNetworkId = `${scope}_missing`;
      const forceUnlockProcess = await runFlowNetCommand(
        settings,
        [
          "force-unlock-network",
          missingNetworkId,
          "--profile",
          settings.profile,
          "--expected-owner-invocation-id",
          `${scope}_missing_owner`,
          "--reason-file",
          reasonFile,
          "--evidence-ref",
          evidenceRef,
          "--stop-confirmed-by",
          "m7-e2e-operator",
          "--stop-evidence-ref",
          evidenceRef,
          "--stop-method",
          "local_pid",
        ],
        { environment: faultEnvironment(controlFile, unlockLog) },
      );
      assert.equal(forceUnlockProcess.exitCode, 1);
      assert.match(forceUnlockProcess.stderr, /\[LOCK_NOT_FOUND\]/u);

      const normalRun = summarizeControlPlaneCalls(
        await readFaultEvents(runLog),
      );
      const status = summarizeControlPlaneCalls(
        await readFaultEvents(statusLog),
      );
      const forceUnlockFailClosed = summarizeControlPlaneCalls(
        await readFaultEvents(unlockLog),
      );
      assertSane(normalRun, "normal run");
      assert.ok(normalRun.records.GET > 0);
      assert.ok(normalRun.records.POST > 0);
      assert.ok(normalRun.records.PUT > 0);
      assert.ok(normalRun.file > 0);
      assert.ok(
        normalRun.heartbeat > 0,
        "long read must exercise heartbeat PUT",
      );
      assert.ok(normalRun.heartbeat <= 30, "heartbeat count sanity bound");
      assertSane(status, "status", 100);
      assert.ok(status.records.GET > 0);
      assertSane(forceUnlockFailClosed, "force unlock fail-closed", 100);
      assert.ok(forceUnlockFailClosed.records.GET > 0);

      return {
        networkId: fixture.networkId,
        runProcess,
        graph,
        statusProcess,
        statusOutput,
        forceUnlockProcess,
        controlPlaneApiCalls: {
          normalRun,
          status,
          forceUnlockFailClosed,
        },
      };
    } finally {
      await fixture.dispose();
    }
  },
);
