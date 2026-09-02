import assert from "node:assert/strict";

import { loadRunGraph, runFlowNetNetwork } from "./support.mjs";
import {
  assertPersistenceUnchanged,
  createP211Allowlist,
  createStartRequest,
  graphIdentity,
  persistenceSnapshot,
  pollAndWait,
  prepareP211Network,
  runP211,
} from "./p2-11-support.mjs";

async function rejectUnchanged(settings, allowlistPath, created, code, detail) {
  const before = await persistenceSnapshot(settings);
  const result = await pollAndWait(settings, allowlistPath, created);
  assert.equal(result.request.requestState, "REJECTED");
  assert.equal(result.request.resultCode, code);
  if (detail !== undefined) assert.match(result.request.resultMessage, detail);
  await assertPersistenceUnchanged(settings, before);
  return result;
}

await runP211(
  import.meta.url,
  "p2-11-04-rejections",
  async ({ settings, scope }) => {
    const explicit = await prepareP211Network(`${scope}_explicit`, "explicit");
    const scheduled = await prepareP211Network(
      `${scope}_scheduled`,
      "scheduled",
    );
    const disabled = await prepareP211Network(`${scope}_disabled`, "explicit");
    disabled.appStart = false;
    const maxFixture = await prepareP211Network(`${scope}_max`, "explicit");
    const allowlist = await createP211Allowlist([
      explicit,
      scheduled,
      disabled,
      maxFixture,
    ]);
    try {
      const cases = {};
      cases.notAllowed = await rejectUnchanged(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "not-in-allowlist", {
          networkId: `${scope}_not_allowed`,
          businessKey: `${scope}_not_allowed_key`,
        }),
        "NETWORK_NOT_ALLOWED",
        /NOT_IN_ALLOWLIST/u,
      );
      cases.appDisabled = await rejectUnchanged(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "app-start-disabled", {
          networkId: disabled.networkId,
          businessKey: `${scope}_disabled_key`,
        }),
        "NETWORK_NOT_ALLOWED",
        /APP_START_DISABLED/u,
      );
      cases.asOfUndefined = await rejectUnchanged(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "as-of-undefined", {
          networkId: scheduled.networkId,
          businessKey: `${scope}_correction_without_period`,
        }),
        "AS_OF_UNDEFINED",
      );
      cases.keyPolicy = await rejectUnchanged(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "key-policy-mismatch", {
          networkId: explicit.networkId,
          scheduledFor: "2026-08-15T00:00:00.000Z",
        }),
        "KEY_POLICY_MISMATCH",
      );
      cases.runId = await rejectUnchanged(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "run-id-not-allowed", {
          networkId: explicit.networkId,
          businessKey: `${scope}_run_id_key`,
          runId: `${scope}_forbidden_run_id`,
        }),
        "RUN_ID_NOT_ALLOWED",
      );

      const beforeInvalidTimestamp = await persistenceSnapshot(settings);
      await assert.rejects(
        createStartRequest(settings, scope, "invalid-timestamp", {
          networkId: scheduled.networkId,
          scheduledFor: "not-a-timestamp",
        }),
        /要求アプリAPI POST record/u,
        "DATETIME欄は不正日時を保存前に拒否します",
      );
      await assertPersistenceUnchanged(settings, beforeInvalidTimestamp);

      const blockerKey = `${scope}_max_blocker`;
      const failed = await runFlowNetNetwork(
        settings,
        maxFixture.networkPath,
        blockerKey,
        { environment: { KSQL_TOKEN_CUSTOMERS: `${scope}_invalid` } },
      );
      assert.equal(failed.exitCode, 1, failed.stderr || failed.stdout);
      const blockerBefore = await loadRunGraph(settings, blockerKey);
      cases.maxActive = await rejectUnchanged(
        settings,
        allowlist.path,
        await createStartRequest(settings, scope, "max-active-runs", {
          networkId: maxFixture.networkId,
          businessKey: `${scope}_different_key`,
        }),
        "MAX_ACTIVE_RUNS",
        new RegExp(blockerBefore.run.runId, "u"),
      );
      assert.deepEqual(
        graphIdentity(await loadRunGraph(settings, blockerKey)),
        graphIdentity(blockerBefore),
        "拒否ケースで既存未完了Runをresumeしません",
      );
      return {
        cases,
        invalidTimestamp:
          "kintone DATETIME validation rejected before record creation",
        maxBlocker: blockerBefore,
        nonIdempotent:
          "NETWORK_NOT_IDEMPOTENT is covered by poll-requests-start unit S03 as specified; no non-idempotent E2E fixture is used.",
      };
    } finally {
      await Promise.all([
        allowlist.dispose(),
        explicit.dispose(),
        scheduled.dispose(),
        disabled.dispose(),
        maxFixture.dispose(),
      ]);
    }
  },
);
