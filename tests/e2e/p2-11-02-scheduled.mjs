import assert from "node:assert/strict";

import { field, getJobLogs } from "./support.mjs";
import {
  assertStartCorrelation,
  createP211Allowlist,
  createStartRequest,
  pollAndWait,
  prepareP211Network,
  readTargetPeriodAggregate,
  runP211,
  setScheduledAggregateExpectation,
} from "./p2-11-support.mjs";

function assertTargetPeriodEvidence(graph, logs, scheduledFor) {
  assert.equal(Date.parse(graph.run.asOf), Date.parse(scheduledFor));
  assert.ok(graph.attempts.length > 0);
  assert.ok(graph.attempts.every(({ status }) => status === "SUCCESS"));
  assert.ok(
    graph.attempts.every(
      ({ readCount, writtenCount }) =>
        Number.isInteger(readCount) && readCount >= 0 && writtenCount === 0,
    ),
    "対象期間断面の参照集計が成功し、業務アプリへ書き込んでいないこと",
  );
  assert.equal(logs.length, graph.attempts.length);
  for (const log of logs) {
    assert.equal(Date.parse(field(log, "as_of")), Date.parse(scheduledFor));
    assert.equal(field(log, "status"), "SUCCESS");
  }
}

await runP211(
  import.meta.url,
  "p2-11-02-scheduled",
  async ({ settings, scope }) => {
    const fixture = await prepareP211Network(`${scope}_scheduled`, "scheduled");
    const allowlist = await createP211Allowlist([fixture]);
    try {
      const scheduledFor = "2026-08-15T00:00:00.000Z";
      const expectedAggregate = await readTargetPeriodAggregate(settings, {
        fromDate: "2026-08-01",
        toDate: "2026-09-01",
      });
      await setScheduledAggregateExpectation(fixture, expectedAggregate);
      const derivedKey = `${fixture.networkId}@2026-08`;
      const regularCreated = await createStartRequest(
        settings,
        scope,
        "scheduled-start",
        { networkId: fixture.networkId, scheduledFor },
      );
      const regular = await pollAndWait(
        settings,
        allowlist.path,
        regularCreated,
      );
      assert.equal(regular.request.requestState, "DONE");
      const regularCorrelation = await assertStartCorrelation(
        settings,
        regular.request,
        derivedKey,
      );
      assert.equal(regularCorrelation.graph.run.businessKey, derivedKey);
      const regularLogs = await getJobLogs(
        settings,
        `correlation_id = "${regularCorrelation.graph.run.runId}" order by $id asc`,
      );
      assertTargetPeriodEvidence(
        regularCorrelation.graph,
        regularLogs,
        scheduledFor,
      );

      const correctionKey = `${fixture.networkId}@2026-08-correction-1`;
      const correctionCreated = await createStartRequest(
        settings,
        scope,
        "scheduled-correction",
        {
          networkId: fixture.networkId,
          businessKey: correctionKey,
          scheduledFor,
        },
      );
      const correction = await pollAndWait(
        settings,
        allowlist.path,
        correctionCreated,
      );
      assert.equal(correction.request.requestState, "DONE");
      const correctionCorrelation = await assertStartCorrelation(
        settings,
        correction.request,
        correctionKey,
      );
      assert.equal(correctionCorrelation.graph.run.businessKey, correctionKey);
      const correctionLogs = await getJobLogs(
        settings,
        `correlation_id = "${correctionCorrelation.graph.run.runId}" order by $id asc`,
      );
      assertTargetPeriodEvidence(
        correctionCorrelation.graph,
        correctionLogs,
        scheduledFor,
      );
      return {
        fixture: fixture.networkId,
        expectedAggregate,
        regular: {
          ...regular,
          correlation: regularCorrelation,
          logs: regularLogs,
        },
        correction: {
          ...correction,
          correlation: correctionCorrelation,
          logs: correctionLogs,
        },
      };
    } finally {
      await Promise.all([allowlist.dispose(), fixture.dispose()]);
    }
  },
);
