import assert from "node:assert/strict";

import { ensureRun } from "../../dist/orchestration/ensure-run.js";
import {
  createM4Harness,
  getRecordByKey,
  getRecords,
  m4EnsureInput,
  runIntegration,
  summarizeError,
  withM4Fixture,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m4-capability-gate",
  async ({ config, scope }) =>
    withM4Fixture(scope, {}, async (fixture) => {
      const harness = createM4Harness(config, scope, fixture, {
        fixtures: { capabilities: "capabilities-missing-feature.json" },
        transform: {
          capabilities: (value) => ({
            ...value,
            features: { ...value.features, inspectJob: false },
          }),
        },
      });
      const beforeLock = await getRecordByKey(
        config,
        "state",
        harness.lockManager.recordKey,
      );
      assert.equal(beforeLock, null);
      let targetReturned = false;
      let caught;
      try {
        await ensureRun(m4EnsureInput(fixture, harness, scope));
        targetReturned = true;
      } catch (error) {
        caught = error;
      }
      assert.equal(targetReturned, false);
      assert.equal(caught?.code, "CAPABILITY_FEATURE_MISSING");
      assert.equal(
        harness.observations.lock.some(
          ({ operation }) => operation === "acquire",
        ),
        false,
      );
      const afterLock = await getRecordByKey(
        config,
        "state",
        harness.lockManager.recordKey,
      );
      const runs = await getRecords(
        config,
        "state",
        `record_type in ("NETWORK_RUN") and network_id in ("${fixture.networkId}")`,
      );
      assert.equal(afterLock, null);
      assert.equal(runs.length, 0);

      return {
        mode: harness.mode,
        executionTargetReturned: targetReturned,
        rejection: summarizeError(caught),
        lockRecordBefore: beforeLock,
        lockRecordAfter: afterLock,
        runCountAfter: runs.length,
        observations: harness.observations,
      };
    }),
);
