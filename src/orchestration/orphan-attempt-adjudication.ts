import { randomUUID } from "node:crypto";

import type {
  NodeAttempt,
  NodeAttemptStatus,
  NodeState,
  ReconciliationOperationAudit,
} from "../domain/persistence-model.js";
import type {
  JobLogAttemptResult,
  JobLogReader,
} from "../executor/job-log-reader.js";
import { NO_EXECUTION_RESULT } from "../executor/result-classifier.js";
import type { PersistenceRepository } from "../persistence/repository.js";
import type { Versioned } from "../persistence/repository.js";

export interface OrphanAttemptAdjudicationInput {
  readonly runId: string;
  readonly invocationId: string;
  readonly repository: PersistenceRepository;
  readonly jobLogReader: Pick<JobLogReader, "findAttemptResult">;
  readonly confirmWrite: () => Promise<boolean>;
  readonly now?: () => string;
  readonly attempts?: readonly Versioned<NodeAttempt>[];
}

export interface OrphanAttemptAdjudication {
  readonly attemptId: string;
  readonly nodeId: string;
  readonly status: Exclude<NodeAttemptStatus, "RUNNING">;
  readonly resultCode: string;
}

export interface AbandonedInvocationFinalization {
  readonly invocationId: string;
  readonly previousStatus: string;
  readonly auditEventId: string;
}

interface TerminalDecision {
  readonly status: "SUCCESS" | "FAILED" | "CANCELLED" | "UNKNOWN";
  readonly resultCode: string;
}

/**
 * Resolves RUNNING attempts owned by an older invocation before resume selects
 * nodes. Job-log transport/schema failures deliberately escape (fail-closed).
 */
export async function adjudicateOrphanRunningAttempts(
  input: OrphanAttemptAdjudicationInput,
): Promise<readonly OrphanAttemptAdjudication[]> {
  const [states, attempts] = await Promise.all([
    input.repository.getNodeStates(input.runId),
    input.attempts ?? input.repository.getAttempts(input.runId),
  ]);
  const attemptsById = new Map(
    attempts.map((attempt) => [attempt.value.node_attempt_id, attempt]),
  );
  const adjudications: OrphanAttemptAdjudication[] = [];
  const now = input.now ?? (() => new Date().toISOString());
  const candidates: Array<{
    state: (typeof states)[number];
    attempt: (typeof attempts)[number];
  }> = [];

  for (const state of states) {
    if (
      state.value.status !== "RUNNING" ||
      state.value.active_attempt_id === null
    )
      continue;
    const attempt = attemptsById.get(state.value.active_attempt_id);
    if (attempt === undefined)
      throw new Error(
        `RUNNING Node State '${state.value.node_id}' has no active Attempt '${state.value.active_attempt_id}'`,
      );
    if (
      attempt.value.status !== "RUNNING" ||
      attempt.value.invocation_id === input.invocationId
    )
      continue;
    candidates.push({ state, attempt });
  }

  // Complete every read before the first write. A transport/schema failure
  // therefore stops this adjudication pass without guessing any outcome.
  const evidence = await Promise.all(
    candidates.map(async ({ state, attempt }) => ({
      state,
      attempt,
      jobLog: await input.jobLogReader.findAttemptResult(
        attempt.value.node_attempt_id,
      ),
    })),
  );

  for (const { state, attempt, jobLog } of evidence) {
    const decision = decideOrphanResult(jobLog);
    const finishedAt = jobLog?.finishedAt ?? now();

    if (!(await input.confirmWrite())) throw leaseInterrupted();
    await input.repository.finalizeAttempt(
      attempt.value.node_attempt_id,
      attempt.revision,
      {
        status: decision.status,
        result_code: decision.resultCode,
        // D-11 preserves the Attempt's durable start marker. The JOB log is
        // evidence for adjudication, not a surrogate write to this marker.
        runner_execution_started_at: attempt.value.runner_execution_started_at,
        execution_id: attempt.value.execution_id ?? jobLog?.executionId ?? null,
        finished_at: finishedAt,
        duration_sec: attempt.value.duration_sec,
        error_message:
          decision.status === "UNKNOWN"
            ? "orphan RUNNING attempt had no terminal execution result"
            : attempt.value.error_message,
        read_count: attempt.value.read_count,
        written_count: attempt.value.written_count,
        last_successful_chunk_no: attempt.value.last_successful_chunk_no,
        last_written_key: attempt.value.last_written_key,
      },
    );

    if (!(await input.confirmWrite())) throw leaseInterrupted();
    await input.repository.upsertNodeState({
      expected_revision: state.revision,
      value: terminalState(
        state.value,
        decision.status,
        decision.resultCode,
        finishedAt,
      ),
    });
    adjudications.push({
      attemptId: attempt.value.node_attempt_id,
      nodeId: state.value.node_id,
      status: decision.status,
      resultCode: decision.resultCode,
    });
  }
  return adjudications;
}

/** Finalizes invocations made unable to continue by the current lock owner. */
export async function finalizeAbandonedInvocations(
  input: Pick<
    OrphanAttemptAdjudicationInput,
    "runId" | "invocationId" | "repository" | "confirmWrite" | "now"
  >,
): Promise<readonly AbandonedInvocationFinalization[]> {
  const invocations = await input.repository.getInvocations(input.runId);
  const now = input.now ?? (() => new Date().toISOString());
  const results: AbandonedInvocationFinalization[] = [];
  for (const invocation of invocations) {
    const previousStatus: string = invocation.value.status;
    if (
      invocation.value.invocation_id === input.invocationId ||
      (previousStatus !== "RUNNING" && previousStatus !== "CREATED")
    )
      continue;
    if (!(await input.confirmWrite())) throw leaseInterrupted();
    const finishedAt = now();
    const finalized = await input.repository.finalizeInvocation(
      invocation.value.invocation_id,
      invocation.revision,
      {
        status: "CANCELLED",
        result_code: "NETWORK_LEASE_INTERRUPTED",
        finished_at: finishedAt,
        reason: `${invocation.value.reason}; finalized as an abandoned invocation during reconciliation`,
      },
    );
    if (!(await input.confirmWrite())) throw leaseInterrupted();
    const auditEventId = randomUUID();
    const audit: ReconciliationOperationAudit = {
      event_id: auditEventId,
      event_type: "RECONCILIATION_REPAIR",
      repair_type: "INVOCATION_FINALIZED",
      run_id: input.runId,
      target_type: "RUN_INVOCATION",
      target_id: invocation.value.invocation_id,
      before: {
        status: previousStatus,
        result_code: invocation.value.result_code,
        revision: invocation.revision,
      },
      after: {
        status: finalized.value.status,
        result_code: finalized.value.result_code,
        revision: finalized.revision,
      },
      basis:
        "the current Network lock owner makes an older unterminated invocation unable to continue",
      occurred_at: finishedAt,
    };
    await input.repository.appendOperationAudit(audit);
    results.push({
      invocationId: invocation.value.invocation_id,
      previousStatus,
      auditEventId,
    });
  }
  return results;
}

export function decideOrphanResult(
  jobLog: JobLogAttemptResult | null,
): TerminalDecision {
  if (jobLog === null) return unknownDecision();
  switch (jobLog.status.toUpperCase()) {
    case "SUCCESS":
      return { status: "SUCCESS", resultCode: "OK" };
    case "NO_DATA":
      return { status: "SUCCESS", resultCode: "NO_DATA" };
    case "FAILED":
      return { status: "FAILED", resultCode: "FAILED" };
    case "ABORTED":
      return { status: "FAILED", resultCode: "ASSERT_FAILED" };
    case "TIMEOUT":
      return { status: "FAILED", resultCode: "EXECUTION_TIMEOUT" };
    case "CANCELLED":
      return { status: "CANCELLED", resultCode: "CANCELLED" };
    case "RUNNING":
    default:
      return unknownDecision();
  }
}

export function orphanAdjudicationReason(
  adjudications: readonly OrphanAttemptAdjudication[],
): string | undefined {
  if (adjudications.length === 0) return undefined;
  return `orphan attempts adjudicated: ${adjudications
    .map((item) => `${item.attemptId}=${item.status}(${item.resultCode})`)
    .join(", ")}`;
}

function unknownDecision(): TerminalDecision {
  return { status: "UNKNOWN", resultCode: NO_EXECUTION_RESULT };
}

function terminalState(
  state: NodeState,
  status: Exclude<NodeAttemptStatus, "RUNNING">,
  resultCode: string,
  finishedAt: string,
): NodeState {
  return {
    ...state,
    status,
    active_attempt_id: null,
    status_reason: resultCode,
    finished_at: finishedAt,
    updated_at: finishedAt,
  };
}

function leaseInterrupted(): Error & { code: string } {
  return Object.assign(
    new Error("network lease was interrupted during orphan adjudication"),
    { code: "NETWORK_LEASE_INTERRUPTED" },
  );
}
