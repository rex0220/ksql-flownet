import assert from "node:assert/strict";

import {
  NetworkLockError,
  NetworkLockManager,
} from "../../dist/persistence/network-lock.js";
import {
  assertObserved,
  createObservedFetch,
  getRecordByKey,
  runIntegration,
  summarizeError,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-lease-heartbeat",
  async ({ config, scope }) => {
    const observations = [];
    const observedFetch = createObservedFetch(observations);
    const common = {
      baseUrl: config.baseUrl,
      appId: config.stateAppId,
      apiToken: config.stateApiToken,
      profile: `${scope}_profile`,
      networkId: `${scope}_network`,
      leaseDurationSec: 6,
      fetch: observedFetch,
    };
    const firstManager = new NetworkLockManager({
      ...common,
      ownerInvocationId: `${scope}_owner_a`,
      ownerInstanceId: `${scope}_instance_a`,
    });
    const reference = await firstManager.acquire();
    const staleReference = globalThis.structuredClone(reference);
    const heartbeats = [];
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1100));
      await firstManager.heartbeat(reference);
      heartbeats.push({
        revision: reference.revision,
        heartbeatAt: reference.heartbeatAt,
        leaseExpiresAt: reference.leaseExpiresAt,
      });
    }
    assert.deepEqual(
      heartbeats.map(({ revision }) => revision),
      [2, 3, 4],
    );
    const firstRelease = await firstManager.release(
      reference,
      "SUCCESS",
      scope,
    );
    const secondManager = new NetworkLockManager({
      ...common,
      ownerInvocationId: `${scope}_owner_b`,
      ownerInstanceId: `${scope}_instance_b`,
    });
    const secondReference = await secondManager.acquire();
    let staleCause;
    try {
      await firstManager.heartbeat(staleReference);
    } catch (error) {
      staleCause = error;
    }
    const staleError = summarizeError(staleCause);
    assertObserved(
      staleCause instanceof NetworkLockError &&
        staleCause.code === "LEASE_TOKEN_MISMATCH",
      { name: "NetworkLockError", code: "LEASE_TOKEN_MISMATCH" },
      staleError,
      "旧lease_tokenのheartbeat拒否結果が不正です",
    );
    const liveRecord = await getRecordByKey(
      config,
      "state",
      secondReference.originalRecordKey,
    );
    assert.equal(liveRecord.lease_token.value, secondReference.leaseToken);
    assert.notEqual(liveRecord.lease_token.value, staleReference.leaseToken);
    const secondRelease = await secondManager.release(
      secondReference,
      "SUCCESS",
      scope,
    );
    assertObserved(
      firstRelease.recordKey.length <= 64,
      { maxLength: 64 },
      { value: firstRelease.recordKey, length: firstRelease.recordKey.length },
      "1回目のrelease record_keyが長すぎます",
    );
    assertObserved(
      secondRelease.recordKey.length <= 64,
      { maxLength: 64 },
      {
        value: secondRelease.recordKey,
        length: secondRelease.recordKey.length,
      },
      "2回目のrelease record_keyが長すぎます",
    );
    return {
      heartbeats,
      staleLeaseRejection: staleError,
      firstTombstone: firstRelease.recordKey,
      secondTombstone: secondRelease.recordKey,
      liveOwnerBeforeRelease: liveRecord.owner_invocation_id.value,
      observations: observations.filter(({ status }) => status >= 400),
    };
  },
);
