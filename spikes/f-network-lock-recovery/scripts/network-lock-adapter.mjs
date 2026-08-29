import { createHash, randomUUID } from "node:crypto";

import {
  createKintoneClient,
  field,
  getRecordsByKey,
  insertRecord,
  summarizeError,
  updateRecord,
} from "../../lib/kintone.mjs";

export const DEFAULT_LEASE_SECONDS = 6;
export const DEFAULT_HEARTBEAT_SECONDS = 2;

export function validateLeaseSettings(leaseSeconds, heartbeatSeconds) {
  for (const [name, value] of [
    ["leaseSeconds", leaseSeconds],
    ["heartbeatSeconds", heartbeatSeconds],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} は正の整数で指定してください。`);
    }
  }
  if (heartbeatSeconds >= leaseSeconds) {
    throw new Error("heartbeat間隔はlease期間未満でなければなりません。");
  }
  if (heartbeatSeconds > leaseSeconds / 3) {
    throw new Error("heartbeat間隔はlease期間の1/3以下でなければなりません。");
  }
  return { leaseSeconds, heartbeatSeconds };
}

export function isStaleCandidate(record, observedAt = new Date()) {
  const heartbeatAt = Date.parse(record?.heartbeat_at?.value ?? "");
  const leaseExpiresAt = Date.parse(record?.lease_expires_at?.value ?? "");
  const observed =
    observedAt instanceof Date ? observedAt.getTime() : Date.parse(observedAt);
  return {
    staleCandidate:
      Number.isFinite(observed) &&
      Number.isFinite(heartbeatAt) &&
      Number.isFinite(leaseExpiresAt) &&
      observed > leaseExpiresAt,
    heartbeatAgeMs:
      Number.isFinite(observed) && Number.isFinite(heartbeatAt)
        ? observed - heartbeatAt
        : null,
    leaseExpired: Number.isFinite(observed) && observed > leaseExpiresAt,
    ownerStopped: false,
    reclaimAllowed: false,
    reason: "lease期限超過はstale候補であり、旧ownerの停止証明ではない",
  };
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("base64url");
}

export function makeLockIdentity(label = "network") {
  const nonce = randomUUID();
  const lockKey = `N1:spike-f:${digest(`${label}:${nonce}`)}`;
  return {
    nonce,
    lockKey,
    recordKey: `LOCK:${digest(lockKey)}`,
    ownerInvocationId: `f-${label}-${nonce}`,
  };
}

export function releaseTombstones(identity) {
  const suffix = digest(`${identity.recordKey}:${identity.ownerInvocationId}`);
  return {
    recordKey: `LOCKDONE:${suffix}`,
    lockKey: `N1:DONE:${suffix}`,
  };
}

function measurement(client) {
  return {
    apiCalls: client.apiCalls,
    payload: {
      ...client.payloadTotals,
      breakdown: client.payloadMeasurements,
    },
  };
}

export function createNetworkLockAdapter({
  config,
  fetchImplementation = globalThis.fetch,
  now = () => new Date(),
}) {
  const execution = createKintoneClient(
    { baseUrl: config.baseUrl, ...config.execution },
    fetchImplementation,
  );
  const audit = createKintoneClient(
    { baseUrl: config.baseUrl, ...config.audit },
    fetchImplementation,
  );

  async function acquire({
    identity,
    leaseSeconds,
    ownerInstanceId = "local-spike",
  }) {
    validateLeaseSettings(leaseSeconds, Math.floor(leaseSeconds / 3));
    const acquiredAt = now();
    const leaseToken = randomUUID();
    const response = await insertRecord(execution, config.execution.app, {
      record_key: field(identity.recordKey),
      record_type: field("NETWORK_LOCK"),
      lock_key: field(identity.lockKey),
      profile: field("spike-f"),
      owner_invocation_id: field(identity.ownerInvocationId),
      lease_token: field(leaseToken),
      started_at: field(acquiredAt.toISOString()),
      heartbeat_at: field(acquiredAt.toISOString()),
      lease_expires_at: field(
        new Date(acquiredAt.getTime() + leaseSeconds * 1000).toISOString(),
      ),
      status: field("RUNNING"),
      revision: field(1),
      status_reason: field(`owner_instance_id=${ownerInstanceId}`),
    });
    return {
      ...identity,
      id: String(response.id),
      revision: String(response.revision),
      businessRevision: 1,
      leaseToken,
      leaseSeconds,
      ownerInstanceId,
    };
  }

  async function getByKey(recordKey) {
    const records = await getRecordsByKey(
      execution,
      config.execution.app,
      recordKey,
    );
    if (records.length !== 1) {
      throw new Error(
        `lockの一意な再取得に失敗しました（count=${records.length}）。`,
      );
    }
    return records[0];
  }

  async function getById(id) {
    const response = await execution.request("record", {
      query: { app: config.execution.app, id: String(id) },
    });
    return response.record;
  }

  async function heartbeat(reference, { preflight = true } = {}) {
    if (preflight) {
      const current = await getById(reference.id);
      if (current.lease_token?.value !== reference.leaseToken) {
        const error = new Error("LEASE_TOKEN_MISMATCH");
        error.code = "LEASE_TOKEN_MISMATCH";
        throw error;
      }
      if (String(current.$revision?.value) !== String(reference.revision)) {
        const error = new Error("LEASE_REVISION_MISMATCH");
        error.code = "LEASE_REVISION_MISMATCH";
        throw error;
      }
    }
    const heartbeatAt = now();
    const response = await updateRecord(
      execution,
      config.execution.app,
      reference.id,
      reference.revision,
      {
        heartbeat_at: field(heartbeatAt.toISOString()),
        lease_expires_at: field(
          new Date(
            heartbeatAt.getTime() + reference.leaseSeconds * 1000,
          ).toISOString(),
        ),
        revision: field(reference.businessRevision + 1),
      },
    );
    reference.revision = String(response.revision);
    reference.businessRevision += 1;
    return reference;
  }

  async function release(
    reference,
    { status = "SUCCESS", resultCode = "NORMAL" } = {},
  ) {
    const tombstones = releaseTombstones(reference);
    const response = await updateRecord(
      execution,
      config.execution.app,
      reference.id,
      reference.revision,
      {
        record_key: field(tombstones.recordKey),
        lock_key: field(tombstones.lockKey),
        owner_invocation_id: field(""),
        lease_token: field(""),
        status: field(status),
        status_reason: field(resultCode),
        finished_at: field(now().toISOString()),
        revision: field(reference.businessRevision + 1),
      },
    );
    reference.revision = String(response.revision);
    reference.businessRevision += 1;
    return {
      released: true,
      protocol: "unique-tombstone-update",
      ...tombstones,
    };
  }

  async function appendAudit(values) {
    const eventId = randomUUID();
    const response = await insertRecord(audit, config.audit.app, {
      record_key: field(`OP:${eventId}`),
      record_type: field("OPERATION_AUDIT"),
      result_code: field(values.eventType),
      reason: field(values.reason),
      evidence_ref: field(values.evidenceRef),
      service_principal: field(values.servicePrincipal),
      requested_by: field(values.confirmedBy),
      resolved_at: field(now().toISOString()),
    });
    return { id: String(response.id), revision: String(response.revision) };
  }

  function measurements() {
    const exec = measurement(execution);
    const aud = measurement(audit);
    return {
      control_plane_api_calls: exec.apiCalls + aud.apiCalls,
      execution: exec,
      audit: aud,
    };
  }

  return {
    acquire,
    appendAudit,
    execution,
    audit,
    getById,
    getByKey,
    heartbeat,
    measurements,
    release,
    executionApp: config.execution.app,
    summarizeError,
  };
}
