import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

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
import { KINTONE_DATETIME_TRUNCATION_MS } from "./kintone/design-notes.js";
import { releaseTombstoneRecordKey } from "./network-lock.js";
import { ownerInstanceIdFromStatusReason } from "./network-lock-reader.js";

export interface StopConfirmationInput {
  readonly profile: string;
  readonly networkId: string;
  readonly expectedOwnerInvocationId: string;
  readonly ownerInstanceId: string;
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

export interface StopConfirmationDependencies {
  readonly host?: string;
  readonly processKill?: (pid: number, signal: 0) => boolean;
  readonly fetch?: typeof fetch;
  readonly gcpAccessToken?: string;
  readonly now?: () => Date;
}

const localPidPattern = /^local-pid:\/\/([^/]+)\/([^/]+)$/u;
const cloudRunExecutionPattern =
  /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+\/executions\/[^/]+$/u;
const terminalCloudRunStates = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const nonTerminalCloudRunStates = new Set(["RUNNING", "PENDING"]);

function detailTime(now: () => Date): string {
  return now().toISOString();
}

export function createLocalPidStopConfirmation(
  dependencies: StopConfirmationDependencies = {},
): StopConfirmation {
  const host = dependencies.host ?? process.env.KSQL_FLOWNET_HOST ?? hostname();
  const processKill =
    dependencies.processKill ?? ((pid, signal) => process.kill(pid, signal));
  const now = dependencies.now ?? (() => new Date());
  return {
    async confirm(input) {
      const match = localPidPattern.exec(input.ownerInstanceId);
      if (match === null) {
        return {
          confirmed: false,
          method: "local_pid",
          detail: "owner_instance_id is not a valid local-pid resource",
        };
      }
      const ownerHost = match[1]!;
      const pidText = match[2]!;
      if (ownerHost !== host) {
        return {
          confirmed: false,
          method: "local_pid",
          detail: `owner host '${ownerHost}' differs from current host '${host}'; use manual recovery because lease expiry is not stop confirmation`,
        };
      }
      const pid = Number(pidText);
      if (!/^[1-9]\d*$/u.test(pidText) || !Number.isSafeInteger(pid)) {
        return {
          confirmed: false,
          method: "local_pid",
          detail: "owner_instance_id PID is not a positive safe integer",
        };
      }
      try {
        processKill(pid, 0);
        return {
          confirmed: false,
          method: "local_pid",
          detail: `PID ${pid} exists on host '${host}'`,
        };
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === "ESRCH") {
          return {
            confirmed: true,
            method: "local_pid",
            detail: `PID ${pid} was absent at ${detailTime(now)}; PID reuse remains a residual risk`,
          };
        }
        return {
          confirmed: false,
          method: "local_pid",
          detail:
            code === "EPERM"
              ? `PID ${pid} may exist but permission was denied`
              : `PID ${pid} existence check failed${code === undefined ? "" : ` (${code})`}`,
        };
      }
    },
  };
}

export function createCloudRunJobExecutionStopConfirmation(
  dependencies: StopConfirmationDependencies = {},
): StopConfirmation {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const accessToken =
    dependencies.gcpAccessToken ?? process.env.KSQL_FLOWNET_GCP_ACCESS_TOKEN;
  return {
    async confirm(input) {
      const resourceName = input.ownerInstanceId;
      if (!cloudRunExecutionPattern.test(resourceName)) {
        return cloudRunResult(
          false,
          "owner_instance_id is not a valid Cloud Run Job Execution resource",
        );
      }
      if (accessToken === undefined || accessToken.trim() === "") {
        return cloudRunResult(
          false,
          "KSQL_FLOWNET_GCP_ACCESS_TOKEN is not configured",
        );
      }
      let response: Response;
      try {
        response = await fetchImplementation(
          `https://run.googleapis.com/v2/${resourceName}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
      } catch {
        return cloudRunResult(false, "Cloud Run API request failed");
      }
      if (!response.ok) {
        return cloudRunResult(
          false,
          `Cloud Run API returned HTTP ${response.status}`,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return cloudRunResult(
          false,
          `Cloud Run API returned an unknown response shape (HTTP ${response.status})`,
        );
      }
      if (!isRecord(body) || body.name !== resourceName) {
        return cloudRunResult(
          false,
          `Cloud Run API returned an unknown response shape (HTTP ${response.status})`,
        );
      }
      const state = executionState(body);
      const stateDetail = state ?? "UNSPECIFIED";
      const completionTime = body.completionTime;
      if (
        completionTime === undefined ||
        completionTime === null ||
        completionTime === ""
      ) {
        return cloudRunResult(
          false,
          `Cloud Run Execution is not terminal (state=${stateDetail}, completionTime=unset, HTTP ${response.status})`,
        );
      }
      if (
        typeof completionTime !== "string" ||
        !Number.isFinite(Date.parse(completionTime))
      ) {
        return cloudRunResult(
          false,
          `Cloud Run API returned an unknown completionTime shape (state=${stateDetail}, HTTP ${response.status})`,
        );
      }
      if (state !== null && !terminalCloudRunStates.has(state)) {
        const verdict = nonTerminalCloudRunStates.has(state)
          ? "not terminal"
          : "an unknown state";
        return cloudRunResult(
          false,
          `Cloud Run Execution has ${verdict} (state=${state}, completionTime=${completionTime}, HTTP ${response.status})`,
        );
      }
      const countDetail = executionCountDetail(body);
      return cloudRunResult(
        true,
        `Cloud Run Execution is terminal (state=${stateDetail}, completionTime=${completionTime}, HTTP ${response.status}${countDetail})`,
      );
    },
  };
}

function cloudRunResult(
  confirmed: boolean,
  detail: string,
): StopConfirmationResult {
  return { confirmed, method: "cloud_run_job_execution", detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodeOf(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function executionState(body: Record<string, unknown>): string | null {
  if (typeof body.state === "string") return body.state;
  if (typeof body.status === "string") return body.status;
  return isRecord(body.terminalCondition) &&
    typeof body.terminalCondition.state === "string"
    ? body.terminalCondition.state
    : null;
}

function executionCountDetail(body: Record<string, unknown>): string {
  const names = [
    "taskCount",
    "succeededCount",
    "failedCount",
    "cancelledCount",
  ] as const;
  const counts = names.map((name) => body[name]);
  if (
    !counts.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
  )
    return "";
  const [taskCount, succeededCount, failedCount, cancelledCount] =
    counts.map(Number);
  const completed = succeededCount! + failedCount! + cancelledCount!;
  return `, taskCounts=${completed === taskCount ? "consistent" : "inconsistent"} (${completed}/${taskCount})`;
}

export function defaultStopConfirmations(
  dependencies: StopConfirmationDependencies = {},
): ReadonlyMap<string, StopConfirmation> {
  return new Map([
    ["manual", manualStopConfirmation],
    ["local_pid", createLocalPidStopConfirmation(dependencies)],
    [
      "cloud_run_job_execution",
      createCloudRunJobExecutionStopConfirmation(dependencies),
    ],
  ]);
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
  readonly ownerInstanceId: string;
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
    ownerInstanceId: ownerInstanceIdFromStatusReason(
      text(record, "status_reason"),
    ),
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
): boolean {
  // finished_at is DATETIME with minute precision, so do not use it for round-trip comparison.
  return (
    text(record, "$id") === initial.recordId &&
    text(record, "record_key") === tombstone &&
    text(record, "lock_key") === "" &&
    text(record, "owner_invocation_id") === "" &&
    text(record, "lease_token") === "" &&
    text(record, "status") === "CANCELLED" &&
    text(record, "status_reason") === "NETWORK_LOCK_FORCE_RELEASED" &&
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
  // The persisted lease expiry may be truncated by up to 59 seconds, so add the upper bound before allowing recovery.
  if (
    Date.parse(initial.leaseExpiresAt) + KINTONE_DATETIME_TRUNCATION_MS >
    now().getTime()
  ) {
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
      ownerInstanceId: initial.ownerInstanceId,
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
      !releaseConfirmed(records[0]!, initial, tombstone)
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
