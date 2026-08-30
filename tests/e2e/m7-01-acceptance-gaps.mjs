import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  byNode,
  getJobLogs,
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runM7,
  summarizeJobLog,
} from "./support.mjs";

await runM7(
  import.meta.url,
  "01-acceptance-gaps",
  async ({ settings, scope }) => {
    const diamond = await prepareNetwork(`${scope}_a`, "network-drill.yaml");
    const savedSql = await prepareNetwork(
      `${scope}_b`,
      "network-m6-midfail.yaml",
    );
    try {
      const diamondProcess = await runFlowNetNetwork(
        settings,
        diamond.networkPath,
        `${scope}_diamond`,
      );
      assert.equal(
        diamondProcess.exitCode,
        0,
        diamondProcess.stderr || diamondProcess.stdout,
      );
      const diamondGraph = await loadRunGraph(settings, `${scope}_diamond`);
      assert.equal(diamondGraph.run.status, "SUCCESS");
      assert.equal(diamondGraph.states.length, 3);
      assert.ok(
        diamondGraph.states.every(({ status }) => status === "SUCCESS"),
      );
      assert.equal(diamondGraph.attempts.length, 3);
      assert.ok(
        diamondGraph.attempts.every(({ status }) => status === "SUCCESS"),
      );
      assert.equal(diamondGraph.invocations.length, 1);
      assert.equal(diamondGraph.invocations[0].status, "SUCCESS");
      assert.equal(diamondGraph.invocations[0].resultCode, "OK");

      const stableOrder = ["n1_longread", "n2_independent", "n3_join"];
      assert.deepEqual(
        diamondGraph.attempts.map(({ nodeId }) => nodeId),
        stableOrder,
        "diamond attempts must be created in stable topological node-id order",
      );
      for (let index = 1; index < diamondGraph.attempts.length; index += 1) {
        assert.ok(
          diamondGraph.attempts[index - 1].recordId <
            diamondGraph.attempts[index].recordId,
          "attempt $id values must increase with serial creation order",
        );
      }
      const diamondLogs = (
        await getJobLogs(
          settings,
          `correlation_id = "${diamondGraph.run.runId}" order by $id asc`,
        )
      ).map(summarizeJobLog);
      assert.equal(diamondLogs.length, 3);
      assert.ok(diamondLogs.every(({ status }) => status === "SUCCESS"));

      const initial = await runFlowNetNetwork(
        settings,
        savedSql.networkPath,
        `${scope}_saved_sql`,
      );
      assert.equal(initial.exitCode, 1);
      const before = await loadRunGraph(settings, `${scope}_saved_sql`);
      const beforeAttempts = byNode(before.attempts);
      assert.equal(before.run.status, "FAILED");
      assert.equal(beforeAttempts.get("n2_fail").status, "FAILED");
      assert.equal(beforeAttempts.get("n2_fail").resultCode, "ASSERT_FAILED");

      const failingSqlPath = join(
        savedSql.directory,
        "jobs",
        "m6-assert-fail.sql",
      );
      const failingSql = await readFile(failingSqlPath, "utf8");
      const successfulSql = failingSql.replace(
        "ASSERT (SELECT 1) = 0",
        "ASSERT (SELECT 1) = 1",
      );
      assert.notEqual(successfulSql, failingSql);
      await writeFile(failingSqlPath, successfulSql, "utf8");

      const resumed = await runFlowNetNetwork(
        settings,
        savedSql.networkPath,
        `${scope}_saved_sql`,
        { resume: true },
      );
      assert.equal(resumed.exitCode, 1, resumed.stderr || resumed.stdout);
      assert.match(resumed.stdout, /^RESUME: /mu);
      const after = await loadRunGraph(settings, `${scope}_saved_sql`);
      const n2Attempts = after.attempts.filter(
        ({ nodeId }) => nodeId === "n2_fail",
      );
      assert.equal(after.run.runId, before.run.runId);
      assert.equal(n2Attempts.length, 2);
      assert.deepEqual(
        n2Attempts.map(({ attemptNo, status, resultCode }) => ({
          attemptNo,
          status,
          resultCode,
        })),
        [
          { attemptNo: 1, status: "FAILED", resultCode: "ASSERT_FAILED" },
          { attemptNo: 2, status: "FAILED", resultCode: "ASSERT_FAILED" },
        ],
        "resume must ignore the successful working-tree SQL and reuse the saved failing SQL",
      );
      return {
        diamond: {
          process: diamondProcess,
          networkId: diamond.networkId,
          stableOrder,
          graph: diamondGraph,
          jobLogs: diamondLogs,
        },
        savedSql: {
          initialProcess: initial,
          resumeProcess: resumed,
          networkId: savedSql.networkId,
          workingTreeSqlChangedToSuccess: true,
          before,
          after,
        },
      };
    } finally {
      await Promise.all([diamond.dispose(), savedSql.dispose()]);
    }
  },
);
