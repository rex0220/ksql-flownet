import assert from "node:assert/strict";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import {
  LeaseMonitor,
  NetworkLockManager,
} from "../../dist/persistence/network-lock.js";
import {
  createRepository,
  getRecordByKey,
  getRecords,
  makeState,
  runIntegration,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-heartbeat-drain",
  async ({ config, scope }) => {
    let injectHeartbeatFailure = false;
    const injectedCalls = [];
    const injectedFetch = async (input, init = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      const heartbeat =
        init.method === "PUT" &&
        body?.record?.heartbeat_at !== undefined &&
        body?.record?.record_key === undefined;
      if (heartbeat && injectHeartbeatFailure) {
        injectedCalls.push({ method: "PUT", injected: true });
        throw new TypeError("ITEST injected heartbeat transport failure");
      }
      return globalThis.fetch(input, init);
    };
    const repository = createRepository(config);

    async function acquire(suffix) {
      const manager = new NetworkLockManager({
        baseUrl: config.baseUrl,
        appId: config.stateAppId,
        apiToken: config.stateApiToken,
        profile: `${scope}_profile`,
        networkId: `${scope}_${suffix}_network`,
        ownerInvocationId: `${scope}_${suffix}_owner`,
        ownerInstanceId: `${scope}_${suffix}_instance`,
        leaseDurationSec: 30,
        fetch: injectedFetch,
      });
      return { manager, reference: await manager.acquire() };
    }

    function monitor(manager, reference) {
      return new LeaseMonitor(manager, reference, {
        leaseDurationSec: 30,
        heartbeatIntervalSec: 5,
        consecutiveFailureThreshold: 2,
        remainingLeaseSafetySec: 5,
      });
    }

    const successCase = await acquire("success");
    const successMonitor = monitor(successCase.manager, successCase.reference);
    let finishWork;
    const inFlightWork = new Promise((resolve) => {
      finishWork = resolve;
    });
    injectHeartbeatFailure = true;
    assert.equal(await successMonitor.tick(), false);
    assert.equal(await successMonitor.tick(), false);
    assert.equal(successMonitor.currentState, "LEASE_UNCERTAIN");
    assert.equal(successMonitor.canStartNewNode(), false);
    assert.equal(successMonitor.canPersistResults(), false);
    finishWork({ completed: true });
    const workResult = await inFlightWork;
    injectHeartbeatFailure = false;
    assert.equal(await successMonitor.confirmLeaseForFinalWrite(), true);
    assert.equal(successMonitor.canPersistResults(), true);
    const successRunId = `${scope}_success_write`;
    const successNodeId = `${successRunId}_node`;
    if (successMonitor.canPersistResults()) {
      await repository.upsertNodeState({
        value: makeState(
          successRunId,
          nodeStateKey(successRunId, successNodeId),
          {
            node_id: successNodeId,
            status_reason: `${scope}_confirmed_final_write`,
          },
        ),
        expected_revision: null,
      });
    }
    const successWrites = await getRecords(
      config,
      "state",
      `record_type in ("NODE_STATE") and run_id in ("${successRunId}")`,
    );
    assert.equal(successWrites.length, 1);
    const confirmedLock = await getRecordByKey(
      config,
      "state",
      successCase.reference.originalRecordKey,
    );
    await successCase.manager.release(successCase.reference, "SUCCESS", scope);

    const failureCase = await acquire("failure");
    const failureMonitor = monitor(failureCase.manager, failureCase.reference);
    const beforeFailure = await getRecordByKey(
      config,
      "state",
      failureCase.reference.originalRecordKey,
    );
    injectHeartbeatFailure = true;
    assert.equal(await failureMonitor.tick(), false);
    assert.equal(await failureMonitor.tick(), false);
    assert.equal(failureMonitor.canStartNewNode(), false);
    assert.equal(await failureMonitor.confirmLeaseForFinalWrite(), false);
    assert.equal(failureMonitor.canPersistResults(), false);
    const failureRunId = `${scope}_failure_write`;
    const failureWrites = await getRecords(
      config,
      "state",
      `record_type in ("NODE_STATE") and run_id in ("${failureRunId}")`,
    );
    assert.equal(failureWrites.length, 0);
    const afterFailure = await getRecordByKey(
      config,
      "state",
      failureCase.reference.originalRecordKey,
    );
    assert.equal(afterFailure.$revision.value, beforeFailure.$revision.value);
    assert.equal(
      afterFailure.heartbeat_at.value,
      beforeFailure.heartbeat_at.value,
    );
    injectHeartbeatFailure = false;
    await failureCase.manager.release(failureCase.reference, "SUCCESS", scope);

    return {
      successfulRecovery: {
        state: successMonitor.currentState,
        canStartNewNode: successMonitor.canStartNewNode(),
        canPersistResults: successMonitor.canPersistResults(),
        inFlightWork: workResult,
        finalWriteCount: successWrites.length,
        lockRevisionAfterConfirmation: confirmedLock.$revision.value,
      },
      failedRecovery: {
        state: failureMonitor.currentState,
        canStartNewNode: failureMonitor.canStartNewNode(),
        canPersistResults: failureMonitor.canPersistResults(),
        finalWriteCount: failureWrites.length,
        lockRevisionBefore: beforeFailure.$revision.value,
        lockRevisionAfter: afterFailure.$revision.value,
      },
      injectedHeartbeatFailures: injectedCalls.length,
    };
  },
);
