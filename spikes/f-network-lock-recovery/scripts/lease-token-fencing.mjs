import { randomUUID } from "node:crypto";

import {
  field,
  insertRecord,
  summarizeError,
  updateRecord,
} from "../../lib/kintone.mjs";
import {
  createNetworkLockAdapter,
  DEFAULT_LEASE_SECONDS,
  makeLockIdentity,
} from "./network-lock-adapter.mjs";
import { runSpikeMain } from "./script-support.mjs";

export async function runLeaseTokenFencing({
  config,
  fetchImplementation = globalThis.fetch,
}) {
  const adapter = createNetworkLockAdapter({ config, fetchImplementation });
  const oldOwner = await adapter.acquire({
    identity: makeLockIdentity("fencing-a"),
    leaseSeconds: DEFAULT_LEASE_SECONDS,
  });
  const state = await insertRecord(adapter.execution, config.execution.app, {
    record_key: field(`STATE:${oldOwner.nonce}`),
    record_type: field("NODE_STATE"),
    run_id: field(`f-fencing-${oldOwner.nonce}`),
    node_state_key: field(`S1:${oldOwner.nonce}`),
    node_state_id: field(`state-${oldOwner.nonce}`),
    node_id: field("node-1"),
    job_id: field("spike-f-job"),
    status: field("RUNNING"),
    latest_attempt_no: field(1),
    idempotent: field("true"),
    trigger_rule: field("all_success"),
    blocked_by: field("[]"),
    revision: field(1),
    updated_at: field(new Date().toISOString()),
  });
  const newLeaseToken = randomUUID();
  const reclaim = await updateRecord(
    adapter.execution,
    config.execution.app,
    oldOwner.id,
    oldOwner.revision,
    {
      owner_invocation_id: field("fencing-owner-b"),
      lease_token: field(newLeaseToken),
      heartbeat_at: field(new Date().toISOString()),
      lease_expires_at: field(new Date(Date.now() + 6000).toISOString()),
      revision: field(oldOwner.businessRevision + 1),
    },
  );
  const newOwner = {
    ...oldOwner,
    ownerInvocationId: "fencing-owner-b",
    leaseToken: newLeaseToken,
    revision: String(reclaim.revision),
    businessRevision: oldOwner.businessRevision + 1,
  };
  let tokenCheck;
  try {
    await adapter.heartbeat(oldOwner);
    tokenCheck = { rejected: false };
  } catch (error) {
    tokenCheck = {
      rejected: true,
      code: error.code ?? null,
      safeError: summarizeError(error),
    };
  }
  await updateRecord(
    adapter.execution,
    config.execution.app,
    state.id,
    state.revision,
    {
      status: field("BLOCKED"),
      status_reason: field("new owner fenced old owner"),
      revision: field(2),
      updated_at: field(new Date().toISOString()),
    },
  );
  let revisionCheck;
  try {
    await updateRecord(
      adapter.execution,
      config.execution.app,
      state.id,
      state.revision,
      {
        status: field("SUCCESS"),
        status_reason: field("old owner must not persist this result"),
        revision: field(2),
        updated_at: field(new Date().toISOString()),
      },
    );
    revisionCheck = { rejected: false };
  } catch (error) {
    revisionCheck = {
      rejected: true,
      status: error.status ?? null,
      code: error.code ?? null,
      safeError: summarizeError(error),
    };
  }
  const release = await adapter.release(newOwner);
  const passed =
    tokenCheck.rejected &&
    tokenCheck.code === "LEASE_TOKEN_MISMATCH" &&
    revisionCheck.rejected &&
    revisionCheck.status === 409;
  return {
    scenario: "lease-token-fencing",
    measurementIds: ["F-07", "F-08"],
    ownerTransition: {
      from: oldOwner.ownerInvocationId,
      to: newOwner.ownerInvocationId,
    },
    oldOwnerRejections: {
      heartbeatRegetLeaseIdentityCheck: tokenCheck,
      nodeStateRevision409: revisionCheck,
    },
    nextNodeAllowedForOldOwner: false,
    stateUpdateAllowedForOldOwner: false,
    release,
    measurements: adapter.measurements(),
    passed,
  };
}

runSpikeMain(import.meta.url, ["F-07", "F-08"], ({ config }) =>
  runLeaseTokenFencing({ config }),
);
