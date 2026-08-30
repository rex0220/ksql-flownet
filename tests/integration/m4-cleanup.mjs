import {
  assertObserved,
  cleanupTaggedRecords,
  ITEST_PREFIX,
  runIntegration,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m4-cleanup",
  async ({ config }) => {
    const removed = await cleanupTaggedRecords(config, ITEST_PREFIX);
    assertObserved(
      removed.total >= 0,
      { total: ">= 0" },
      removed,
      "M4 cleanup件数が不正です",
    );
    return {
      prefix: ITEST_PREFIX,
      removed,
      attachmentCleanup: "NETWORK_RUN削除によりbundle添付も清掃対象",
    };
  },
  { selfCleanup: false },
);
