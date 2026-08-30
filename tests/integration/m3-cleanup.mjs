import assert from "node:assert/strict";

import {
  cleanupTaggedRecords,
  ITEST_PREFIX,
  runIntegration,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-cleanup",
  async ({ config }) => {
    const removed = await cleanupTaggedRecords(config, ITEST_PREFIX);
    assert.ok(removed.total >= 0);
    return { prefix: ITEST_PREFIX, removed };
  },
  { selfCleanup: false },
);
