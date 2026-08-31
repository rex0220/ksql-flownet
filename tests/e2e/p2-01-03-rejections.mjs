import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadRunGraph,
  runFlowNetCommand,
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

function identity(graph) {
  return {
    run: graph.run,
    states: graph.states,
    attempts: graph.attempts,
    invocations: graph.invocations,
  };
}

async function reject(settings, allowlistPath, input, code) {
  const request = await createRequest(settings, input);
  const poller = await runPollRequests(settings, allowlistPath);
  assert.equal(poller.exitCode, 0, poller.stderr || poller.stdout);
  const result = await getRequest(settings, request.id);
  assert.equal(result.requestState, "REJECTED");
  assert.equal(result.resultCode, code);
  return { request: result, poller };
}

await runP201(import.meta.url, "03-rejections", async ({ settings, scope }) => {
  const successFixture = await prepareP201Network(
    `${scope}_success`,
    "network-success.yaml",
  );
  const liveFixture = await prepareP201Network(
    `${scope}_live`,
    "network-drill.yaml",
  );
  const allowlist = await createAllowlist([successFixture, liveFixture]);
  let liveProcess;
  try {
    const missing = await reject(
      settings,
      allowlist.path,
      {
        requestType: "RERUN",
        runId: `${scope}_missing_run`,
        reason: requestReason(scope, "missing-run"),
      },
      "RUN_NOT_FOUND",
    );

    const successBusinessKey = `${scope}_success`;
    const successProcess = await runFlowNetNetwork(
      settings,
      successFixture.networkPath,
      successBusinessKey,
    );
    assert.equal(successProcess.exitCode, 0, successProcess.stderr);
    const successBefore = await loadRunGraph(settings, successBusinessKey);
    const success = await reject(
      settings,
      allowlist.path,
      {
        requestType: "RERUN",
        runId: successBefore.run.runId,
        reason: requestReason(scope, "terminal-success"),
      },
      "RUN_STATUS_NOT_RERUNNABLE",
    );
    const successAfter = await loadRunGraph(settings, successBusinessKey);
    assert.deepEqual(identity(successAfter), identity(successBefore));

    const liveBusinessKey = `${scope}_live`;
    liveProcess = await startFlowNetNetwork(
      settings,
      liveFixture.networkPath,
      liveBusinessKey,
    );
    const liveBefore = await waitForRunGraph(
      settings,
      liveBusinessKey,
      (graph) =>
        graph.attempts.some(
          ({ nodeId, status }) =>
            nodeId === liveFixture.nodeId("n1_longread") &&
            status === "RUNNING",
        ),
    );
    const runningAttempt = liveBefore.attempts.find(
      ({ nodeId, status }) =>
        nodeId === liveFixture.nodeId("n1_longread") && status === "RUNNING",
    );
    await waitForRunningJobLog(
      settings,
      runningAttempt.attemptId,
      liveFixture.jobId("m6_longread"),
    );
    const live = await reject(
      settings,
      allowlist.path,
      {
        requestType: "RERUN",
        runId: liveBefore.run.runId,
        reason: requestReason(scope, "live-run"),
      },
      "RUN_LIVE",
    );
    const liveAfter = await loadRunGraph(settings, liveBusinessKey);
    assert.equal(
      liveAfter.invocations.length,
      liveBefore.invocations.length,
      "LIVE拒否でInvocationを追加しません",
    );

    const stopReason = join(liveFixture.directory, "stop-reason.txt");
    await writeFile(stopReason, requestReason(scope, "prepare-hold"), "utf8");
    const stop = await runFlowNetCommand(settings, [
      "cancel-run",
      "--run-id",
      liveBefore.run.runId,
      "--reason-file",
      stopReason,
    ]);
    assert.equal(stop.exitCode, 0, stop.stderr || stop.stdout);
    const stoppedProcess = await liveProcess.completion;
    liveProcess = undefined;
    assert.equal(stoppedProcess.exitCode, 1);
    const holdBefore = await loadRunGraph(settings, liveBusinessKey);
    const hold = await reject(
      settings,
      allowlist.path,
      {
        requestType: "RERUN",
        runId: holdBefore.run.runId,
        reason: requestReason(scope, "held-run"),
      },
      "RUN_ON_HOLD",
    );
    const holdAfter = await loadRunGraph(settings, liveBusinessKey);
    assert.deepEqual(identity(holdAfter), identity(holdBefore));

    return {
      missing,
      success: { process: successProcess, rejection: success, successBefore },
      live: { rejection: live, liveBefore, liveAfter, stop, stoppedProcess },
      hold: { rejection: hold, holdBefore },
      matrixCoverage:
        "resume_allowed=false, ARCHIVED, UNKNOWN, malformed values, ambiguous allowlist, and path mismatch are deterministic unit/integration cases; this E2E covers kintone revision and real child boundaries for missing, SUCCESS, LIVE, and hold.",
    };
  } finally {
    if (liveProcess?.child.exitCode === null) liveProcess.child.kill("SIGKILL");
    await Promise.all([
      allowlist.dispose(),
      successFixture.dispose(),
      liveFixture.dispose(),
    ]);
  }
});
