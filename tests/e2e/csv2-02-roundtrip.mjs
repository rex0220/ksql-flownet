import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertCsvArtifact,
  csv2OutputPath,
  destinationPrefix,
  destinationRows,
  makeCsv2Rows,
  outputAudit,
  prepareCsv2Case,
  runCsv2,
  runCsv2Fixture,
  seedCsv2Input,
  seedFinalizeMarker,
} from "./csv2-support.mjs";
import {
  assertSuccessfulImport,
  assertTargetRows,
  cleanupTargetRows,
  csvPath,
  prepareCsv1Case,
  runFixture,
} from "./csv1-support.mjs";
import { loadRunGraph } from "./support.mjs";

await runCsv2(
  import.meta.url,
  "csv2-02-roundtrip",
  async ({ settings, scope }) => {
    const testCases = [];
    const results = [];
    const allRows = [];
    try {
      for (const encoding of ["utf8", "sjis"]) {
        const caseScope = `${scope}_${encoding}`;
        const businessKey = `${caseScope}_export`;
        const importBusinessKey = `${caseScope}_import`;
        const rows = makeCsv2Rows(caseScope, 3);
        const outputPrefix = destinationPrefix(caseScope, "ROUND");
        const expected = destinationRows(rows, outputPrefix);
        allRows.push(...rows, ...expected);
        const exportCase = await prepareCsv2Case(settings, caseScope, {
          importEncoding: encoding.toUpperCase(),
          sourceKeys: rows.map(({ key }) => key),
          destinationPrefix: outputPrefix,
          expectedRows: rows.length,
        });
        testCases.push(exportCase);
        allRows.push({ key: exportCase.finalizeMarkerKey, value: "finalize" });
        const importCase = await prepareCsv1Case(
          settings,
          `${caseScope}_destination`,
          { encoding: encoding.toUpperCase() },
        );
        testCases.push(importCase);
        await seedCsv2Input(
          exportCase.ioRoot,
          businessKey,
          settings.profile,
          rows,
        );
        // 受入17: マーカー未投入の初回はfinalize_gateで失敗し、Runは
        // FAILEDのままexport成果物だけが完成した状態を作る(SUCCESS終端は
        // 再開不能=RERUN_FROM_SUCCESS_RUN、が製品の正)。
        const first = await runCsv2Fixture(settings, exportCase, businessKey, {
          outputEncoding: encoding,
        });
        assert.notEqual(first.exitCode, 0, "finalizeゲートで失敗すること");
        const firstGraph = await loadRunGraph(settings, businessKey);
        const firstReceipt = outputAudit(
          firstGraph,
          exportCase.fixture,
          expected.length,
          encoding,
          { runStatus: "FAILED" },
        );
        const artifactPath = csv2OutputPath(
          exportCase.ioRoot,
          businessKey,
          settings.profile,
        );
        const artifact = await assertCsvArtifact(
          artifactPath,
          expected,
          encoding,
        );
        const importPath = csvPath(
          importCase.ioRoot,
          importBusinessKey,
          settings.profile,
        );
        await mkdir(dirname(importPath), { recursive: true });
        await copyFile(artifactPath, importPath);
        const imported = await runFixture(
          settings,
          importCase.fixture,
          importBusinessKey,
          importCase.ioRoot,
        );
        assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
        const importGraph = await loadRunGraph(settings, importBusinessKey);
        assertSuccessfulImport(importGraph, expected.length, encoding);
        const target = await assertTargetRows(settings, expected);

        await seedFinalizeMarker(settings, exportCase);
        const rerun = await runCsv2Fixture(settings, exportCase, "", {
          outputEncoding: encoding,
          resumeRun: firstGraph.run.runId,
          rerunFrom: exportCase.fixture.nodeId("export_csv"),
        });
        assert.equal(rerun.exitCode, 0, rerun.stderr || rerun.stdout);
        const rerunGraph = await loadRunGraph(settings, businessKey);
        assert.equal(rerunGraph.invocations.at(-1).mode, "RERUN_FROM");
        const rerunReceipt = outputAudit(
          rerunGraph,
          exportCase.fixture,
          expected.length,
          encoding,
        );
        assert.equal(rerunReceipt.sha256, firstReceipt.sha256);
        const rerunArtifact = await assertCsvArtifact(
          artifactPath,
          expected,
          encoding,
        );
        assert.equal(rerunArtifact.sha256, artifact.sha256);
        results.push({
          encoding,
          export: { exitCode: first.exitCode, receipt: firstReceipt },
          import: { exitCode: imported.exitCode, rows: target.count },
          rerun: {
            exitCode: rerun.exitCode,
            sha256: rerunReceipt.sha256,
          },
        });
      }
      return {
        acceptance1:
          "kSQL export bytes copied unchanged from out/ to the import-only in/ boundary and imported BY NAME",
        acceptance17:
          "same Run rerun-from export node produced the same SHA-256",
        cases: results,
      };
    } finally {
      await Promise.all([
        cleanupTargetRows(
          settings,
          allRows.map(({ key }) => key),
        ),
        ...testCases.map((item) => item.dispose()),
      ]);
    }
  },
);
