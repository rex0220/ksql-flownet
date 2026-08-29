import {
  executeComparison,
  prepareRun,
  runNodeAttempt,
  runScenarioMain,
} from "./scenario-support.mjs";

const configuration = {
  scenario: "reconciliation",
  measurementIds: ["A-04"],
  async runLayout({ adapter, dataset }) {
    const context = await prepareRun(adapter, dataset);
    const node = dataset.nodes[0];
    await runNodeAttempt({
      adapter,
      dataset,
      node,
      state: context.states.get(node.nodeId),
      invocationId: dataset.invocationId,
      attemptNo: 1,
      skipTerminalState: true,
    });
    const reconciliation = await adapter.reconcile(dataset);
    const release = await adapter.releaseNetworkLock(context.lock);
    return {
      passed:
        reconciliation.detected === 1 &&
        reconciliation.repaired.length === 1 &&
        !reconciliation.failClosed &&
        release.released,
      injectionPoint:
        "after terminal Attempt update, before terminal Node State update",
      stateBeforeReconciliation: "RUNNING",
      attemptBeforeReconciliation: "SUCCESS",
      reconciliation,
      release,
    };
  },
};

export async function runReconciliation(options = {}) {
  return executeComparison({ ...configuration, ...options });
}

runScenarioMain(import.meta.url, configuration);
