import assert from "node:assert/strict";
import { join } from "node:path";

import {
  assertSuccessfulImport,
  assertTargetRows,
  cleanupTargetRows,
  csvPath,
  csvRows,
  prepareCsv1Case,
  readMemoryMeasurement,
  runCsv1,
  runFixture,
  writeCsv,
} from "./csv1-support.mjs";
import { loadRunGraph } from "./support.mjs";

const ROW_COUNT = 10_000;

await runCsv1(
  import.meta.url,
  "csv1-04-10k-measure",
  async ({ settings, scope }) => {
    const measurements = [];
    for (const encoding of ["UTF8", "SJIS"]) {
      const caseScope = `${scope}_${encoding.toLowerCase()}`;
      const businessKey = `${caseScope}_10k`;
      const rows = csvRows(caseScope, ROW_COUNT, { value: "ASCII" });
      const keys = rows.map(({ key }) => key);
      const testCase = await prepareCsv1Case(settings, caseScope, {
        encoding,
      });
      const memoryFile = join(
        testCase.fixture.directory,
        "process-memory-peak.json",
      );
      try {
        const input = await writeCsv(
          csvPath(testCase.ioRoot, businessKey, settings.profile),
          rows,
        );
        assert.ok(
          input.bytes <= 10 * 1024 * 1024,
          "CSV sourceは10MiB上限内であること",
        );
        const harnessBefore = process.memoryUsage();
        const started = process.hrtime.bigint();
        const child = await runFixture(
          settings,
          testCase.fixture,
          businessKey,
          testCase.ioRoot,
          {
            memoryFile,
          },
        );
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const harnessAfter = process.memoryUsage();
        assert.equal(child.exitCode, 0, child.stderr || child.stdout);
        const graph = await loadRunGraph(settings, businessKey);
        const inputAudit = assertSuccessfulImport(
          graph,
          ROW_COUNT,
          encoding.toLowerCase(),
        );
        const target = await assertTargetRows(settings, rows);
        const childMemory = await readMemoryMeasurement(memoryFile);
        measurements.push({
          encoding: encoding.toLowerCase(),
          rows: ROW_COUNT,
          bytes: input.bytes,
          sha256: input.sha256,
          elapsedMs,
          childProcessMemory: childMemory,
          harnessMemory: { before: harnessBefore, after: harnessAfter },
          run: graph,
          inputAudit,
          target,
          cleanup: await cleanupTargetRows(settings, keys),
        });
      } finally {
        await Promise.all([
          cleanupTargetRows(settings, keys),
          testCase.dispose(),
        ]);
      }
    }
    return {
      gate: "10,000-row import into isolated CSV1 fixture app",
      measurementMethod:
        "elapsed wall clock around FlowNet run; kSQL-Flow child peak sampled from process.memoryUsage every 10ms",
      measurements,
    };
  },
);
