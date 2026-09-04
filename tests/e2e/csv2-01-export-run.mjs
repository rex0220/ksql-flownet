import assert from "node:assert/strict";

import {
  assertAuditHasNoLeak,
  assertCsvArtifact,
  destinationPrefix,
  destinationRows,
  ioAudit,
  makeCsv2Rows,
  outputAudit,
  prepareCsv2Case,
  seedFinalizeMarker,
  runCsv2,
  runCsv2Fixture,
  seedCsv2Input,
  csv2InputPath,
  csv2OutputPath,
} from "./csv2-support.mjs";
import { assertTargetRows, cleanupTargetRows } from "./csv1-support.mjs";
import { loadRunGraph } from "./support.mjs";

await runCsv2(
  import.meta.url,
  "csv2-01-export-run",
  async ({ settings, scope }) => {
    const businessKey = `${scope}_export`;
    const rows = makeCsv2Rows(scope, 3);
    const outputPrefix = destinationPrefix(scope, "OUT");
    const expected = destinationRows(rows, outputPrefix);
    const testCase = await prepareCsv2Case(settings, scope, {
      sourceKeys: rows.map(({ key }) => key),
      destinationPrefix: outputPrefix,
      expectedRows: rows.length,
    });
    const inputPath = csv2InputPath(
      testCase.ioRoot,
      businessKey,
      settings.profile,
    );
    const artifactPath = csv2OutputPath(
      testCase.ioRoot,
      businessKey,
      settings.profile,
    );
    try {
      await seedCsv2Input(testCase.ioRoot, businessKey, settings.profile, rows);
      await seedFinalizeMarker(settings, testCase);
      const process = await runCsv2Fixture(settings, testCase, businessKey);
      assert.equal(process.exitCode, 0, process.stderr || process.stdout);
      const graph = await loadRunGraph(settings, businessKey);
      assert.equal(graph.attempts.length, 4);
      const inputAudit = ioAudit(graph, testCase.fixture, rows.length, "UTF8");
      const receipt = outputAudit(
        graph,
        testCase.fixture,
        expected.length,
        "utf8",
      );
      const artifact = await assertCsvArtifact(artifactPath, expected, "utf8");
      assert.equal(artifact.sha256, receipt.sha256);
      const source = await assertTargetRows(settings, rows);
      const auditSafety = await assertAuditHasNoLeak(settings, graph, [
        inputPath,
        artifactPath,
        rows[0].value,
      ]);
      return {
        process: { exitCode: process.exitCode },
        run: graph,
        inputAudit,
        output: { ...artifact, encoding: receipt.encoding },
        source,
        auditSafety,
      };
    } finally {
      await Promise.all([
        cleanupTargetRows(
          settings,
          [...rows, ...expected].map(({ key }) => key).concat(testCase.finalizeMarkerKey),
        ),
        testCase.dispose(),
      ]);
    }
  },
);
