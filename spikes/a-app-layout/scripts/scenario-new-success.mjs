import {
  executeComparison,
  prepareRun,
  runNodeAttempt,
  runScenarioMain,
} from "./scenario-support.mjs";

export async function runNewSuccess(options = {}) {
  return executeComparison({
    scenario: "new-success",
    measurementIds: ["A-01", "A-12"],
    async runLayout({ adapter, dataset }) {
      const context = await prepareRun(adapter, dataset);
      for (const node of dataset.nodes) {
        await runNodeAttempt({
          adapter,
          dataset,
          node,
          state: context.states.get(node.nodeId),
          invocationId: dataset.invocationId,
          attemptNo: 1,
        });
      }
      await adapter.updateRunAggregate(context.run, dataset, "SUCCESS");
      await adapter.finalizeInvocation(
        context.invocation,
        dataset,
        "SUCCESS",
        "OK",
      );
      const release = await adapter.releaseNetworkLock(context.lock);
      return {
        passed: release.released,
        aggregateStatus: "SUCCESS",
        nodeStatuses: Object.fromEntries(
          dataset.nodes.map((node) => [node.nodeId, "SUCCESS"]),
        ),
        release,
      };
    },
    ...options,
  });
}

runScenarioMain(import.meta.url, {
  scenario: "new-success",
  measurementIds: ["A-01", "A-12"],
  async runLayout({ adapter, dataset }) {
    const context = await prepareRun(adapter, dataset);
    for (const node of dataset.nodes) {
      await runNodeAttempt({
        adapter,
        dataset,
        node,
        state: context.states.get(node.nodeId),
        invocationId: dataset.invocationId,
        attemptNo: 1,
      });
    }
    await adapter.updateRunAggregate(context.run, dataset, "SUCCESS");
    await adapter.finalizeInvocation(
      context.invocation,
      dataset,
      "SUCCESS",
      "OK",
    );
    const release = await adapter.releaseNetworkLock(context.lock);
    return { passed: release.released, aggregateStatus: "SUCCESS", release };
  },
});
