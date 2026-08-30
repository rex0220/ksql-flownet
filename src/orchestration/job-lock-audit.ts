import { randomUUID } from "node:crypto";

import type {
  JobLockRecoveryOperationAudit,
  LockRecoveryOutcome,
  LockRecoveryResult,
} from "../domain/persistence-model.js";
import type { PersistenceRepository } from "../persistence/repository.js";

export type JobLockAuditRepository = Pick<
  PersistenceRepository,
  "getRun" | "getNodeStates" | "appendOperationAudit"
>;

const OUTCOMES = new Set<LockRecoveryOutcome>([
  "RELEASED",
  "NOT_FOUND",
  "NOT_RUNNING",
  "CONFLICT",
  "UNCONFIRMED",
]);

export interface RecordJobUnlockInput {
  repository: JobLockAuditRepository;
  runId: string;
  nodeId: string;
  result: unknown;
  reason: string;
  evidenceRef: string;
  servicePrincipal: string;
  requestedBy: string;
  stopConfirmedBy: string;
  now?: () => Date;
  uuid?: () => string;
}

export class JobLockAuditError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JobLockAuditError";
    this.code = code;
  }
}

/** Records the kSQL-Flow result only. This module has no Job lock mutation dependency. */
export async function recordJobUnlock(
  input: RecordJobUnlockInput,
): Promise<JobLockRecoveryOperationAudit> {
  requireText("runId", input.runId);
  requireText("nodeId", input.nodeId);
  requireText("reason", input.reason);
  requireText("evidenceRef", input.evidenceRef);
  requireText("servicePrincipal", input.servicePrincipal);
  requireText("requestedBy", input.requestedBy);
  requireText("stopConfirmedBy", input.stopConfirmedBy);
  const result = parseLockRecoveryResult(input.result);
  const run = await input.repository.getRun(input.runId);
  const states = (await input.repository.getNodeStates(input.runId)).filter(
    ({ value }) => value.node_id === input.nodeId,
  );
  if (states.length !== 1) {
    throw new JobLockAuditError(
      "NODE_STATE_NOT_UNIQUE",
      `expected exactly one Node State for ${input.runId}/${input.nodeId}, found ${states.length}`,
    );
  }
  const state = states[0]!.value;
  const expectedJobKey = `${run.value.resolved_profile_snapshot.profile}:${state.job_id}`;
  if (result.jobKey !== expectedJobKey) {
    throw new JobLockAuditError(
      "JOB_KEY_MISMATCH",
      `LOCK_RECOVERY_RESULT jobKey ${result.jobKey} does not match ${expectedJobKey}`,
    );
  }
  const audit: JobLockRecoveryOperationAudit = {
    event_id: `job_unlock_${(input.uuid ?? randomUUID)()}`,
    event_type: "JOB_LOCK_FORCE_UNLOCK_RECORDED",
    run_id: input.runId,
    node_id: input.nodeId,
    job_id: state.job_id,
    service_principal: input.servicePrincipal.trim(),
    requested_by: input.requestedBy.trim(),
    stop_confirmed_by: input.stopConfirmedBy.trim(),
    reason: input.reason.trim(),
    evidence_ref: input.evidenceRef.trim(),
    recorded_at: (input.now ?? (() => new Date()))().toISOString(),
    lock_recovery_result: result,
  };
  await input.repository.appendOperationAudit(audit);
  return audit;
}

export function parseLockRecoveryResult(value: unknown): LockRecoveryResult {
  const record = object(value, "LOCK_RECOVERY_RESULT must be a JSON object");
  if (record.kind !== "LOCK_RECOVERY_RESULT" || record.formatVersion !== 1) {
    throw new JobLockAuditError(
      "INVALID_LOCK_RECOVERY_RESULT",
      "kind must be LOCK_RECOVERY_RESULT and formatVersion must be 1",
    );
  }
  const jobKey = requiredString(record.jobKey, "jobKey");
  const outcome = requiredString(record.outcome, "outcome");
  if (!OUTCOMES.has(outcome as LockRecoveryOutcome)) {
    throw new JobLockAuditError(
      "INVALID_LOCK_RECOVERY_RESULT",
      `unsupported outcome ${outcome}`,
    );
  }
  const recordId = nullableString(record.recordId, "recordId");
  const executedAt = requiredTimestamp(record.executedAt, "executedAt");
  let before: LockRecoveryResult["before"] = null;
  if (record.before !== null) {
    const beforeValue = object(
      record.before,
      "before must be an object or null",
    );
    before = {
      batchId: requiredString(beforeValue.batchId, "before.batchId"),
      startedAt: requiredTimestamp(beforeValue.startedAt, "before.startedAt"),
      host: requiredString(beforeValue.host, "before.host"),
    };
  }
  if (outcome === "NOT_FOUND" && (recordId !== null || before !== null)) {
    throw new JobLockAuditError(
      "INVALID_LOCK_RECOVERY_RESULT",
      "NOT_FOUND requires null recordId and before",
    );
  }
  if (
    (outcome === "RELEASED" ||
      outcome === "NOT_RUNNING" ||
      outcome === "CONFLICT") &&
    (recordId === null || before === null)
  ) {
    throw new JobLockAuditError(
      "INVALID_LOCK_RECOVERY_RESULT",
      `${outcome} requires recordId and before`,
    );
  }
  const nextAction =
    record.nextAction === undefined
      ? undefined
      : requiredString(record.nextAction, "nextAction");
  return {
    kind: "LOCK_RECOVERY_RESULT",
    formatVersion: 1,
    jobKey,
    recordId,
    outcome: outcome as LockRecoveryOutcome,
    before,
    executedAt,
    ...(nextAction === undefined ? {} : { nextAction }),
  };
}

function requireText(name: string, value: string): void {
  if (value.trim() === "")
    throw new JobLockAuditError("AUDIT_INPUT_REQUIRED", `${name} is required`);
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new JobLockAuditError("INVALID_LOCK_RECOVERY_RESULT", message);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new JobLockAuditError(
      "INVALID_LOCK_RECOVERY_RESULT",
      `${name} must be a non-empty string`,
    );
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredString(value, name);
}

function requiredTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new JobLockAuditError(
      "INVALID_LOCK_RECOVERY_RESULT",
      `${name} must be an ISO timestamp`,
    );
  return timestamp;
}
