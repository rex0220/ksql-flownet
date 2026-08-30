import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  byNode,
  loadAttemptResolutions,
  loadRunGraph,
  prepareNetwork,
  runFlowNetCommand,
  runFlowNetNetwork,
  runM6,
} from "./support.mjs";

function resolveArguments(runId, reasonFile, evidenceRef, approvedBy) {
  return [
    "resolve-node",
    "--run-id",
    runId,
    "--node-id",
    "n2_nonidem",
    "--to",
    "SUCCESS",
    "--manual-completion",
    "--reason-file",
    reasonFile,
    "--evidence-ref",
    evidenceRef,
    "--stop-confirmed-by",
    "m6-e2e-operator",
    "--stop-evidence-ref",
    evidenceRef,
    "--approved-by",
    approvedBy,
  ];
}

await runM6(
  import.meta.url,
  "nonidem-no-auto-rerun",
  async ({ settings, scope, evidenceRef }) => {
    const fixture = await prepareNetwork(scope, "network-nonidem.yaml");
    const reasonFile = join(fixture.directory, "manual-completion-reason.txt");
    await writeFile(
      reasonFile,
      "M6 E2E operator verified the non-idempotent work was completed manually.\n",
      "utf8",
    );
    try {
      const initial = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        scope,
      );
      assert.equal(initial.exitCode, 1);
      const before = await loadRunGraph(settings, scope);
      const failedBefore = before.attempts.filter(
        ({ nodeId }) => nodeId === "n2_nonidem",
      );
      assert.equal(failedBefore.length, 1);
      assert.equal(failedBefore[0].status, "FAILED");
      assert.equal(
        failedBefore[0].resultCode,
        "ASSERT_FAILED",
        "non-idempotent fixture must fail deterministically",
      );

      const automaticResume = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        scope,
        { resume: true },
      );
      assert.equal(automaticResume.exitCode, 1);
      const afterAutomaticResume = await loadRunGraph(settings, scope);
      assert.equal(
        afterAutomaticResume.attempts.filter(
          ({ nodeId }) => nodeId === "n2_nonidem",
        ).length,
        1,
        "non-idempotent failed node must not be automatically rerun",
      );

      const rejected = await runFlowNetCommand(
        settings,
        resolveArguments(
          before.run.runId,
          reasonFile,
          evidenceRef,
          settings.requestedBy,
        ),
      );
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr, /\[DISTINCT_APPROVER_REQUIRED\]/u);

      const approvedBy = "m6-e2e-independent-approver";
      assert.notEqual(approvedBy, settings.requestedBy);
      assert.notEqual(approvedBy, settings.servicePrincipal);
      const resolved = await runFlowNetCommand(
        settings,
        resolveArguments(before.run.runId, reasonFile, evidenceRef, approvedBy),
      );
      assert.equal(resolved.exitCode, 0, resolved.stderr);

      const afterResolution = await loadRunGraph(settings, scope);
      const resolutions = await loadAttemptResolutions(
        settings,
        afterResolution.attempts.map(({ attemptId }) => attemptId),
      );
      assert.equal(resolutions.length, 1);
      assert.deepEqual(
        {
          servicePrincipal: resolutions[0].servicePrincipal,
          requestedBy: resolutions[0].requestedBy,
          approvedBy: resolutions[0].approvedBy,
          stopConfirmedBy: resolutions[0].stopConfirmedBy,
          evidenceRef: resolutions[0].evidenceRef,
          reason: resolutions[0].reason,
        },
        {
          servicePrincipal: settings.servicePrincipal,
          requestedBy: settings.requestedBy,
          approvedBy,
          stopConfirmedBy: "m6-e2e-operator",
          evidenceRef,
          reason:
            "M6 E2E operator verified the non-idempotent work was completed manually.",
        },
      );

      const completed = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        scope,
        { resume: true },
      );
      assert.equal(completed.exitCode, 0, completed.stderr);
      const finalGraph = await loadRunGraph(settings, scope);
      const finalStates = byNode(finalGraph.states);
      assert.equal(finalStates.get("n3_finalize").status, "SUCCESS");
      assert.equal(finalGraph.run.status, "SUCCESS");
      assert.equal(
        finalGraph.attempts.filter(({ nodeId }) => nodeId === "n2_nonidem")
          .length,
        1,
      );
      return {
        networkId: fixture.networkId,
        initialProcess: initial,
        automaticResumeProcess: automaticResume,
        rejectedResolutionProcess: rejected,
        acceptedResolutionProcess: resolved,
        completedProcess: completed,
        resolutions,
        finalGraph,
      };
    } finally {
      await fixture.dispose();
    }
  },
);
