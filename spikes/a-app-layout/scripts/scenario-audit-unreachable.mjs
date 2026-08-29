import { summarizeError } from "../../lib/kintone.mjs";
import {
  executeComparison,
  prepareRun,
  runScenarioMain,
} from "./scenario-support.mjs";

const configuration = {
  scenario: "audit-unreachable",
  measurementIds: ["A-06"],
  adapterOptions: { "2app": { auditFailureAt: 2 } },
  async runLayout({ adapter, dataset, layoutName }) {
    if (layoutName === "1app") {
      return {
        passed: true,
        applicable: false,
        skippedReason: "監査アプリ分離障害は2アプリ案だけに適用する",
      };
    }
    const context = await prepareRun(adapter, dataset);
    const node = dataset.nodes[0];
    let attemptWrite;
    let sqlStarted = false;
    try {
      await adapter.insertAttempt({
        dataset,
        node,
        invocationId: dataset.invocationId,
        attemptNo: 1,
      });
      attemptWrite = { failed: false };
      sqlStarted = true;
    } catch (error) {
      attemptWrite = { failed: true, error: summarizeError(error) };
    }
    const release = await adapter.releaseNetworkLock(context.lock);
    return {
      passed:
        attemptWrite.failed &&
        !sqlStarted &&
        /INJECTED_AUDIT_UNREACHABLE/.test(attemptWrite.error.message),
      applicable: true,
      injection: {
        kind: "fetch-wrapper",
        failFromAuditCall: 2,
        explicitlySynthetic: true,
        note: "障害注入であり、kintone実挙動の観測ではない",
      },
      attemptWrite,
      sqlStarted,
      failClosed: !sqlStarted,
      release,
    };
  },
};

export async function runAuditUnreachable(options = {}) {
  return executeComparison({ ...configuration, ...options });
}

runScenarioMain(import.meta.url, configuration);
