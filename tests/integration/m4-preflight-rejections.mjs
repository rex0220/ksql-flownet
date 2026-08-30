import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { ensureRun } from "../../dist/orchestration/ensure-run.js";
import { validateJobInspections } from "../../dist/executor/preflight.js";
import {
  createM4Executor,
  createM4Harness,
  getRecords,
  m4EnsureInput,
  runIntegration,
  summarizeError,
  updateRecordFields,
  uploadBundleBytes,
  withM4Fixture,
} from "./support.mjs";

async function rejected(operation, expectedCode) {
  let targetReturned = false;
  let caught;
  try {
    await operation();
    targetReturned = true;
  } catch (error) {
    caught = error;
  }
  assert.equal(
    targetReturned,
    false,
    `${expectedCode} returned an execution target`,
  );
  assert.equal(caught?.code, expectedCode);
  return {
    executionTargetReturned: targetReturned,
    error: summarizeError(caught),
  };
}

const nondeterministicDiagnostic = {
  code: "KSQL1306",
  severity: "warning",
  line: 2,
  column: 8,
  message: "server time function is not fixed by as-of",
};

await runIntegration(
  import.meta.url,
  "m4-preflight-rejections",
  async ({ config, scope }) => {
    const evidence = {};
    let mode;

    await withM4Fixture(
      scope,
      { networkId: `${scope}_hash` },
      async (fixture) => {
        const harness = createM4Harness(config, `${scope}_h`, fixture);
        mode = harness.mode;
        const input = (overrides = {}) =>
          m4EnsureInput(fixture, harness, `${scope}_h`, overrides);
        const created = await ensureRun(input());
        await created.close({ status: "CANCELLED", resultCode: "ITEST_SEED" });
        const records = await getRecords(
          config,
          "state",
          `record_type in ("NETWORK_RUN") and run_id in ("${created.run.value.run_id}")`,
        );
        assert.equal(records.length, 1);
        const tampered = Buffer.from(created.bundleBytes);
        tampered[Math.floor(tampered.length / 2)] ^= 1;
        const replacement = await uploadBundleBytes(
          config,
          tampered,
          `${scope}-tampered.zip`,
        );
        await updateRecordFields(config, "state", records[0], {
          source_bundle_attachment: [{ fileKey: replacement }],
        });
        evidence.hashMismatch = await rejected(
          () => ensureRun(input({ resume: true })),
          "BUNDLE_HASH_MISMATCH",
        );
      },
    );

    await withM4Fixture(
      scope,
      { networkId: `${scope}_profile` },
      async (fixture) => {
        const harness = createM4Harness(config, `${scope}_p`, fixture);
        const input = (overrides = {}) =>
          m4EnsureInput(fixture, harness, `${scope}_p`, overrides);
        const created = await ensureRun(input());
        await created.close({ status: "CANCELLED", resultCode: "ITEST_SEED" });
        const changed = createM4Executor({
          fixtures: { describeProfile: "describe-profile-mismatch.json" },
          transform: {
            describeProfile: (value) => ({
              ...value,
              baseUrl: "https://other.cybozu.com",
              apps: { ...value.apps, orders: 102 },
            }),
          },
          events: harness.observations.cli,
        });
        harness.executor = changed.executor;
        evidence.profileMismatch = await rejected(
          () => ensureRun(input({ resume: true })),
          "PROFILE_SNAPSHOT_MISMATCH",
        );
      },
    );

    await withM4Fixture(
      scope,
      { networkId: `${scope}_job` },
      async (fixture) => {
        const harness = createM4Harness(config, `${scope}_j`, fixture, {
          fixtures: { inspectJob: "inspect-job-id-mismatch.json" },
          transform: {
            inspectJob: (value) => ({ ...value, jobId: "different_job" }),
          },
        });
        evidence.jobIdMismatch = await rejected(
          () => ensureRun(m4EnsureInput(fixture, harness, `${scope}_j`)),
          "JOB_ID_MISMATCH",
        );
        const runs = await getRecords(
          config,
          "state",
          `record_type in ("NETWORK_RUN") and network_id in ("${fixture.networkId}")`,
        );
        assert.equal(runs.length, 0);
        evidence.jobIdMismatch.runCountAfter = runs.length;
      },
    );

    await withM4Fixture(
      scope,
      {
        networkId: `${scope}_ksql1306`,
        sql: "-- @ksql name: aggregate_customer\nSELECT NOW() FROM APP2;\n",
      },
      async (fixture) => {
        const transform = {
          inspectJob: (value) => ({
            ...value,
            jobId: fixture.jobId,
            diagnostics: [
              ...value.diagnostics.filter(({ code }) => code !== "KSQL1306"),
              nondeterministicDiagnostic,
            ],
            nondeterministicElements: [nondeterministicDiagnostic],
          }),
        };
        const harness = createM4Harness(config, `${scope}_n`, fixture, {
          fixtures: { inspectJob: "inspect-job-ksql1306.json" },
          transform,
        });
        evidence.unapprovedKsql1306 = await rejected(
          () => ensureRun(m4EnsureInput(fixture, harness, `${scope}_n`)),
          "NONDETERMINISTIC_IDEMPOTENT_JOB",
        );
        const approvedPath = new URL(
          "../fixtures/executor/approved-ksql1306.json",
          import.meta.url,
        );
        const approvals = JSON.parse(await readFile(approvedPath, "utf8"));
        const inspected = await harness.executor.inspectJob(fixture.sqlPath);
        const approved = validateJobInspections(
          [
            {
              id: fixture.nodeId,
              job_id: fixture.jobId,
              sql: `jobs/${fixture.nodeId}.sql`,
              depends_on: [],
              trigger_rule: "all_success",
              idempotent: true,
            },
          ],
          new Map([[fixture.nodeId, inspected]]),
          approvals,
        );
        assert.deepEqual(approved[0].nondeterministicCodes, ["KSQL1306"]);
        assert.deepEqual(approved[0].approvedExceptions, approvals);
        evidence.approvedKsql1306 = {
          preflightPassed: true,
          executionTargetReturned: false,
          approvedCodes: approved[0].nondeterministicCodes,
          approvedBy: approved[0].approvedExceptions[0].approved_by,
          boundary:
            "dist preflight approval API; ensure-run has no approval input in M4",
        };
      },
    );

    return { mode, evidence };
  },
);
