import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertNoTemporaryFiles,
  csv2FreshOutputPath,
  csv2OutputPath,
  destinationPrefix,
  destinationRows,
  makeCsv2Rows,
  prepareCsv2Case,
  runCsv2,
  runCsv2Fixture,
  seedCsv2Input,
} from "./csv2-support.mjs";
import { cleanupTargetRows } from "./csv1-support.mjs";
import { loadRunGraph } from "./support.mjs";

async function doesNotExist(path) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

await runCsv2(
  import.meta.url,
  "csv2-04-failclosed",
  async ({ settings, scope }) => {
    const createdCases = [];
    const allRows = [];
    try {
      const statementRows = makeCsv2Rows(`${scope}_statement`, 2);
      const statementDestination = destinationPrefix(scope, "STMT");
      allRows.push(
        ...statementRows,
        ...destinationRows(statementRows, statementDestination),
      );
      const statementCase = await prepareCsv2Case(
        settings,
        `${scope}_statement`,
        {
          sourceKeys: statementRows.map(({ key }) => key),
          destinationPrefix: statementDestination,
          expectedRows: statementRows.length,
          includeFreshOutput: true,
          afterExportSelect:
            "CREATE TEMP TABLE #fresh AS SELECT * FROM #report;\nASSERT 1 = 0, 'CSV2 intentional post-materialization failure';",
        },
      );
      createdCases.push(statementCase);
      const statementKey = `${scope}_statement`;
      await seedCsv2Input(
        statementCase.ioRoot,
        statementKey,
        settings.profile,
        statementRows,
      );
      const statementPath = csv2OutputPath(
        statementCase.ioRoot,
        statementKey,
        settings.profile,
      );
      const oldBytes = Buffer.from(
        "KSQL_FLOW_TEST_existing_artifact\r\n",
        "utf8",
      );
      await mkdir(dirname(statementPath), { recursive: true });
      await writeFile(statementPath, oldBytes);
      const freshPath = csv2FreshOutputPath(
        statementCase.ioRoot,
        statementKey,
        settings.profile,
      );
      const statement = await runCsv2Fixture(
        settings,
        statementCase,
        statementKey,
      );
      assert.notEqual(statement.exitCode, 0);
      assert.deepEqual(await readFile(statementPath), oldBytes);
      assert.equal(await doesNotExist(freshPath), true);
      const statementTemps = await assertNoTemporaryFiles(
        dirname(statementPath),
      );
      const statementGraph = await loadRunGraph(settings, statementKey);
      assert.equal(statementGraph.run.status, "FAILED");

      const sjisRows = makeCsv2Rows(`${scope}_sjis`, 1, {
        valuePrefix: "〜",
      });
      const sjisDestination = destinationPrefix(scope, "SJIS");
      allRows.push(...sjisRows, ...destinationRows(sjisRows, sjisDestination));
      const sjisCase = await prepareCsv2Case(settings, `${scope}_sjis`, {
        sourceKeys: sjisRows.map(({ key }) => key),
        destinationPrefix: sjisDestination,
        expectedRows: sjisRows.length,
      });
      createdCases.push(sjisCase);
      const sjisKey = `${scope}_sjis`;
      await seedCsv2Input(sjisCase.ioRoot, sjisKey, settings.profile, sjisRows);
      const sjisPath = csv2OutputPath(
        sjisCase.ioRoot,
        sjisKey,
        settings.profile,
      );
      const sjis = await runCsv2Fixture(settings, sjisCase, sjisKey, {
        outputEncoding: "sjis",
      });
      assert.notEqual(sjis.exitCode, 0);
      assert.equal(await doesNotExist(sjisPath), true);
      const sjisTemps = await assertNoTemporaryFiles(dirname(sjisPath));
      const sjisGraph = await loadRunGraph(settings, sjisKey);
      assert.equal(sjisGraph.run.status, "FAILED");

      return {
        acceptance14: {
          coveredBy:
            "C:/Users/rex02/Projects/ksql-flow/test/__tests__/export_sinks.test.ts and cli_contract.test.ts",
          assertion:
            "unnamed export with multiple statements is rejected before execution",
        },
        acceptance15: {
          exitCode: statement.exitCode,
          completedNewFile: false,
          existingFileUnchanged: true,
          ...statementTemps,
          run: statementGraph,
        },
        acceptance16: {
          exitCode: sjis.exitCode,
          codePoint: "U+301C",
          completedFile: false,
          ...sjisTemps,
          run: sjisGraph,
        },
      };
    } finally {
      await Promise.all([
        cleanupTargetRows(
          settings,
          allRows.map(({ key }) => key),
        ),
        ...createdCases.map((testCase) => testCase.dispose()),
      ]);
    }
  },
);
