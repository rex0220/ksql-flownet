import {
  executeComparison,
  runMidFailureState,
  runNodeAttempt,
  runScenarioMain,
} from "./scenario-support.mjs";

const configuration = {
  scenario: "resume",
  measurementIds: ["A-03", "A-12"],
  async runLayout({ adapter, dataset }) {
    const context = await runMidFailureState(adapter, dataset);
    const selected = ["aggregate", "send"];
    const preserved = ["extract"];
    const resumeInvocation = await adapter.createInvocation(dataset, {
      invocationId: dataset.resumeInvocationId,
      mode: "RESUME",
      selected,
      preserved,
      blocked: [],
    });
    const [, node2, node3] = dataset.nodes;
    await adapter.upsertNodeState({
      dataset,
      node: node2,
      reference: context.states.get(node2.nodeId),
      values: {
        status: "WAITING",
        status_reason: "",
        updated_at: dataset.now(),
      },
    });
    await adapter.upsertNodeState({
      dataset,
      node: node3,
      reference: context.states.get(node3.nodeId),
      values: {
        status: "WAITING",
        blocked_by: [],
        status_reason: "",
        updated_at: dataset.now(),
      },
    });
    await runNodeAttempt({
      adapter,
      dataset,
      node: node2,
      state: context.states.get(node2.nodeId),
      invocationId: dataset.resumeInvocationId,
      attemptNo: 2,
    });
    await runNodeAttempt({
      adapter,
      dataset,
      node: node3,
      state: context.states.get(node3.nodeId),
      invocationId: dataset.resumeInvocationId,
      attemptNo: 1,
    });
    await adapter.updateRunAggregate(context.run, dataset, "SUCCESS");
    await adapter.finalizeInvocation(
      resumeInvocation,
      dataset,
      "SUCCESS",
      "OK",
    );
    const release = await adapter.releaseNetworkLock(context.lock);
    return {
      passed: release.released,
      aggregateStatus: "SUCCESS",
      selectedNodeIds: selected,
      preservedNodeIds: preserved,
      attemptsAdded: { extract: 0, aggregate: 1, send: 1 },
      aggregateAttemptNo: 2,
      release,
    };
  },
};

export async function runResume(options = {}) {
  return executeComparison({ ...configuration, ...options });
}

runScenarioMain(import.meta.url, configuration);
