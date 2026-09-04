import assert from "node:assert/strict";

import {
  assertSuccessfulImport,
  assertTargetRows,
  cleanupTargetRows,
  csvPath,
  csvRows,
  getTargetRows,
  graphCounts,
  prepareCsv1Case,
  runCsv1,
  runFixture,
  writeCsv,
} from "./csv1-support.mjs";
import { loadRunGraph } from "./support.mjs";

async function createPartialFailure(
  settings,
  fixture,
  ioRoot,
  businessKey,
  rows,
) {
  const process = await runFixture(settings, fixture, businessKey, ioRoot, {
    failAfterTargetWrites: 1,
  });
  assert.equal(process.exitCode, 1, "fault injection後はFAILEDになること");
  const graph = await loadRunGraph(settings, businessKey);
  assert.equal(graph.run.status, "FAILED");
  assert.equal(graph.attempts.at(-1)?.status, "FAILED");
  const partial = await getTargetRows(
    settings,
    rows.map(({ key }) => key),
  );
  assert.ok(partial.length >= 1 && partial.length < rows.length);
  return {
    process: { exitCode: process.exitCode },
    graph,
    partialRows: partial.length,
  };
}

await runCsv1(
  import.meta.url,
  "csv1-02-mutated-resume",
  async ({ settings, scope }) => {
    const testCase = await prepareCsv1Case(settings, scope, {
      encoding: "UTF8",
    });
    const convergingRows = csvRows(`${scope}_same`, 250);
    const mutatedRows = csvRows(`${scope}_mutated`, 250);
    const allKeys = [...convergingRows, ...mutatedRows].map(({ key }) => key);
    try {
      const sameKey = `${scope}_same_file`;
      const samePath = csvPath(testCase.ioRoot, sameKey, settings.profile);
      const sameInput = await writeCsv(samePath, convergingRows);
      const first = await createPartialFailure(
        settings,
        testCase.fixture,
        testCase.ioRoot,
        sameKey,
        convergingRows,
      );
      const resumed = await runFixture(
        settings,
        testCase.fixture,
        sameKey,
        testCase.ioRoot,
        { resume: true },
      );
      assert.equal(resumed.exitCode, 0, resumed.stderr || resumed.stdout);
      const resumedGraph = await loadRunGraph(settings, sameKey);
      const target = await assertTargetRows(settings, convergingRows);
      assertSuccessfulImport(resumedGraph, convergingRows.length, "utf8");
      assert.equal(
        resumedGraph.attempts.length,
        first.graph.attempts.length + 1,
      );
      assert.equal(
        resumedGraph.invocations.length,
        first.graph.invocations.length + 1,
      );

      const mutationKey = `${scope}_mutation_reject`;
      const mutationPath = csvPath(
        testCase.ioRoot,
        mutationKey,
        settings.profile,
      );
      const originalInput = await writeCsv(mutationPath, mutatedRows);
      const mutationFirst = await createPartialFailure(
        settings,
        testCase.fixture,
        testCase.ioRoot,
        mutationKey,
        mutatedRows,
      );
      const beforeCounts = graphCounts(mutationFirst.graph);
      const beforeTarget = await getTargetRows(
        settings,
        mutatedRows.map(({ key }) => key),
      );
      const replacement = mutatedRows.map((row, index) =>
        index === 0 ? { ...row, value: `${row.value}_REPLACED` } : row,
      );
      const replacementInput = await writeCsv(mutationPath, replacement);
      assert.notEqual(originalInput.sha256, replacementInput.sha256);
      const rejected = await runFixture(
        settings,
        testCase.fixture,
        mutationKey,
        testCase.ioRoot,
        {
          resume: true,
        },
      );
      assert.equal(rejected.exitCode, 1);
      assert.match(
        `${rejected.stdout}\n${rejected.stderr}`,
        /INPUT_FILE_MUTATED/u,
      );
      const afterMutation = await loadRunGraph(settings, mutationKey);
      assert.deepEqual(graphCounts(afterMutation), beforeCounts);
      assert.deepEqual(
        await getTargetRows(
          settings,
          mutatedRows.map(({ key }) => key),
        ),
        beforeTarget,
        "MUTATED拒否は対象アプリを書き換えません",
      );

      return {
        sameFile: {
          first,
          resumed: resumedGraph,
          target,
          sha256: sameInput.sha256,
          convergence:
            "engine ON DUPLICATE pre-GET classified existing keys as updates and remaining keys as creates",
        },
        mutated: {
          first: mutationFirst,
          beforeCounts,
          afterCounts: graphCounts(afterMutation),
          originalSha256: originalInput.sha256,
          replacementSha256: replacementInput.sha256,
          rejection: "INPUT_FILE_MUTATED before Invocation creation",
        },
      };
    } finally {
      await Promise.all([
        cleanupTargetRows(settings, allKeys),
        testCase.dispose(),
      ]);
    }
  },
);
