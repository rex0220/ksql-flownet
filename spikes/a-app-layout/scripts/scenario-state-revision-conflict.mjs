import { summarizeError } from "../../lib/kintone.mjs";
import {
  executeComparison,
  prepareRun,
  runScenarioMain,
} from "./scenario-support.mjs";
import { nodeStateQuery } from "./layout-adapter.mjs";

const configuration = {
  scenario: "state-revision-conflict",
  measurementIds: ["A-05"],
  async runLayout({ adapter, dataset }) {
    const context = await prepareRun(adapter, dataset);
    const node = dataset.nodes[0];
    const state = context.states.get(node.nodeId);
    const staleRevision = state.revision;
    await adapter.upsertNodeState({
      dataset,
      node,
      reference: state,
      values: { status: "RUNNING", updated_at: dataset.now() },
    });
    let conflict;
    try {
      await adapter.upsertNodeState({
        dataset,
        node,
        reference: state,
        revision: staleRevision,
        values: { status: "FAILED", updated_at: dataset.now() },
      });
      conflict = { observed: false, status: 200 };
    } catch (error) {
      conflict = { observed: error.status === 409, ...summarizeError(error) };
    }
    const records = await adapter.query(
      "execution",
      nodeStateQuery(dataset.runId, node.nodeId),
    );
    const reget = {
      count: records.length,
      status: records[0]?.status?.value ?? null,
      revision: records[0]?.$revision?.value ?? null,
    };
    const release = await adapter.releaseNetworkLock(context.lock);
    return {
      passed:
        conflict.observed &&
        reget.count === 1 &&
        reget.status === "RUNNING" &&
        release.released,
      staleRevision,
      conflict,
      reget,
      verdict: conflict.observed
        ? "FAIL_CLOSED_AFTER_REGET"
        : "UNEXPECTED_UPDATE",
      release,
    };
  },
};

export async function runStateRevisionConflict(options = {}) {
  return executeComparison({ ...configuration, ...options });
}

runScenarioMain(import.meta.url, configuration);
