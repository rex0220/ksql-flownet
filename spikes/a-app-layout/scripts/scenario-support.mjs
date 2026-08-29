import { performance } from "node:perf_hooks";

import { summarizeError } from "../../lib/kintone.mjs";
import { isMain, makeRunMetadata, writeResult } from "../../lib/runtime.mjs";
import { createDataset } from "./dataset.mjs";
import { requireSpikeAEnvironment, secretValues } from "./environment.mjs";
import { createLayoutAdapter } from "./layout-adapter.mjs";

export async function runNodeAttempt({
  adapter,
  dataset,
  node,
  state,
  invocationId,
  attemptNo,
  outcome = "SUCCESS",
  skipTerminalState = false,
}) {
  const attempt = await adapter.insertAttempt({
    dataset,
    node,
    invocationId,
    attemptNo,
  });
  await adapter.upsertNodeState({
    dataset,
    node,
    reference: state,
    values: {
      status: "RUNNING",
      latest_attempt_no: attemptNo,
      active_attempt_id: attempt.attemptId,
      started_at: dataset.now(),
      finished_at: "",
      status_reason: "",
      updated_at: dataset.now(),
    },
  });
  await adapter.markAttemptExecutionStarted(attempt, dataset);
  await adapter.finalizeAttempt(
    attempt,
    dataset,
    outcome,
    outcome === "SUCCESS" ? "OK" : "API_ERROR",
  );
  if (!skipTerminalState) {
    await adapter.upsertNodeState({
      dataset,
      node,
      reference: state,
      values: {
        status: outcome,
        latest_attempt_no: attemptNo,
        active_attempt_id: "",
        finished_at: dataset.now(),
        status_reason: outcome === "FAILED" ? "injected node failure" : "",
        updated_at: dataset.now(),
      },
    });
  }
  return attempt;
}

export async function blockNode(adapter, dataset, node, state, blockedBy) {
  await adapter.upsertNodeState({
    dataset,
    node,
    reference: state,
    values: {
      status: "BLOCKED",
      blocked_by: blockedBy,
      status_reason: "upstream dependency failed",
      updated_at: dataset.now(),
    },
  });
}

export async function prepareRun(adapter, dataset) {
  const lock = await adapter.acquireNetworkLock(dataset, dataset.invocationId);
  const created = await adapter.createRun(dataset);
  return { lock, ...created };
}

export async function runMidFailureState(adapter, dataset) {
  const context = await prepareRun(adapter, dataset);
  const [node1, node2, node3] = dataset.nodes;
  await runNodeAttempt({
    adapter,
    dataset,
    node: node1,
    state: context.states.get(node1.nodeId),
    invocationId: dataset.invocationId,
    attemptNo: 1,
  });
  await runNodeAttempt({
    adapter,
    dataset,
    node: node2,
    state: context.states.get(node2.nodeId),
    invocationId: dataset.invocationId,
    attemptNo: 1,
    outcome: "FAILED",
  });
  await blockNode(adapter, dataset, node3, context.states.get(node3.nodeId), [
    node2.nodeId,
  ]);
  await adapter.updateRunAggregate(context.run, dataset, "FAILED");
  await adapter.finalizeInvocation(
    context.invocation,
    dataset,
    "FAILED",
    "NODE_FAILED",
  );
  return context;
}

export async function executeComparison({
  scenario,
  measurementIds,
  runLayout,
  adapterOptions = {},
  environment = process.env,
  fetchImplementation = globalThis.fetch,
}) {
  const config = requireSpikeAEnvironment(environment);
  const datasetTemplate = createDataset(scenario);
  const layouts = {};

  for (const layoutName of ["1app", "2app"]) {
    // 同じnonceから時計を含むdatasetを作り直し、両layoutへ同じ値を渡す。
    const dataset = createDataset(scenario, datasetTemplate.nonce);
    const adapter = createLayoutAdapter({
      layoutName,
      config,
      fetchImplementation,
      ...adapterOptions[layoutName],
    });
    const started = performance.now();
    let outcome;
    try {
      outcome = await runLayout({ adapter, dataset, layoutName });
    } catch (error) {
      outcome = { passed: false, error: summarizeError(error) };
    }
    const durationMs = performance.now() - started;
    const measurement = adapter.measurements();
    const cleanup = await adapter.cleanup();
    layouts[layoutName] = {
      ...outcome,
      durationMs,
      ...measurement,
      operationLog: adapter.operationLog,
      findings: adapter.findings,
      cleanup,
    };
  }

  return {
    ...makeRunMetadata(measurementIds),
    scenario,
    dataset: {
      runId: datasetTemplate.runId,
      networkId: datasetTemplate.networkId,
      businessKey: datasetTemplate.businessKey,
      nodeOrder: datasetTemplate.nodes.map((node) => node.nodeId),
    },
    layouts,
    passed: Object.values(layouts).every(
      (layout) => layout.passed && layout.cleanup.residualIds.length === 0,
    ),
  };
}

export function runScenarioMain(importMetaUrl, options) {
  if (!isMain(importMetaUrl)) return;
  executeComparison(options)
    .then(async (result) => {
      const config = requireSpikeAEnvironment(
        options.environment ?? process.env,
      );
      const path = await writeResult(
        importMetaUrl,
        result,
        secretValues(config),
      );
      console.log(`測定結果を保存しました: ${path}`);
      for (const [layout, value] of Object.entries(result.layouts)) {
        if (value.cleanup.residualIds.length > 0) {
          console.warn(
            `${layout}: 清掃失敗。残置ID: ${value.cleanup.residualIds.map((item) => item.id).join(", ")}`,
          );
        }
      }
      if (!result.passed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
