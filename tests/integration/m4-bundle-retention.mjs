import assert from "node:assert/strict";

import { verifyBundle } from "../../dist/bundle/index.js";
import { ensureRun } from "../../dist/orchestration/ensure-run.js";
import {
  createM4Harness,
  downloadBundleBytes,
  getRecords,
  m4EnsureInput,
  runIntegration,
  summarizeError,
  updateRecordFields,
  withM4Fixture,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m4-bundle-retention",
  async ({ config, scope }) =>
    withM4Fixture(scope, {}, async (fixture) => {
      const harness = createM4Harness(config, scope, fixture);
      const input = (overrides = {}) =>
        m4EnsureInput(fixture, harness, scope, overrides);
      const created = await ensureRun(input());
      await created.close({ status: "CANCELLED", resultCode: "ITEST_SEED" });
      let records = await getRecords(
        config,
        "state",
        `record_type in ("NETWORK_RUN") and run_id in ("${created.run.value.run_id}")`,
      );
      assert.equal(records.length, 1);
      const fileKey = records[0].source_bundle_attachment.value[0].fileKey;
      const retainedBytes = await downloadBundleBytes(config, fileKey);
      const retained = verifyBundle(retainedBytes, {
        zipSha256: created.run.value.source_bundle_sha256,
      });

      await updateRecordFields(config, "state", records[0], {
        resume_allowed: "false",
      });
      let archivedTargetReturned = false;
      let archivedError;
      try {
        await ensureRun(input({ resume: true }));
        archivedTargetReturned = true;
      } catch (error) {
        archivedError = error;
      }
      assert.equal(archivedTargetReturned, false);
      assert.equal(archivedError?.code, "RUN_NOT_RESUMABLE");

      records = await getRecords(
        config,
        "state",
        `record_type in ("NETWORK_RUN") and run_id in ("${created.run.value.run_id}")`,
      );
      await updateRecordFields(config, "state", records[0], {
        resume_allowed: "true",
      });
      const restored = await ensureRun(input({ resume: true }));
      assert.equal(restored.outcome, "RESUME");
      assert.equal(restored.run.value.run_id, created.run.value.run_id);
      assert.equal(
        verifyBundle(restored.bundleBytes, {
          zipSha256: retained.zipSha256,
        }).zipSha256,
        retained.zipSha256,
      );
      await restored.close({
        status: "CANCELLED",
        resultCode: "ITEST_RESTORED",
      });

      return {
        mode: harness.mode,
        runId: created.run.value.run_id,
        retained: {
          byteLength: retainedBytes.byteLength,
          zipSha256: retained.zipSha256,
        },
        archiveEquivalent: {
          resumeAllowed: false,
          executionTargetReturned: archivedTargetReturned,
          rejection: summarizeError(archivedError),
        },
        restored: {
          resumeAllowed: true,
          outcome: restored.outcome,
          bundleSha256: retained.zipSha256,
        },
        observations: harness.observations,
      };
    }),
);
