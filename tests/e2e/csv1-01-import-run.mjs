import assert from "node:assert/strict";

import {
  PRIVATE_CELL,
  assertAuditHasNoLeak,
  assertSuccessfulImport,
  assertTargetRows,
  cleanupTargetRows,
  csvPath,
  csvRows,
  prepareCsv1Case,
  runCsv1,
  runFixture,
  writeCsv,
} from "./csv1-support.mjs";
import { loadRunGraph } from "./support.mjs";

await runCsv1(
  import.meta.url,
  "csv1-01-import-run",
  async ({ settings, scope }) => {
    const businessKey = `${scope}_utf8`;
    const rows = csvRows(scope, 3);
    const testCase = await prepareCsv1Case(settings, scope, {
      encoding: "UTF8",
    });
    const inputPath = csvPath(testCase.ioRoot, businessKey, settings.profile);
    try {
      const input = await writeCsv(inputPath, rows);
      const process = await runFixture(
        settings,
        testCase.fixture,
        businessKey,
        testCase.ioRoot,
      );
      assert.equal(process.exitCode, 0, process.stderr || process.stdout);
      const graph = await loadRunGraph(settings, businessKey);
      const inputAudit = assertSuccessfulImport(graph, rows.length, "utf8");
      const target = await assertTargetRows(settings, rows);
      const auditSafety = await assertAuditHasNoLeak(settings, graph, [
        inputPath,
        PRIVATE_CELL,
      ]);
      return {
        process: { exitCode: process.exitCode },
        run: graph,
        input: { rows: input.rows, bytes: input.bytes, sha256: input.sha256 },
        inputAudit,
        target,
        auditSafety,
        cleanup: await cleanupTargetRows(
          settings,
          rows.map(({ key }) => key),
        ),
      };
    } finally {
      await Promise.all([
        cleanupTargetRows(
          settings,
          rows.map(({ key }) => key),
        ),
        testCase.dispose(),
      ]);
    }
  },
);
