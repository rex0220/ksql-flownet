import assert from "node:assert/strict";

import { verifyBundle } from "../../dist/bundle/index.js";
import { ensureRun } from "../../dist/orchestration/ensure-run.js";
import {
  createM4Harness,
  downloadBundleBytes,
  getRecords,
  m4EnsureInput,
  runIntegration,
  withM4Fixture,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m4-ensure-run-branches",
  async ({ config, scope }) =>
    withM4Fixture(scope, {}, async (fixture) => {
      const harness = createM4Harness(config, scope, fixture);
      const input = (overrides = {}) =>
        m4EnsureInput(fixture, harness, scope, overrides);

      const created = await ensureRun(input());
      assert.equal(created.outcome, "NEW");
      const persistedRuns = await getRecords(
        config,
        "state",
        `record_type in ("NETWORK_RUN") and run_id in ("${created.run.value.run_id}")`,
      );
      assert.equal(persistedRuns.length, 1);
      const attachment = persistedRuns[0].source_bundle_attachment.value;
      assert.equal(attachment.length, 1);
      const persistedBytes = await downloadBundleBytes(
        config,
        attachment[0].fileKey,
      );
      const verified = verifyBundle(persistedBytes, {
        zipSha256: created.run.value.source_bundle_sha256,
      });
      await created.close({ status: "CANCELLED", resultCode: "ITEST_SEED" });

      const resumed = await ensureRun(input({ resume: true }));
      assert.equal(resumed.outcome, "RESUME");
      assert.equal(resumed.run.value.run_id, created.run.value.run_id);
      await resumed.close({ status: "CANCELLED", resultCode: "ITEST_RESUME" });

      const current = await harness.repository.getRun(created.run.value.run_id);
      await harness.repository.updateRunAggregate(
        current.value.run_id,
        current.revision,
        {
          status: "SUCCESS",
          started_at: current.value.created_at,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      );
      const noop = await ensureRun(input({ resume: true }));
      assert.equal(noop.outcome, "NOOP");
      assert.equal(noop.invocation, null);
      const invocations = await getRecords(
        config,
        "audit",
        `record_type in ("RUN_INVOCATION") and run_id in ("${created.run.value.run_id}")`,
      );
      assert.equal(invocations.length, 2, "NOOP must not create an Invocation");

      return {
        mode: harness.mode,
        outcomes: [created.outcome, resumed.outcome, noop.outcome],
        runId: created.run.value.run_id,
        persistedRunCount: persistedRuns.length,
        invocationCountAfterNoop: invocations.length,
        attachment: {
          count: attachment.length,
          byteLength: persistedBytes.byteLength,
          zipSha256: verified.zipSha256,
        },
        observations: harness.observations,
        multipleRows: {
          exercisedHere: false,
          evidence: "M3 m3-run-uniqueness and ensure-run unit MULTIPLE_RUNS",
        },
      };
    }),
);
