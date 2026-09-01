import type {
  CancelRequestState,
  NetworkRunStatus,
} from "../../src/domain/persistence-model.js";
import type { ActivityInput } from "../../src/orchestration/run-activity.js";
import type { NetworkLockStatus } from "../../src/persistence/network-lock-reader.js";
import {
  KintoneRecordError,
  nonnegativeInteger,
  nullableText,
  requiredText,
  requireLiteral,
  type KintoneRecord,
} from "./kintone-record.js";

const RUN_STATUSES = [
  "CREATED",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
] as const satisfies readonly NetworkRunStatus[];
const CANCEL_STATES = [
  "REQUESTED",
  "ACCEPTED",
  "RELEASED",
] as const satisfies readonly CancelRequestState[];

export interface ActivityRun {
  readonly runId: string;
  readonly status: NetworkRunStatus;
  readonly startedAt: string | null;
}

export interface RunActionAttributes {
  readonly lifecycleStatus: "ACTIVE" | "ARCHIVED";
  readonly resumeAllowed: boolean;
  readonly updatedAt: string;
}

export interface ActivityInvocation {
  readonly invocationId: string;
  readonly runId: string;
}

export interface AssembleActivityInputsOptions {
  readonly runs: readonly ActivityRun[];
  readonly locks: readonly NetworkLockStatus[];
  readonly ownerInvocations: readonly ActivityInvocation[];
  readonly cancelStates: ReadonlyMap<string, CancelRequestState>;
  readonly nowMs: number;
}

function requireDate(value: string, code: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new KintoneRecordError(`invalid datetime field: ${code}`);
  }
  return value;
}

function requireRecordType(record: KintoneRecord, expected: string): void {
  const actual = requiredText(record, "record_type");
  if (actual !== expected) {
    throw new KintoneRecordError(
      `expected record_type ${expected}, received ${actual}`,
    );
  }
}

export function parseRunRecord(record: KintoneRecord): ActivityRun {
  requireRecordType(record, "NETWORK_RUN");
  const startedAt = nullableText(record, "started_at");
  return {
    runId: requiredText(record, "run_id"),
    status: requireLiteral(record, "status", RUN_STATUSES),
    startedAt: startedAt === null ? null : requireDate(startedAt, "started_at"),
  };
}

export function parseRunActionAttributes(
  record: KintoneRecord,
): RunActionAttributes {
  const resumeAllowed = requireLiteral(record, "resume_allowed", [
    "true",
    "false",
  ] as const);
  return {
    lifecycleStatus: requireLiteral(record, "lifecycle_status", [
      "ACTIVE",
      "ARCHIVED",
    ] as const),
    resumeAllowed: resumeAllowed === "true",
    updatedAt: requireDate(requiredText(record, "updated_at"), "updated_at"),
  };
}

export function parseLockRecord(record: KintoneRecord): NetworkLockStatus {
  requireRecordType(record, "NETWORK_LOCK");
  requireLiteral(record, "status", ["RUNNING"] as const);
  const statusReason = requiredText(record, "status_reason");
  const ownerPrefix = "owner_instance_id=";
  if (!statusReason.startsWith(ownerPrefix)) {
    throw new KintoneRecordError(
      "NETWORK_LOCK status_reason has no owner_instance_id",
    );
  }
  const ownerInstanceId = statusReason.slice(ownerPrefix.length);
  if (ownerInstanceId.length === 0) {
    throw new KintoneRecordError("NETWORK_LOCK owner_instance_id is empty");
  }
  const heartbeatAt = requiredText(record, "heartbeat_at");
  const leaseExpiresAt = requiredText(record, "lease_expires_at");
  return {
    record_id: requiredText(record, "$id"),
    owner_invocation_id: requiredText(record, "owner_invocation_id"),
    owner_instance_id: ownerInstanceId,
    heartbeat_at: requireDate(heartbeatAt, "heartbeat_at"),
    lease_expires_at: requireDate(leaseExpiresAt, "lease_expires_at"),
    revision: nonnegativeInteger(record, "revision"),
  };
}

export function parseInvocationRecord(
  record: KintoneRecord,
): ActivityInvocation {
  requireRecordType(record, "RUN_INVOCATION");
  return {
    invocationId: requiredText(record, "invocation_id"),
    runId: requiredText(record, "run_id"),
  };
}

export function parseCancelRecord(
  record: KintoneRecord,
  expectedRunId: string,
): CancelRequestState {
  requireRecordType(record, "CANCEL_REQUEST");
  const runId = requiredText(record, "run_id");
  if (runId !== expectedRunId) {
    throw new KintoneRecordError(
      "CANCEL_REQUEST run_id does not match target Run",
    );
  }
  if (requiredText(record, "record_key") !== `CANCEL:${expectedRunId}`) {
    throw new KintoneRecordError(
      "CANCEL_REQUEST record_key does not match run_id",
    );
  }

  let details: unknown;
  try {
    details = JSON.parse(requiredText(record, "status_reason"));
  } catch {
    throw new KintoneRecordError(
      "CANCEL_REQUEST status_reason is not valid JSON",
    );
  }
  if (
    typeof details !== "object" ||
    details === null ||
    Array.isArray(details) ||
    !Object.hasOwn(details, "state")
  ) {
    throw new KintoneRecordError(
      "CANCEL_REQUEST status_reason must be an object with state",
    );
  }
  const state = (details as { readonly state: unknown }).state;
  if (typeof state !== "string" || !CANCEL_STATES.includes(state as never)) {
    throw new KintoneRecordError(
      "CANCEL_REQUEST status_reason has invalid state",
    );
  }
  return state as CancelRequestState;
}

export function parseCancelRecords(
  records: readonly KintoneRecord[],
  expectedRunIds: ReadonlySet<string>,
): ReadonlyMap<string, CancelRequestState> {
  const states = new Map<string, CancelRequestState>();
  for (const record of records) {
    const runId = requiredText(record, "run_id");
    if (!expectedRunIds.has(runId)) {
      throw new KintoneRecordError(
        "CANCEL_REQUEST run_id is outside the requested Run set",
      );
    }
    if (states.has(runId)) {
      throw new KintoneRecordError(
        `duplicate CANCEL_REQUEST for Run: ${runId}`,
      );
    }
    states.set(runId, parseCancelRecord(record, runId));
  }
  return states;
}

export function assembleActivityInputs(
  options: AssembleActivityInputsOptions,
): ReadonlyMap<string, ActivityInput> {
  if (!Number.isFinite(options.nowMs)) {
    throw new KintoneRecordError("nowMs must be finite");
  }
  const runs = new Map<string, ActivityRun>();
  for (const run of options.runs) {
    if (runs.has(run.runId)) {
      throw new KintoneRecordError(`duplicate NETWORK_RUN: ${run.runId}`);
    }
    runs.set(run.runId, run);
  }

  const invocations = new Map<string, ActivityInvocation>();
  for (const invocation of options.ownerInvocations) {
    if (invocations.has(invocation.invocationId)) {
      throw new KintoneRecordError(
        `duplicate owner RUN_INVOCATION: ${invocation.invocationId}`,
      );
    }
    invocations.set(invocation.invocationId, invocation);
  }

  const locksByRun = new Map<string, NetworkLockStatus>();
  for (const lock of options.locks) {
    const invocation = invocations.get(lock.owner_invocation_id);
    if (invocation === undefined || !runs.has(invocation.runId)) {
      throw new KintoneRecordError(
        `active NETWORK_LOCK owner cannot be matched: ${lock.owner_invocation_id}`,
      );
    }
    if (locksByRun.has(invocation.runId)) {
      throw new KintoneRecordError(
        `multiple active NETWORK_LOCK records matched Run: ${invocation.runId}`,
      );
    }
    locksByRun.set(invocation.runId, lock);
  }

  const result = new Map<string, ActivityInput>();
  for (const run of runs.values()) {
    const lock = locksByRun.get(run.runId) ?? null;
    result.set(run.runId, {
      status: run.status,
      startedAt: run.startedAt,
      invocationIds: lock === null ? [] : [lock.owner_invocation_id],
      lock,
      cancelState: options.cancelStates.get(run.runId) ?? null,
      nowMs: options.nowMs,
    });
  }
  return result;
}
