import assert from "node:assert/strict";

import {
  assertCsvArtifact,
  csv2OutputPath,
  destinationPrefix,
  destinationRows,
  makeCsv2Rows,
  prepareCsv2Case,
  seedFinalizeMarker,
  runCliKintoneImport,
  runCsv2,
  runCsv2Fixture,
  seedCsv2Input,
} from "./csv2-support.mjs";
import {
  assertTargetRows,
  cleanupTargetRows,
  getTargetRows,
} from "./csv1-support.mjs";

await runCsv2(
  import.meta.url,
  "csv2-03-clikintone",
  async ({ settings, scope }) => {
    const businessKey = `${scope}_cli`;
    const rows = makeCsv2Rows(scope, 3);
    const outputPrefix = destinationPrefix(scope, "CLI");
    const expected = destinationRows(rows, outputPrefix);
    const testCase = await prepareCsv2Case(settings, scope, {
      sourceKeys: rows.map(({ key }) => key),
      destinationPrefix: outputPrefix,
      expectedRows: rows.length,
    });
    try {
      await seedCsv2Input(testCase.ioRoot, businessKey, settings.profile, rows);
      await seedFinalizeMarker(settings, testCase);
      const exported = await runCsv2Fixture(settings, testCase, businessKey);
      assert.equal(exported.exitCode, 0, exported.stderr || exported.stdout);
      const artifactPath = csv2OutputPath(
        testCase.ioRoot,
        businessKey,
        settings.profile,
      );
      const artifact = await assertCsvArtifact(artifactPath, expected, "utf8");
      assert.deepEqual(
        await getTargetRows(
          settings,
          expected.map(({ key }) => key),
        ),
        [],
        "cli-kintone取込先キー空間は開始時に空であること",
      );
      const cli = await runCliKintoneImport(settings, artifactPath);
      const target = await assertTargetRows(settings, expected);
      return {
        export: { exitCode: exported.exitCode, ...artifact },
        cliKintone: cli,
        target,
        authentication: "API token argument supplied without persistence",
      };
    } finally {
      await Promise.all([
        cleanupTargetRows(
          settings,
          [...rows, ...expected]
            .map(({ key }) => key)
            .concat(testCase.finalizeMarkerKey),
        ),
        testCase.dispose(),
      ]);
    }
  },
);
