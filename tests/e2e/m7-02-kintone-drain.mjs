import assert from "node:assert/strict";
import { join } from "node:path";

import { networkLockKey } from "../../dist/domain/canonical-lock-key.js";
import {
  byNode,
  field,
  getAllPersistenceRecords,
  loadRunGraph,
  prepareNetwork,
  runM7,
  startFlowNetNetwork,
  summarizeJobLog,
  waitFor,
  waitForRunGraph,
  waitForRunningJobLog,
} from "./support.mjs";
import {
  faultEnvironment,
  forceUnlockAndAdjudicate,
  readFaultEvents,
  setFaultMode,
  waitForBlockedRequest,
  waitForCompletion,
  waitForTerminalJobLog,
} from "./m7-support.mjs";

function revisions(records) {
  return Object.fromEntries(
    records.map((record) => [field(record, "$id"), field(record, "$revision")]),
  );
}

async function snapshotRunRecords(settings, runId, networkId) {
  const lockKey = networkLockKey(settings.profile, networkId);
  const [state, lock, audit] = await Promise.all([
    getAllPersistenceRecords(settings, "state", `run_id = "${runId}"`),
    getAllPersistenceRecords(
      settings,
      "state",
      `record_type in ("NETWORK_LOCK") and lock_key = "${lockKey}"`,
    ),
    getAllPersistenceRecords(settings, "audit", `run_id = "${runId}"`),
  ]);
  return { state: revisions([...state, ...lock]), audit: revisions(audit) };
}

async function waitUntil(timestamp) {
  const delay = timestamp - Date.now();
  if (delay > 0)
    await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
}

await runM7(
  import.meta.url,
  "02-kintone-drain",
  async ({ settings, scope, evidenceRef }) => {
    const recoveryFixture = await prepareNetwork(
      `${scope}_recover`,
      "network-drill.yaml",
    );
    const outageFixture = await prepareNetwork(
      `${scope}_outage`,
      "network-drill.yaml",
    );
    let recoveryNetwork;
    let outageNetwork;
    try {
      const recoveryControl = join(
        recoveryFixture.directory,
        "fault-control.txt",
      );
      const recoveryLog = join(recoveryFixture.directory, "fault-log.jsonl");
      await setFaultMode(recoveryControl, "pass");
      recoveryNetwork = await startFlowNetNetwork(
        settings,
        recoveryFixture.networkPath,
        `${scope}_recover`,
        { environment: faultEnvironment(recoveryControl, recoveryLog) },
      );
      const recoveryRunning = await waitForRunGraph(
        settings,
        `${scope}_recover`,
        (graph) =>
          graph.attempts.some(
            ({ nodeId, status }) =>
              nodeId === "n1_longread" && status === "RUNNING",
          ),
      );
      const recoveryAttempt = recoveryRunning.attempts.find(
        ({ nodeId, status }) =>
          nodeId === "n1_longread" && status === "RUNNING",
      );
      await waitForRunningJobLog(
        settings,
        recoveryAttempt.attemptId,
        "m6_longread",
      );
      const recoveryBlockedAt = Date.now();
      await setFaultMode(recoveryControl, "block");
      const recoveryBlockedRequest = await waitForBlockedRequest(recoveryLog);
      const recoveryTerminalJob = await waitForTerminalJobLog(
        settings,
        recoveryAttempt.attemptId,
      );
      // drainのlease再確認はGET(解決)→PUTの2段で、遮断時はGET段で失敗する。
      // blocked要求が3件以上(≒drain再試行が回っている)かつ26秒経過後に回復させる
      // (deadline=lease 30秒より前に回復し、FINAL_WRITE_CONFIRMED経路を踏ませる)。
      await waitFor(
        async () =>
          (await readFaultEvents(recoveryLog)).filter(({ blocked }) => blocked)
            .length >= 3 || null,
        "drain retry activity",
        { timeoutMs: 60_000, intervalMs: 500 },
      );
      await waitUntil(recoveryBlockedAt + 26_000);
      await setFaultMode(recoveryControl, "pass");
      const recoveryProcess = await waitForCompletion(
        recoveryNetwork.completion,
        "M7 recovery FlowNet",
        120_000,
      );
      assert.equal(recoveryProcess.exitCode, 1);
      const recoveryGraph = await loadRunGraph(settings, `${scope}_recover`);
      const recoveryStates = byNode(recoveryGraph.states);
      assert.equal(recoveryStates.get("n1_longread").status, "SUCCESS");
      assert.equal(
        recoveryGraph.attempts.find(
          ({ attemptId }) => attemptId === recoveryAttempt.attemptId,
        ).status,
        "SUCCESS",
      );
      assert.equal(
        recoveryGraph.attempts.filter(({ nodeId }) => nodeId !== "n1_longread")
          .length,
        0,
        "no new node may start after the heartbeat interruption",
      );
      assert.equal(recoveryGraph.invocations.at(-1).status, "CANCELLED");
      assert.equal(
        recoveryGraph.invocations.at(-1).resultCode,
        "NETWORK_LEASE_INTERRUPTED",
      );
      assert.equal(field(recoveryTerminalJob, "status"), "SUCCESS");

      const outageControl = join(outageFixture.directory, "fault-control.txt");
      const outageLog = join(outageFixture.directory, "fault-log.jsonl");
      await setFaultMode(outageControl, "pass");
      outageNetwork = await startFlowNetNetwork(
        settings,
        outageFixture.networkPath,
        `${scope}_outage`,
        { environment: faultEnvironment(outageControl, outageLog) },
      );
      const outageRunning = await waitForRunGraph(
        settings,
        `${scope}_outage`,
        (graph) =>
          graph.attempts.some(
            ({ nodeId, status }) =>
              nodeId === "n1_longread" && status === "RUNNING",
          ),
      );
      const outageAttempt = outageRunning.attempts.find(
        ({ nodeId, status }) =>
          nodeId === "n1_longread" && status === "RUNNING",
      );
      await waitForRunningJobLog(
        settings,
        outageAttempt.attemptId,
        "m6_longread",
      );
      await setFaultMode(outageControl, "block");
      const outageBlockedRequest = await waitForBlockedRequest(outageLog);
      const beforeBlockedWindow = await snapshotRunRecords(
        settings,
        outageRunning.run.runId,
        outageFixture.networkId,
      );
      const outageTerminalJob = await waitForTerminalJobLog(
        settings,
        outageAttempt.attemptId,
      );
      const outageProcess = await waitForCompletion(
        outageNetwork.completion,
        "M7 unrecovered FlowNet",
        120_000,
      );
      const afterBlockedWindow = await snapshotRunRecords(
        settings,
        outageRunning.run.runId,
        outageFixture.networkId,
      );
      assert.deepEqual(
        afterBlockedWindow,
        beforeBlockedWindow,
        "state/audit $id and revision must not change after blocking is observed",
      );
      const outageGraph = await loadRunGraph(settings, `${scope}_outage`);
      assert.equal(
        outageGraph.invocations.at(-1).status,
        "RUNNING",
        "unrecovered drain must leave Invocation non-terminal",
      );
      assert.equal(field(outageTerminalJob, "status"), "SUCCESS");

      await setFaultMode(outageControl, "pass");
      const outageCleanup = await forceUnlockAndAdjudicate({
        settings,
        fixture: outageFixture,
        runId: outageRunning.run.runId,
        evidenceRef,
        reason: "M7 unrecovered kintone outage cleanup",
      });

      return {
        recovery: {
          process: recoveryProcess,
          networkId: recoveryFixture.networkId,
          blockedRequest: recoveryBlockedRequest,
          terminalJob: summarizeJobLog(recoveryTerminalJob),
          graph: recoveryGraph,
          faultEvents: await readFaultEvents(recoveryLog),
        },
        unrecovered: {
          process: outageProcess,
          networkId: outageFixture.networkId,
          blockedRequest: outageBlockedRequest,
          terminalJob: summarizeJobLog(outageTerminalJob),
          beforeBlockedWindow,
          afterBlockedWindow,
          graphBeforeCleanup: outageGraph,
          cleanup: outageCleanup,
          faultEvents: await readFaultEvents(outageLog),
        },
      };
    } finally {
      await Promise.allSettled([
        setFaultMode(
          join(recoveryFixture.directory, "fault-control.txt"),
          "pass",
        ),
        setFaultMode(
          join(outageFixture.directory, "fault-control.txt"),
          "pass",
        ),
      ]);
      if (recoveryNetwork?.child.exitCode === null)
        recoveryNetwork.child.kill("SIGKILL");
      if (outageNetwork?.child.exitCode === null)
        outageNetwork.child.kill("SIGKILL");
      await Promise.all([recoveryFixture.dispose(), outageFixture.dispose()]);
    }
  },
);
