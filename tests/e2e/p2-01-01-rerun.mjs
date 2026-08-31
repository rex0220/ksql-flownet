import assert from "node:assert/strict";

import { loadRunGraph, runFlowNetNetwork } from "./support.mjs";
import {
  createAllowlist,
  createRequest,
  getRequest,
  P2_01_PREFIX,
  prepareP201Network,
  requestReason,
  runP201,
  runPollRequests,
} from "./p2-01-support.mjs";

await runP201(import.meta.url, "01-rerun", async ({ settings, scope }) => {
  const fixture = await prepareP201Network(scope, "network-success.yaml");
  const allowlist = await createAllowlist([fixture]);
  try {
    const initial = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
      { environment: { KSQL_TOKEN_CUSTOMERS: `${P2_01_PREFIX}invalid` } },
    );
    assert.equal(initial.exitCode, 1, initial.stderr || initial.stdout);
    const before = await loadRunGraph(settings, scope);
    assert.equal(before.run.status, "FAILED");

    const request = await createRequest(settings, {
      requestType: "RERUN",
      runId: before.run.runId,
      reason: requestReason(scope, "resume-failed-run"),
    });
    const poller = await runPollRequests(settings, allowlist.path);
    assert.equal(poller.exitCode, 0, poller.stderr || poller.stdout);
    assert.match(poller.stdout, /claimed=1/u);

    const completedRequest = await getRequest(settings, request.id);
    assert.equal(completedRequest.requestState, "DONE");
    const after = await loadRunGraph(settings, scope);
    assert.equal(after.run.runId, before.run.runId);
    assert.equal(after.run.status, "SUCCESS");
    assert.equal(after.invocations.length, before.invocations.length + 1);
    const expectedRequestedBy = `app-request:${request.id}:${encodeURIComponent(request.creatorCode)}`;
    assert.equal(after.invocations.at(-1).requestedBy, expectedRequestedBy);
    assert.match(
      completedRequest.resultMessage,
      new RegExp(
        `invocation_id=${after.invocations.at(-1).invocationId}$`,
        "u",
      ),
    );
    return {
      networkId: fixture.networkId,
      runId: before.run.runId,
      initial,
      poller,
      request: completedRequest,
      expectedRequestedBy,
      before,
      after,
    };
  } finally {
    await Promise.all([allowlist.dispose(), fixture.dispose()]);
  }
});
