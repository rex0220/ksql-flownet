import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { readStoreZip, verifyBundle } from "../../dist/bundle/index.js";
import { sha256Hex } from "../../dist/executor/preflight.js";
import { ensureRun } from "../../dist/orchestration/ensure-run.js";
import {
  createM4Harness,
  m4EnsureInput,
  runIntegration,
  withM4Fixture,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m4-bundle-continuity",
  async ({ config, scope }) =>
    withM4Fixture(scope, {}, async (fixture) => {
      const harness = createM4Harness(config, scope, fixture);
      const input = (overrides = {}) =>
        m4EnsureInput(fixture, harness, scope, overrides);
      const created = await ensureRun(input());
      assert.equal(created.outcome, "NEW");
      const originalSql = Buffer.from(fixture.sql, "utf8");
      const savedHash = created.run.value.source_bundle_sha256;
      await created.close({ status: "CANCELLED", resultCode: "ITEST_SEED" });

      const changedSql = `${fixture.sql}-- ITEST worktree change ${scope}\n`;
      await writeFile(fixture.sqlPath, changedSql, "utf8");
      const cliEventCount = harness.observations.cli.length;
      const resumed = await ensureRun(input({ resume: true }));
      assert.equal(resumed.outcome, "RESUME");
      const verified = verifyBundle(resumed.bundleBytes, {
        zipSha256: savedHash,
      });
      const storedSql = readStoreZip(resumed.bundleBytes).find(
        ({ name }) => name === "jobs/aggregate.sql",
      )?.data;
      assert.deepEqual(storedSql, originalSql);
      assert.notDeepEqual(storedSql, Buffer.from(changedSql, "utf8"));
      assert.equal(sha256Hex(resumed.bundleBytes), savedHash);
      const resumeCliEvents = harness.observations.cli.slice(cliEventCount);
      assert.deepEqual(
        resumeCliEvents.map(({ command }) => command),
        ["capabilities", "describe-profile"],
        "RESUME must not inspect worktree SQL",
      );
      await resumed.close({
        status: "CANCELLED",
        resultCode: "ITEST_CONTINUITY",
      });

      return {
        mode: harness.mode,
        runId: created.run.value.run_id,
        savedBundleSha256: savedHash,
        returnedBundleSha256: verified.zipSha256,
        savedSqlSha256: sha256Hex(storedSql),
        changedWorktreeSqlSha256: sha256Hex(Buffer.from(changedSql, "utf8")),
        resumeCliEvents,
        observations: harness.observations,
      };
    }),
);
