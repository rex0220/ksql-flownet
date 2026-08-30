import { randomUUID } from "node:crypto";

import { networkLockKey } from "../domain/canonical-lock-key.js";
import type { NetworkLockForceReleaseOperationAudit } from "../domain/persistence-model.js";
import type { PersistenceRepository } from "./repository.js";
import {
  KintoneApiError,
  KintoneClient,
  KintoneTransportError,
  type KintoneFieldValue,
  type KintoneRecord,
} from "./kintone/client.js";
import { releaseTombstoneRecordKey } from "./network-lock.js";

export interface StopConfirmationInput {
  readonly profile: string;
  readonly networkId: string;
  readonly expectedOwnerInvocationId: string;
  readonly stopConfirmedBy: string;
  readonly stopMethod: string;
  readonly stopEvidenceRef: string;
}

export interface StopConfirmationResult {
  readonly confirmed: boolean;
  readonly method: string;
  readonly detail: string;
}

export interface StopConfirmation {
  confirm(input: StopConfirmationInput): Promise<StopConfirmationResult>;
}

export const manualStopConfirmation: StopConfirmation = {
  async confirm(input) {
    const confirmed =
      input.stopMethod === "manual" &&
      input.stopConfirmedBy.trim() !== "" &&
      input.stopEvidenceRef.trim() !== "";
    return {
      confirmed,
      method: "manual",
      detail: confirmed
        ? "manual stop evidence was provided"
        : "manual stop confirmation fields are invalid",
    };
  },
};

export function defaultStopConfirmations(): ReadonlyMap<
  string,
  StopConfirmation
> {
  return new Map([["manual", manualStopConfirmation]]);
}

export type NetworkLockRecoveryErrorCode =
  | "INVALID_ARGUMENT"
  | "LOCK_NOT_FOUND"
  | "LOCK_READ_FAILED"
  | "OWNER_MISMATCH"
  | "LEASE_STILL_ACTIVE"
  | "STOP_NOT_CONFIRMED"
  | "HEARTBEAT_ADVANCED"
  | "REVISION_CONFLICT"
  | "RELEASE_UNCONFIRMED"
  | "AUDIT_FAILED";

export class NetworkLockRecoveryError extends Error {
  readonly code: NetworkLockRecoveryErrorCode;
  readonly causeDetail: unknown;

  constructor(
    code: NetworkLockRecoveryErrorCode,
    message: string,
    causeDetail?: unknown,
  ) {
    super(message);
    this.name = "NetworkLockRecoveryError";
    this.code = code;
    this.causeDetail = causeDetail;
  }
}

export interface ForceUnlockNetworkInput {
  readonly networkId: string;
  readonly profile: string;
  readonly expectedOwnerInvocationId: string;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly stopConfirmedBy: string;
  readonly stopEvidenceRef: string;
  readonly stopMethod: string;
  readonly servicePrincipal: string;
  readonly requestedBy: string;
}

export interface NetworkLockRecoveryDependencies {
  readonly baseUrl: string;
  readonly stateAppId: number;
  readonly stateApiToken: string;
  readonly repository: PersistenceRepository;
  readonly fetch?: typeof fetch;
  readonly stopConfirmations?: ReadonlyMap<string, StopConfirmation>;
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

export interface ForceUnlockNetworkResult {
  readonly lockKey: string;
  readonly previousOwnerInvocationId: string;
  readonly postReleaseRevision: number;
  readonly audit: NetworkLockForceReleaseOperationAudit;
}

interface LockSnapshot {
  readonly record: KintoneRecord;
  readonly recordId: string;
  readonly revision: number;
  readonly businessRevision: number;
  readonly ownerInvocationId: string;
  readonly leaseToken: string;
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
}

const field = (value: unknown): KintoneFieldValue => ({ value });
const text = (record: KintoneRecord, code: string): string =>
  String(record[code]?.value ?? "");
const revisionOf = (record: KintoneRecord): number =>
  Number(record.$revision?.value);

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function snapshot(record: KintoneRecord): LockSnapshot {
  const result = {
    record,
    recordId: text(record, "$id"),
    revision: revisionOf(record),
    businessRevision: Number(record.revision?.value),
    ownerInvocationId: text(record, "owner_invocation_id"),
    leaseToken: text(record, "lease_token"),
    heartbeatAt: text(record, "heartbeat_at"),
    leaseExpiresAt: text(record, "lease_expires_at"),
  };
  if (
    result.recordId === "" ||
    !Number.isSafeInteger(result.revision) ||
    !Number.isSafeInteger(result.businessRevision) ||
    result.leaseToken === "" ||
    !Number.isFinite(Date.parse(result.leaseExpiresAt))
  ) {
    throw new NetworkLockRecoveryError(
      "LOCK_READ_FAILED",
      "network lock record is malformed",
    );
  }
  return result;
}

async function getRecords(
  client: KintoneClient,
  recordKey: string,
): Promise<KintoneRecord[]> {
  return client.getRecords(`record_key in (${quote(recordKey)})`);
}

async function getInitialLock(
  client: KintoneClient,
  recordKey: string,
): Promise<LockSnapshot> {
  let records: KintoneRecord[];
  try {
    records = await getRecords(client, recordKey);
  } catch (error) {
    throw new NetworkLockRecoveryError(
      "LOCK_READ_FAILED",
      "network lock read failed",
      error,
    );
  }
  if (records.length === 0) {
    throw new NetworkLockRecoveryError(
      "LOCK_NOT_FOUND",
      "network lock was not found",
    );
  }
  if (records.length !== 1) {
    throw new NetworkLockRecoveryError(
      "LOCK_READ_FAILED",
      `network lock read returned ${records.length} records`,
    );
  }
  return snapshot(records[0]!);
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim() === "") {
    throw new NetworkLockRecoveryError(
      "INVALID_ARGUMENT",
      `${name} must not be empty`,
    );
  }
}

function releaseConfirmed(
  record: KintoneRecord,
  initial: LockSnapshot,
  tombstone: string,
  releasedAt: string,
): boolean {
  return (
    text(record, "$id") === initial.recordId &&
    text(record, "record_key") === tombstone &&
    text(record, "lock_key") === "" &&
    text(record, "owner_invocation_id") === "" &&
    text(record, "lease_token") === "" &&
    text(record, "status") === "CANCELLED" &&
    text(record, "status_reason") === "NETWORK_LOCK_FORCE_RELEASED" &&
    text(record, "finished_at") === releasedAt &&
    revisionOf(record) === initial.revision + 1
  );
}

export async function forceUnlockNetwork(
  input: ForceUnlockNetworkInput,
  dependencies: NetworkLockRecoveryDependencies,
): Promise<ForceUnlockNetworkResult> {
  for (const [name, value] of Object.entries(input))
    requireNonEmpty(value, name);

  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const confirmations =
    dependencies.stopConfirmations ?? defaultStopConfirmations();
  const lockKey = networkLockKey(input.profile, input.networkId);
  const recordKey = `LOCK:${lockKey}`;
  const client = new KintoneClient({
    baseUrl: dependencies.baseUrl,
    appId: dependencies.stateAppId,
    apiToken: dependencies.stateApiToken,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  const initial = await getInitialLock(client, recordKey);

  if (initial.ownerInvocationId !== input.expectedOwnerInvocationId) {
    throw new NetworkLockRecoveryError(
      "OWNER_MISMATCH",
      "network lock owner does not match the expected invocation",
    );
  }
  if (Date.parse(initial.leaseExpiresAt) > now().getTime()) {
    throw new NetworkLockRecoveryError(
      "LEASE_STILL_ACTIVE",
      "network lock lease has not expired",
    );
  }

  const confirmation = confirmations.get(input.stopMethod);
  if (confirmation === undefined) {
    throw new NetworkLockRecoveryError(
      "STOP_NOT_CONFIRMED",
      `unknown stop confirmation method '${input.stopMethod}'`,
    );
  }
  let confirmed: StopConfirmationResult;
  try {
    confirmed = await confirmation.confirm({
      profile: input.profile,
      networkId: input.networkId,
      expectedOwnerInvocationId: input.expectedOwnerInvocationId,
      stopConfirmedBy: input.stopConfirmedBy,
      stopMethod: input.stopMethod,
      stopEvidenceRef: input.stopEvidenceRef,
    });
  } catch (error) {
    throw new NetworkLockRecoveryError(
      "STOP_NOT_CONFIRMED",
      "stop confirmation failed",
      error,
    );
  }
  if (!confirmed.confirmed) {
    throw new NetworkLockRecoveryError(
      "STOP_NOT_CONFIRMED",
      confirmed.detail || "stop was not confirmed",
    );
  }

  let checked: LockSnapshot;
  try {
    checked = await getInitialLock(client, recordKey);
  } catch (error) {
    throw new NetworkLockRecoveryError(
      "HEARTBEAT_ADVANCED",
      "network lock changed while stop confirmation was in progress",
      error,
    );
  }
  if (
    checked.revision !== initial.revision ||
    checked.heartbeatAt !== initial.heartbeatAt ||
    checked.ownerInvocationId !== initial.ownerInvocationId ||
    checked.leaseToken !== initial.leaseToken
  ) {
    throw new NetworkLockRecoveryError(
      "HEARTBEAT_ADVANCED",
      "network lock changed while stop confirmation was in progress",
    );
  }

  const releasedAt = now().toISOString();
  const tombstone = releaseTombstoneRecordKey(
    `${lockKey}:${initial.leaseToken}`,
  );
  const terminalRecord: KintoneRecord = {
    record_key: field(tombstone),
    lock_key: field(""),
    owner_invocation_id: field(""),
    lease_token: field(""),
    status: field("CANCELLED"),
    status_reason: field("NETWORK_LOCK_FORCE_RELEASED"),
    finished_at: field(releasedAt),
    revision: field(initial.businessRevision + 1),
  };
  let postReleaseRevision: number;
  try {
    postReleaseRevision = await client.putRecordById(
      initial.recordId,
      initial.revision,
      terminalRecord,
    );
  } catch (error) {
    if (
      error instanceof KintoneApiError &&
      (error.status === 409 || error.apiCode === "GAIA_CO02")
    ) {
      throw new NetworkLockRecoveryError(
        "REVISION_CONFLICT",
        "network lock release revision conflicted",
        error,
      );
    }
    if (!(error instanceof KintoneTransportError)) {
      throw new NetworkLockRecoveryError(
        "RELEASE_UNCONFIRMED",
        "network lock release failed",
        error,
      );
    }
    let records: KintoneRecord[];
    try {
      records = await getRecords(client, tombstone);
    } catch (adjudicationError) {
      throw new NetworkLockRecoveryError(
        "RELEASE_UNCONFIRMED",
        "network lock release outcome could not be confirmed",
        { release: error, adjudication: adjudicationError },
      );
    }
    if (
      records.length !== 1 ||
      !releaseConfirmed(records[0]!, initial, tombstone, releasedAt)
    ) {
      throw new NetworkLockRecoveryError(
        "RELEASE_UNCONFIRMED",
        "network lock release outcome could not be confirmed",
        { release: error, adjudication: "released tombstone did not match" },
      );
    }
    postReleaseRevision = revisionOf(records[0]!);
  }

  const audit: NetworkLockForceReleaseOperationAudit = {
    event_id: `net_unlock_${uuid()}`,
    event_type: "NETWORK_LOCK_FORCE_RELEASED",
    network_id: input.networkId,
    profile: input.profile,
    lock_key: lockKey,
    record_id: initial.recordId,
    previous_owner_invocation_id: initial.ownerInvocationId,
    previous_lease_token: initial.leaseToken,
    previous_heartbeat_at: initial.heartbeatAt,
    previous_lease_expires_at: initial.leaseExpiresAt,
    service_principal: input.servicePrincipal,
    requested_by: input.requestedBy,
    stop_confirmed_by: input.stopConfirmedBy,
    stop_method: confirmed.method,
    stop_evidence_ref: input.stopEvidenceRef,
    reason: input.reason,
    evidence_ref: input.evidenceRef,
    released_at: releasedAt,
    post_release_revision: postReleaseRevision,
  };
  try {
    await dependencies.repository.appendOperationAudit(audit);
  } catch (error) {
    throw new NetworkLockRecoveryError(
      "AUDIT_FAILED",
      "network lock was released but its audit could not be confirmed",
      error,
    );
  }
  return {
    lockKey,
    previousOwnerInvocationId: initial.ownerInvocationId,
    postReleaseRevision,
    audit,
  };
}
