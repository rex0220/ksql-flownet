import assert from "node:assert/strict";

import { loadRunGraph, runFlowNetNetwork } from "./support.mjs";
import {
  createP211Allowlist,
  createStartRequest,
  graphIdentity,
  listRuns,
  pollAndWait,
  prepareP211Network,
  runP211,
} from "./p2-11-support.mjs";
import { getRequest, runPollRequests } from "./p2-01-support.mjs";

await runP211(
  import.meta.url,
  "p2-11-03-duplicates",
  async ({ settings, scope }) => {
    const successFixture = await prepareP211Network(
      `${scope}_success`,
      "explicit",
    );
    const unfinishedFixture = await prepareP211Network(
      `${scope}_unfinished`,
      "explicit",
    );
    const concurrentFixture = await prepareP211Network(
      `${scope}_concurrent`,
      "explicit",
    );
    const allowlist = await createP211Allowlist([
      successFixture,
      unfinishedFixture,
      concurrentFixture,
    ]);
    try {
      const successKey = `${scope}_success_key`;
      const first = await pollAndWait(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "success-first", {
          networkId: successFixture.networkId,
          businessKey: successKey,
        }),
      );
      assert.equal(first.request.requestState, "DONE");
      const beforeNoop = await loadRunGraph(settings, successKey);
      const noop = await pollAndWait(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "success-noop", {
          networkId: successFixture.networkId,
          businessKey: successKey,
        }),
      );
      assert.equal(noop.request.requestState, "DONE");
      assert.equal(noop.request.resultCode, "NOOP_ALREADY_SUCCESS");
      assert.match(
        noop.request.resultMessage,
        new RegExp(beforeNoop.run.runId, "u"),
      );
      assert.deepEqual(
        graphIdentity(await loadRunGraph(settings, successKey)),
        graphIdentity(beforeNoop),
        "NOOPはInvocationを追加しません",
      );

      const unfinishedKey = `${scope}_unfinished_key`;
      const failed = await runFlowNetNetwork(
        settings,
        unfinishedFixture.networkPath,
        unfinishedKey,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${scope}_invalid` } },
      );
      assert.equal(failed.exitCode, 1, failed.stderr || failed.stdout);
      const unfinishedBefore = await loadRunGraph(settings, unfinishedKey);
      const blocked = await pollAndWait(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "unfinished-block", {
          networkId: unfinishedFixture.networkId,
          businessKey: unfinishedKey,
        }),
      );
      assert.equal(blocked.request.requestState, "REJECTED");
      assert.equal(blocked.request.resultCode, "RUN_ALREADY_EXISTS");
      assert.match(
        blocked.request.resultMessage,
        new RegExp(unfinishedBefore.run.runId, "u"),
      );
      assert.deepEqual(
        graphIdentity(await loadRunGraph(settings, unfinishedKey)),
        graphIdentity(unfinishedBefore),
        "未完了blockerをSTARTでresumeしません",
      );

      const concurrentKey = `${scope}_concurrent_key`;
      const concurrentRequests = await Promise.all([
        createStartRequest(settings, scope, "concurrent-a", {
          networkId: concurrentFixture.networkId,
          businessKey: concurrentKey,
        }),
        createStartRequest(settings, scope, "concurrent-b", {
          networkId: concurrentFixture.networkId,
          businessKey: concurrentKey,
        }),
      ]);
      const pollers = await Promise.all([
        runPollRequests(settings, allowlist.path),
        runPollRequests(settings, allowlist.path),
      ]);
      assert.ok(pollers.every(({ exitCode }) => exitCode === 0));
      const results = await Promise.all(
        concurrentRequests.map(({ id }) => getRequest(settings, id)),
      );
      assert.equal(
        (
          await listRuns(settings, {
            networkId: concurrentFixture.networkId,
            businessKey: concurrentKey,
          })
        ).length,
        1,
        "ほぼ同時の2要求でもNETWORK_RUNは1件だけです",
      );
      assert.ok(results.some(({ requestState }) => requestState === "DONE"));
      const loser = results.find(
        ({ requestState }) => requestState === "REJECTED",
      );
      if (loser !== undefined) {
        assert.ok(
          ["LOCK_CONFLICT", "RUN_ALREADY_EXISTS"].includes(loser.resultCode),
          `P-04の競合敗者code: ${loser.resultCode}`,
        );
      } else {
        assert.ok(
          results.some(
            ({ resultCode }) => resultCode === "NOOP_ALREADY_SUCCESS",
          ),
          "実行完了後に処理された競合要求はSUCCESS NOOPへ収束します",
        );
      }
      return { noop, blocked, concurrent: { pollers, results } };
    } finally {
      await Promise.all([
        allowlist.dispose(),
        successFixture.dispose(),
        unfinishedFixture.dispose(),
        concurrentFixture.dispose(),
      ]);
    }
  },
);
