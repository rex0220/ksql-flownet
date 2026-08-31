import assert from "node:assert/strict";

import {
  loadRunGraph,
  runFlowNetNetwork,
  snapshotPersistenceRevisions,
} from "./support.mjs";
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

await runP201(
  import.meta.url,
  "06-get-failclosed",
  async ({ settings, scope }) => {
    const fixture = await prepareP201Network(scope, "network-success.yaml");
    const allowlist = await createAllowlist([fixture]);
    try {
      const initial = await runFlowNetNetwork(
        settings,
        fixture.networkPath,
        scope,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${P2_01_PREFIX}invalid` } },
      );
      assert.equal(initial.exitCode, 1);
      const graphBefore = await loadRunGraph(settings, scope);
      const request = await createRequest(settings, {
        requestType: "RERUN",
        runId: graphBefore.run.runId,
        reason: requestReason(scope, "get-failure-secret-reason"),
      });
      const requestBefore = await getRequest(settings, request.id);
      const persistenceBefore = await snapshotPersistenceRevisions(settings);

      const invalidToken = `${P2_01_PREFIX}invalid_request_token`;
      const poller = await runPollRequests(settings, allowlist.path, {
        requestApiToken: invalidToken,
      });
      assert.equal(poller.exitCode, 1);
      assert.match(poller.stderr, /Error \[/u);
      assert.doesNotMatch(poller.stderr, new RegExp(invalidToken, "u"));
      assert.doesNotMatch(poller.stderr, /get-failure-secret-reason/u);
      assert.doesNotMatch(poller.stdout, /get-failure-secret-reason/u);

      const requestAfter = await getRequest(settings, request.id);
      const persistenceAfter = await snapshotPersistenceRevisions(settings);
      const graphAfter = await loadRunGraph(settings, scope);
      assert.deepEqual(
        requestAfter,
        requestBefore,
        "GET失敗時は要求を書きません",
      );
      assert.deepEqual(
        persistenceAfter,
        persistenceBefore,
        "GET失敗時はFlowNet state/auditを書きません",
      );
      assert.equal(
        graphAfter.invocations.length,
        graphBefore.invocations.length,
        "GET失敗時はchildを起動しません",
      );
      return {
        networkId: fixture.networkId,
        runId: graphBefore.run.runId,
        initial,
        poller,
        requestBefore,
        requestAfter,
        persistenceBefore,
        persistenceAfter,
      };
    } finally {
      await Promise.all([allowlist.dispose(), fixture.dispose()]);
    }
  },
);
