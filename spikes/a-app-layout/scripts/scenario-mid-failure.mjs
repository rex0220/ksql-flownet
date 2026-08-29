import {
  executeComparison,
  runMidFailureState,
  runScenarioMain,
} from "./scenario-support.mjs";

const configuration = {
  scenario: "mid-failure",
  measurementIds: ["A-02", "A-12"],
  async runLayout({ adapter, dataset }) {
    const context = await runMidFailureState(adapter, dataset);
    const release = await adapter.releaseNetworkLock(context.lock);
    return {
      passed: release.released,
      aggregateStatus: "FAILED",
      nodeStatuses: {
        extract: "SUCCESS",
        aggregate: "FAILED",
        send: "BLOCKED",
      },
      release,
    };
  },
};

export async function runMidFailure(options = {}) {
  return executeComparison({ ...configuration, ...options });
}

runScenarioMain(import.meta.url, configuration);
