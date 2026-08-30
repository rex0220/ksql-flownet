import {
  assertObserved,
  cleanupTaggedRecords,
  ITEST_PREFIX,
  runIntegration,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-cleanup",
  async ({ config }) => {
    const removed = await cleanupTaggedRecords(config, ITEST_PREFIX);
    assertObserved(
      removed.total >= 0,
      { total: ">= 0" },
      removed,
      "cleanup件数が不正です",
    );
    return { prefix: ITEST_PREFIX, removed };
  },
  { selfCleanup: false },
);
