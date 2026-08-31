import assert from "node:assert/strict";

import {
  cleanupM5Records,
  cleanupM5Workdirs,
  M5_PREFIX,
  runM5,
} from "./support.mjs";

await runM5(
  import.meta.url,
  "cleanup",
  async ({ settings }) => {
    const removed = await cleanupM5Records(settings, M5_PREFIX);
    const localWorkdirs = await cleanupM5Workdirs(
      settings.workdirBase,
      M5_PREFIX,
    );
    assert.ok(removed.total >= 0);
    return {
      prefix: M5_PREFIX,
      removed,
      localWorkdirs,
      e2eJobLogApp: "NOT_DELETED",
    };
  },
  { selfCleanup: false },
);
