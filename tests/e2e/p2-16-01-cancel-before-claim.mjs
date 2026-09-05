import assert from "node:assert/strict";

import { createAllowlist, runPollRequests } from "./p2-01-support.mjs";
import {
  assertPersistenceUnchanged,
  assertStartCorrelation,
  createStartRequest,
  persistenceSnapshot,
  prepareP211Network,
  runP211,
  waitForTerminalRequest,
} from "./p2-11-support.mjs";
import { summarizeProcess, summarizeRequest } from "./p2-16-support.mjs";

await runP211(
  import.meta.url,
  "p2-16-01-cancel-before-claim",
  async ({ settings, scope }) => {
    const fixture = await prepareP211Network(scope, "explicit");
    const allowlist = await createAllowlist([fixture]);
    try {
      const before = await persistenceSnapshot(settings);
      const cancelled = await createStartRequest(
        settings,
        scope,
        "cancel-before-claim",
        {
          networkId: fixture.networkId,
          businessKey: `${scope}_cancelled`,
          cancelRequested: true,
        },
      );
      const invalidCancelled = await createStartRequest(
        settings,
        scope,
        "invalid-cancel-before-claim",
        {
          runId: `${scope} invalid run id!`,
          networkId: fixture.networkId,
          businessKey: `${scope}_invalid_cancelled`,
          cancelRequested: true,
        },
      );

      const poller = await runPollRequests(settings, allowlist.path);
      assert.equal(poller.exitCode, 0, poller.stderr || poller.stdout);
      const results = await Promise.all(
        [cancelled, invalidCancelled].map((request) =>
          waitForTerminalRequest(settings, request.id),
        ),
      );
      for (const result of results) {
        assert.equal(result.requestState, "CANCELLED");
        assert.equal(result.resultCode, "CANCELLED_BY_REQUESTER");
        assert.equal(result.claimedAt, null);
        assert.equal(result.claimedHost, null);
        await assertStartCorrelation(settings, result, "unused");
      }
      await assertPersistenceUnchanged(settings, before);

      // kintone CHECK_BOXへ定義外の値はAPIでも保存できないため、
      // cancelRequested="INVALID"相当のdecoder境界は単体S系を正とする。
      return {
        networkId: fixture.networkId,
        poller: summarizeProcess(poller),
        requests: results.map(summarizeRequest),
        invalidCancelRequestedCoverage:
          "kintone rejects undefined checkbox values; covered by deterministic unit S cases",
      };
    } finally {
      await Promise.all([allowlist.dispose(), fixture.dispose()]);
    }
  },
);
