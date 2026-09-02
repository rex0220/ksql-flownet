import assert from "node:assert/strict";

import {
  assertStartCorrelation,
  createP211Allowlist,
  createStartRequest,
  pollAndWait,
  prepareP211Network,
  runP211,
} from "./p2-11-support.mjs";

await runP211(
  import.meta.url,
  "p2-11-01-explicit",
  async ({ settings, scope }) => {
    const fixture = await prepareP211Network(`${scope}_explicit`, "explicit");
    const allowlist = await createP211Allowlist([fixture]);
    try {
      const businessKey = `${scope}_explicit_key`;
      const created = await createStartRequest(
        settings,
        scope,
        "explicit-start",
        {
          networkId: fixture.networkId,
          businessKey,
        },
      );
      const completed = await pollAndWait(settings, allowlist.path, created);
      assert.equal(completed.request.requestState, "DONE");
      // DONEのresult_codeはInvocation result codeの転記(G-04/G-07)。成功はOK。
      assert.equal(completed.request.resultCode, "OK");
      const correlation = await assertStartCorrelation(
        settings,
        completed.request,
        businessKey,
      );
      assert.equal(correlation.graph.run.networkId, fixture.networkId);
      assert.equal(correlation.graph.run.status, "SUCCESS");
      assert.ok(
        correlation.graph.states.every(({ status }) => status === "SUCCESS"),
        "ボード対象の全Node StateがSUCCESSであること",
      );
      return { fixture: fixture.networkId, completed, correlation };
    } finally {
      await Promise.all([allowlist.dispose(), fixture.dispose()]);
    }
  },
);
