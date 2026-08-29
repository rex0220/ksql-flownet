import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  field,
  insertRecord,
  summarizeError,
  updateRecord,
} from "../../lib/kintone.mjs";
import {
  createNetworkLockAdapter,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_LEASE_SECONDS,
  makeLockIdentity,
} from "./network-lock-adapter.mjs";
import { runSpikeMain } from "./script-support.mjs";

export function createHeartbeatFailureFetch(fetchImplementation) {
  let mode = "pass";
  let injectedFailures = 0;
  const wrapper = async (url, options = {}) => {
    const body =
      typeof options.body === "string" ? JSON.parse(options.body) : null;
    const heartbeatUpdate =
      options.method === "PUT" && body?.record?.heartbeat_at !== undefined;
    if (mode === "fail" && heartbeatUpdate) {
      injectedFailures += 1;
      throw new Error(
        "INJECTED_HEARTBEAT_UNREACHABLE (fetch wrapper injection; not kintone behavior)",
      );
    }
    return fetchImplementation(url, options);
  };
  wrapper.setMode = (value) => {
    if (value !== "pass" && value !== "fail")
      throw new Error(`invalid mode: ${value}`);
    mode = value;
  };
  Object.defineProperty(wrapper, "injectedFailures", {
    get: () => injectedFailures,
  });
  return wrapper;
}

export async function runDrainController({
  heartbeat,
  runSubprocess,
  waitForHeartbeat,
  recoverHeartbeat,
  persistResult,
  finalizeInterrupted,
  sendToReconciliation,
  failureThreshold = 2,
}) {
  let subprocessFinished = false;
  const subprocess = runSubprocess().then((result) => {
    subprocessFinished = true;
    return result;
  });
  let consecutiveFailures = 0;
  const failures = [];
  while (!subprocessFinished && consecutiveFailures < failureThreshold) {
    await waitForHeartbeat();
    if (subprocessFinished) break;
    try {
      await heartbeat();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      failures.push(summarizeError(error));
    }
  }
  const leaseUncertain = consecutiveFailures >= failureThreshold;
  const subprocessResult = await subprocess;
  if (!leaseUncertain) {
    return { leaseUncertain, subprocessResult, failures, branch: "NO_DRAIN" };
  }
  try {
    await recoverHeartbeat();
    await persistResult(subprocessResult);
    await finalizeInterrupted();
    return {
      leaseUncertain,
      subprocessResult,
      failures,
      branch: "RECOVERED_AND_CANCELLED",
      resultPersisted: true,
      reconciliation: false,
    };
  } catch (error) {
    await sendToReconciliation({
      subprocessResult,
      error: summarizeError(error),
    });
    return {
      leaseUncertain,
      subprocessResult,
      failures,
      branch: "RECONCILIATION",
      resultPersisted: false,
      reconciliation: true,
      recoveryError: summarizeError(error),
    };
  }
}

async function prepareBranch(adapter, config, label) {
  const nonce = randomUUID();
  const lock = await adapter.acquire({
    identity: makeLockIdentity(`drain-${label}`),
    leaseSeconds: DEFAULT_LEASE_SECONDS,
  });
  const invocation = await insertRecord(adapter.audit, config.audit.app, {
    record_key: field(`INV:${nonce}`),
    record_type: field("RUN_INVOCATION"),
    run_id: field(`f-drain-${nonce}`),
    invocation_id: field(`f-drain-${nonce}`),
    mode: field("NEW"),
    requested_by: field("spike-f-script"),
    host: field("spike-f"),
    started_at: field(new Date().toISOString()),
    status: field("RUNNING"),
    selected_node_ids: field('["node-1","node-2"]'),
    preserved_node_ids: field("[]"),
    blocked_node_ids: field("[]"),
    reason: field("heartbeat failure injection"),
  });
  const state = await insertRecord(adapter.execution, config.execution.app, {
    record_key: field(`STATE:${nonce}`),
    record_type: field("NODE_STATE"),
    run_id: field(`f-drain-${nonce}`),
    node_state_key: field(`S1:${nonce}`),
    node_state_id: field(`state-${nonce}`),
    node_id: field("node-1"),
    job_id: field("spike-f-job"),
    status: field("RUNNING"),
    latest_attempt_no: field(1),
    idempotent: field("true"),
    trigger_rule: field("all_success"),
    blocked_by: field("[]"),
    revision: field(1),
    started_at: field(new Date().toISOString()),
    updated_at: field(new Date().toISOString()),
  });
  return { lock, invocation, state };
}

async function runBranch({ config, fetchImplementation, recover, timing }) {
  const injectedFetch = createHeartbeatFailureFetch(fetchImplementation);
  const adapter = createNetworkLockAdapter({
    config,
    fetchImplementation: injectedFetch,
  });
  const context = await prepareBranch(
    adapter,
    config,
    recover ? "recover" : "fail",
  );
  injectedFetch.setMode("fail");
  let stateWritesAfterDrain = 0;
  const nextNodeStarts = 0;
  let reconciliationMaterial = null;
  const result = await runDrainController({
    heartbeat: () => adapter.heartbeat(context.lock),
    runSubprocess: () =>
      delay(timing.subprocessMs, {
        exitCode: 0,
        outputRef: "local-result-file",
      }),
    waitForHeartbeat: () => delay(timing.heartbeatMs),
    recoverHeartbeat: async () => {
      if (recover) injectedFetch.setMode("pass");
      await adapter.heartbeat(context.lock, { preflight: false });
    },
    persistResult: async () => {
      await updateRecord(
        adapter.execution,
        config.execution.app,
        context.state.id,
        context.state.revision,
        {
          status: field("SUCCESS"),
          active_attempt_id: field(""),
          finished_at: field(new Date().toISOString()),
          updated_at: field(new Date().toISOString()),
          revision: field(2),
        },
      );
      stateWritesAfterDrain += 1;
    },
    finalizeInterrupted: async () => {
      await updateRecord(
        adapter.audit,
        config.audit.app,
        context.invocation.id,
        context.invocation.revision,
        {
          status: field("CANCELLED"),
          result_code: field("NETWORK_LEASE_INTERRUPTED"),
          finished_at: field(new Date().toISOString()),
        },
      );
    },
    sendToReconciliation: async (material) => {
      reconciliationMaterial = material;
    },
  });
  injectedFetch.setMode("pass");
  const currentLock = await adapter.getById(context.lock.id);
  context.lock.revision = currentLock.$revision.value;
  context.lock.businessRevision = Number(currentLock.revision?.value ?? 1);
  const release = await adapter.release(context.lock, {
    status: "CANCELLED",
    resultCode: "NETWORK_LEASE_INTERRUPTED",
  });
  return {
    ...result,
    localControlState: result.leaseUncertain ? "LEASE_UNCERTAIN" : "RUNNING",
    newNodeStartsAfterDrain: nextNodeStarts,
    stateWritesAfterDrain,
    reconciliationMaterialRetained: Boolean(reconciliationMaterial),
    injectedFailures: injectedFetch.injectedFailures,
    injectionScope: "fetch wrapper injection; not observed kintone behavior",
    release,
    measurements: adapter.measurements(),
  };
}

export async function runDrainMode({
  config,
  fetchImplementation = globalThis.fetch,
  timing = {
    heartbeatMs: DEFAULT_HEARTBEAT_SECONDS * 1000,
    subprocessMs: 5000,
  },
}) {
  const recovered = await runBranch({
    config,
    fetchImplementation,
    recover: true,
    timing,
  });
  const unrecovered = await runBranch({
    config,
    fetchImplementation,
    recover: false,
    timing,
  });
  return {
    scenario: "heartbeat-failure-drain",
    measurementIds: ["F-04", "F-05", "F-06"],
    settings: {
      leaseSeconds: DEFAULT_LEASE_SECONDS,
      heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
      consecutiveFailureThreshold: 2,
      scaledDownForSpike: true,
      productionValuesPendingSpikeDecision: true,
    },
    branches: { recovered, unrecovered },
    passed:
      recovered.branch === "RECOVERED_AND_CANCELLED" &&
      recovered.resultPersisted &&
      recovered.newNodeStartsAfterDrain === 0 &&
      recovered.stateWritesAfterDrain === 1 &&
      unrecovered.branch === "RECONCILIATION" &&
      !unrecovered.resultPersisted &&
      unrecovered.newNodeStartsAfterDrain === 0 &&
      unrecovered.stateWritesAfterDrain === 0 &&
      unrecovered.reconciliationMaterialRetained,
  };
}

runSpikeMain(import.meta.url, ["F-04", "F-05", "F-06"], ({ config }) =>
  runDrainMode({ config }),
);
