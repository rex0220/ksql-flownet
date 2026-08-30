import assert from "node:assert/strict";

import {
  byNode,
  getJobLogs,
  loadRunGraph,
  prepareNetwork,
  runFlowNetNetwork,
  runM5,
  summarizeJobLog,
} from "./support.mjs";

await runM5(import.meta.url, "serial-success", async ({ settings, scope }) => {
  const fixture = await prepareNetwork(scope, "network-success.yaml");
  try {
    const processResult = await runFlowNetNetwork(
      settings,
      fixture.networkPath,
      scope,
    );
    assert.equal(processResult.exitCode, 0, processResult.stderr);
    const graph = await loadRunGraph(settings, scope);
    assert.equal(graph.run.status, "SUCCESS");
    assert.equal(graph.states.length, 3);
    assert.ok(graph.states.every(({ status }) => status === "SUCCESS"));
    assert.equal(graph.attempts.length, 3);
    assert.ok(graph.attempts.every(({ status }) => status === "SUCCESS"));
    assert.equal(graph.invocations.length, 1);
    assert.equal(graph.invocations[0].status, "SUCCESS");

    const attempts = byNode(graph.attempts);
    const order = ["n1_extract", "n2_aggregate", "n3_finalize"];
    for (let index = 1; index < order.length; index += 1) {
      const previous = attempts.get(order[index - 1]);
      const current = attempts.get(order[index]);
      assert.ok(
        Date.parse(previous.finishedAt) <=
          Date.parse(current.executionStartedAt),
        `${previous.nodeId}と${current.nodeId}のAttempt時刻が重複しています`,
      );
    }

    const logRecords = await getJobLogs(
      settings,
      `correlation_id = "${graph.run.runId}" order by $id asc`,
    );
    assert.equal(logRecords.length, 3);
    const logs = logRecords.map(summarizeJobLog);
    for (const attempt of graph.attempts) {
      const log = logs.find(({ attemptId }) => attemptId === attempt.attemptId);
      assert.ok(log, `Attempt ${attempt.attemptId} のJOBログがありません`);
      assert.equal(log.correlationId, graph.run.runId);
      assert.equal(log.jobId, attempt.jobId);
      assert.equal(log.executionId, attempt.executionId);
      assert.equal(log.status, "SUCCESS");
    }
    return {
      process: processResult,
      graph,
      jobLogs: logs,
      serialOrder: order,
      networkId: fixture.networkId,
    };
  } finally {
    await fixture.dispose();
  }
});
