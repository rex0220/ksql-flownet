import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { field, validateUniqueKeyFields } from "../../lib/kintone.mjs";
import {
  createNetworkLockAdapter,
  DEFAULT_LEASE_SECONDS,
  isStaleCandidate,
  makeLockIdentity,
  releaseTombstones,
} from "./network-lock-adapter.mjs";
import { optionValue, runSpikeMain } from "./script-support.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requireReference(value, name) {
  if (typeof value !== "string" || value.trim().length < 3) {
    throw new Error(`${name} は空でない管理済み参照文字列で指定してください。`);
  }
  return value.trim();
}

export async function forceUnlockNetwork({
  adapter,
  reference,
  expectedOwnerInvocationId,
  expectedRevision,
  expectedLeaseToken,
  stopEvidenceRef,
  reason,
  servicePrincipal,
  confirmedBy,
  simulateResponseLoss = false,
}) {
  requireReference(stopEvidenceRef, "stopEvidenceRef");
  requireReference(reason, "reason");
  requireReference(servicePrincipal, "servicePrincipal");
  requireReference(confirmedBy, "confirmedBy");
  const current = await adapter.getById(reference.id);
  const stale = isStaleCandidate(current, new Date());
  const checks = {
    expectedOwner:
      current.owner_invocation_id?.value === expectedOwnerInvocationId,
    expectedRevision:
      String(current.$revision?.value) === String(expectedRevision),
    expectedLeaseIdentity: current.lease_token?.value === expectedLeaseToken,
    staleCandidate: stale.staleCandidate,
    stopEvidencePresent: true,
    noNewHeartbeatOrOwner:
      current.owner_invocation_id?.value === expectedOwnerInvocationId &&
      current.lease_token?.value === expectedLeaseToken,
  };
  if (!Object.values(checks).every(Boolean)) {
    return { released: false, failClosed: true, checks, auditWritten: false };
  }
  const tombstones = releaseTombstones(reference);
  const record = {
    record_key: field(tombstones.recordKey),
    lock_key: field(tombstones.lockKey),
    owner_invocation_id: field(""),
    lease_token: field(""),
    status: field("CANCELLED"),
    status_reason: field("NETWORK_LOCK_FORCE_RELEASED"),
    finished_at: field(new Date().toISOString()),
    revision: field(Number(current.revision?.value ?? 1) + 1),
  };
  validateUniqueKeyFields(record);
  const response = await adapter.execution.request("record", {
    method: "PUT",
    body: {
      app: adapter.executionApp,
      id: reference.id,
      revision: String(expectedRevision),
      record,
    },
    raw: simulateResponseLoss,
  });
  if (simulateResponseLoss) await response.body?.cancel();
  const adjudicated = await adapter.getById(reference.id);
  const releaseConfirmed =
    adjudicated.record_key?.value === tombstones.recordKey &&
    adjudicated.lock_key?.value === tombstones.lockKey &&
    adjudicated.status?.value === "CANCELLED";
  if (!releaseConfirmed) {
    return {
      released: false,
      failClosed: true,
      checks,
      responseLost: simulateResponseLoss,
      regetAdjudication: "NOT_CONFIRMED",
      auditWritten: false,
    };
  }
  const audit = await adapter.appendAudit({
    eventType: "NETWORK_LOCK_FORCE_RELEASED",
    reason: JSON.stringify({
      network: "spike-f",
      profile: "spike-f",
      previousOwner: expectedOwnerInvocationId,
      previousLeaseTokenSha256: sha256(expectedLeaseToken),
      previousRevision: String(expectedRevision),
      postReleaseRevision: adjudicated.$revision?.value,
      reason,
      stopConfirmationMethod: "operator-provided-evidence-reference",
    }),
    evidenceRef: stopEvidenceRef,
    servicePrincipal,
    confirmedBy,
  });
  return {
    released: true,
    failClosed: false,
    checks,
    responseLost: simulateResponseLoss,
    regetAdjudication: "RELEASE_CONFIRMED",
    auditWritten: true,
    audit,
    postReleaseRevision: adjudicated.$revision?.value,
  };
}

async function prepare(adapter, label) {
  return adapter.acquire({
    identity: makeLockIdentity(label),
    leaseSeconds: DEFAULT_LEASE_SECONDS,
  });
}

export async function runForceUnlockNetwork({
  config,
  fetchImplementation = globalThis.fetch,
  stopEvidenceRef,
  reason,
  servicePrincipal,
  confirmedBy,
  waitMilliseconds = (DEFAULT_LEASE_SECONDS + 1) * 1000,
}) {
  const adapter = createNetworkLockAdapter({ config, fetchImplementation });
  // forceUnlockNetworkのraw requestでもappを外から差し替えられないよう固定する。
  adapter.executionApp = config.execution.app;
  const valid = await prepare(adapter, "force-valid");
  const ownerMismatchLock = await prepare(adapter, "force-owner-mismatch");
  const revisionMismatchLock = await prepare(
    adapter,
    "force-revision-mismatch",
  );
  await delay(waitMilliseconds);
  const ownerMismatch = await forceUnlockNetwork({
    adapter,
    reference: ownerMismatchLock,
    expectedOwnerInvocationId: "unexpected-owner",
    expectedRevision: ownerMismatchLock.revision,
    expectedLeaseToken: ownerMismatchLock.leaseToken,
    stopEvidenceRef,
    reason,
    servicePrincipal,
    confirmedBy,
  });
  const revisionMismatch = await forceUnlockNetwork({
    adapter,
    reference: revisionMismatchLock,
    expectedOwnerInvocationId: revisionMismatchLock.ownerInvocationId,
    expectedRevision: String(Number(revisionMismatchLock.revision) + 1),
    expectedLeaseToken: revisionMismatchLock.leaseToken,
    stopEvidenceRef,
    reason,
    servicePrincipal,
    confirmedBy,
  });
  const responseLoss = await forceUnlockNetwork({
    adapter,
    reference: valid,
    expectedOwnerInvocationId: valid.ownerInvocationId,
    expectedRevision: valid.revision,
    expectedLeaseToken: valid.leaseToken,
    stopEvidenceRef,
    reason,
    servicePrincipal,
    confirmedBy,
    simulateResponseLoss: true,
  });
  await adapter.release(ownerMismatchLock, {
    status: "CANCELLED",
    resultCode: "SPIKE_OWNER_CLEANUP",
  });
  await adapter.release(revisionMismatchLock, {
    status: "CANCELLED",
    resultCode: "SPIKE_OWNER_CLEANUP",
  });
  return {
    scenario: "force-unlock-network-contract",
    measurementIds: ["F-16", "F-17"],
    cases: { ownerMismatch, revisionMismatch, responseLoss },
    measurements: adapter.measurements(),
    passed:
      ownerMismatch.failClosed &&
      !ownerMismatch.released &&
      revisionMismatch.failClosed &&
      !revisionMismatch.released &&
      responseLoss.released &&
      responseLoss.auditWritten &&
      responseLoss.regetAdjudication === "RELEASE_CONFIRMED",
  };
}

runSpikeMain(import.meta.url, ["F-16", "F-17"], ({ config, arguments_ }) =>
  runForceUnlockNetwork({
    config,
    stopEvidenceRef: optionValue(arguments_, "--stop-evidence-ref"),
    reason: optionValue(arguments_, "--reason"),
    servicePrincipal: optionValue(arguments_, "--service-principal"),
    confirmedBy: optionValue(arguments_, "--confirmed-by"),
  }),
);
