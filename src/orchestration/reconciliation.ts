import { randomUUID } from "node:crypto";

import { computeRunAggregateStatus } from "../domain/run-aggregate.js";
import type {
  AttemptResolution,
  NodeAttempt,
  NodeState,
  ReconciliationOperationAudit,
} from "../domain/persistence-model.js";
import type {
  PersistenceRepository,
  StatusReadRepository,
  Versioned,
  NodeStateWrite,
} from "../persistence/repository.js";

const TERMINAL_ATTEMPTS = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);
const TERMINAL_STATES = new Set([
  "SUCCESS",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
  "CANCELLED",
  "UNKNOWN",
]);

export interface ReconciliationRepair {
  type: ReconciliationOperationAudit["repair_type"];
  targetType: ReconciliationOperationAudit["target_type"];
  targetId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  basis: string;
  auditEventId: string;
}

export interface ReconciliationInconsistency {
  code:
    | "ACTIVE_ATTEMPT_ID_MISSING"
    | "ACTIVE_ATTEMPT_NOT_FOUND"
    | "ATTEMPT_NODE_STATE_MISSING"
    | "STATE_TERMINAL_ATTEMPT_RUNNING"
    | "STATE_ATTEMPT_STATUS_MISMATCH"
    | "MULTIPLE_RUNNING_ATTEMPTS"
    | "REVISION_SERIES_INVERTED"
    | "REVISION_SERIES_UNDETERMINED"
    | "RESOLUTION_ATTEMPT_NOT_UNKNOWN"
    | "RESOLUTION_NOT_CURRENT_ATTEMPT"
    | "RESOLUTION_STATE_NOT_UNKNOWN"
    | "CONFLICTING_ATTEMPT_RESOLUTIONS";
  nodeId: string;
  detail: string;
  attemptIds?: string[];
}

export interface ReconciliationResult {
  repaired: ReconciliationRepair[];
  inconsistencies: ReconciliationInconsistency[];
  aggregateUpdated: boolean;
}

export interface ReconciliationDetection {
  readonly inconsistencies: readonly ReconciliationDetectionItem[];
}

export interface ReconciliationDetectionItem {
  readonly code:
    | ReconciliationInconsistency["code"]
    | "TERMINAL_ATTEMPT_PENDING_APPLY"
    | "ATTEMPT_RESOLUTION_PENDING_APPLY"
    | "RUN_AGGREGATE_MISMATCH";
  readonly nodeId?: string;
  readonly detail: string;
  readonly attemptIds?: readonly string[];
}

export class ReconciliationRequiredError extends Error {
  readonly code = "RECONCILIATION_REQUIRED";
  readonly result: ReconciliationResult;

  constructor(result: ReconciliationResult) {
    super(`RECONCILIATION_REQUIRED: ${JSON.stringify(result.inconsistencies)}`);
    this.name = "ReconciliationRequiredError";
    this.result = result;
  }
}

function groupByNode(
  attempts: readonly Versioned<NodeAttempt>[],
): Map<string, Versioned<NodeAttempt>[]> {
  const result = new Map<string, Versioned<NodeAttempt>[]>();
  for (const attempt of attempts) {
    const values = result.get(attempt.value.node_id) ?? [];
    values.push(attempt);
    result.set(attempt.value.node_id, values);
  }
  return result;
}

function resolutionGroups(
  resolutions: readonly Versioned<AttemptResolution>[],
): Map<string, Versioned<AttemptResolution>[]> {
  const result = new Map<string, Versioned<AttemptResolution>[]>();
  for (const resolution of resolutions) {
    const values = result.get(resolution.value.attempt_id) ?? [];
    values.push(resolution);
    result.set(resolution.value.attempt_id, values);
  }
  return result;
}

/** Runs the D-09 inspections without exposing or invoking any repair method. */
export async function detectReconciliation(
  repository: StatusReadRepository,
  runId: string,
): Promise<ReconciliationDetection> {
  const run = await repository.getRun(runId);
  const states = await repository.getNodeStates(runId);
  const attempts = await repository.getAttempts(runId);
  const resolutions = await repository.getResolutions(runId);
  const attemptsByNode = groupByNode(attempts);
  const stateByNode = new Map(
    states.map((state) => [state.value.node_id, state]),
  );
  const inconsistencies: ReconciliationDetectionItem[] = [];
  const unsafeNodes = new Set<string>();

  for (const [nodeId, nodeAttempts] of attemptsByNode) {
    if (!stateByNode.has(nodeId)) {
      inconsistencies.push({
        code: "ATTEMPT_NODE_STATE_MISSING",
        nodeId,
        detail: "Node Attempts exist without a corresponding Node State",
        attemptIds: nodeAttempts.map(({ value }) => value.node_attempt_id),
      });
      unsafeNodes.add(nodeId);
    }
  }

  for (const state of states) {
    const nodeId = state.value.node_id;
    const nodeAttempts = attemptsByNode.get(nodeId) ?? [];
    const running = nodeAttempts.filter(
      ({ value }) => value.status === "RUNNING",
    );
    if (running.length > 1) {
      inconsistencies.push({
        code: "MULTIPLE_RUNNING_ATTEMPTS",
        nodeId,
        detail: "one node has multiple RUNNING attempts",
        attemptIds: running.map(({ value }) => value.node_attempt_id),
      });
      unsafeNodes.add(nodeId);
    }
    if (state.value.revision !== state.revision) {
      inconsistencies.push({
        code: "REVISION_SERIES_INVERTED",
        nodeId,
        detail: `business revision ${state.value.revision} differs from storage revision ${state.revision}`,
      });
      unsafeNodes.add(nodeId);
    }
    for (const attempt of nodeAttempts) {
      if (attempt.value.state_revision_before === null) {
        inconsistencies.push({
          code: "REVISION_SERIES_UNDETERMINED",
          nodeId,
          detail: `Attempt ${attempt.value.node_attempt_id} has no state_revision_before`,
          attemptIds: [attempt.value.node_attempt_id],
        });
        unsafeNodes.add(nodeId);
      } else if (attempt.value.state_revision_before >= state.value.revision) {
        inconsistencies.push({
          code:
            attempt.value.state_revision_before > state.value.revision
              ? "REVISION_SERIES_INVERTED"
              : "REVISION_SERIES_UNDETERMINED",
          nodeId,
          detail: `Attempt ${attempt.value.node_attempt_id} state_revision_before ${attempt.value.state_revision_before} is not older than State revision ${state.value.revision}`,
          attemptIds: [attempt.value.node_attempt_id],
        });
        unsafeNodes.add(nodeId);
      }
    }
    if (
      state.value.status === "RUNNING" &&
      state.value.active_attempt_id === null
    ) {
      inconsistencies.push({
        code: "ACTIVE_ATTEMPT_ID_MISSING",
        nodeId,
        detail: "RUNNING Node State has no active_attempt_id",
      });
      unsafeNodes.add(nodeId);
      continue;
    }
    if (state.value.active_attempt_id === null) continue;
    const active = nodeAttempts.filter(
      ({ value }) => value.node_attempt_id === state.value.active_attempt_id,
    );
    if (active.length !== 1) {
      inconsistencies.push({
        code: "ACTIVE_ATTEMPT_NOT_FOUND",
        nodeId,
        detail: `active attempt cardinality is ${active.length}`,
        attemptIds: [state.value.active_attempt_id],
      });
      unsafeNodes.add(nodeId);
      continue;
    }
    const attempt = active[0]!;
    if (unsafeNodes.has(nodeId)) continue;
    if (
      TERMINAL_ATTEMPTS.has(attempt.value.status) &&
      (attempt.value.status === state.value.status ||
        state.value.status === "RUNNING")
    ) {
      inconsistencies.push({
        code: "TERMINAL_ATTEMPT_PENDING_APPLY",
        nodeId,
        detail: "terminal active Attempt has not been applied to Node State",
        attemptIds: [attempt.value.node_attempt_id],
      });
    } else if (
      TERMINAL_STATES.has(state.value.status) &&
      attempt.value.status === "RUNNING"
    ) {
      inconsistencies.push({
        code: "STATE_TERMINAL_ATTEMPT_RUNNING",
        nodeId,
        detail: "Node State is terminal while its active Attempt is RUNNING",
        attemptIds: [attempt.value.node_attempt_id],
      });
    } else if (attempt.value.status !== state.value.status) {
      inconsistencies.push({
        code: "STATE_ATTEMPT_STATUS_MISMATCH",
        nodeId,
        detail: `State ${state.value.status} and Attempt ${attempt.value.status} do not match`,
        attemptIds: [attempt.value.node_attempt_id],
      });
    }
  }

  const attemptById = new Map(
    attempts.map((attempt) => [attempt.value.node_attempt_id, attempt]),
  );
  for (const [attemptId, grouped] of resolutionGroups(resolutions)) {
    const attempt = attemptById.get(attemptId);
    if (!attempt) continue;
    const outcomes = new Set(
      grouped.map(({ value }) => value.resolved_outcome),
    );
    const nodeId = attempt.value.node_id;
    if (outcomes.size > 1) {
      inconsistencies.push({
        code: "CONFLICTING_ATTEMPT_RESOLUTIONS",
        nodeId,
        detail: `Attempt ${attemptId} has conflicting Resolution outcomes`,
        attemptIds: [attemptId],
      });
      continue;
    }
    if (
      attempt.value.status !== "UNKNOWN" &&
      attempt.value.status !== "FAILED"
    ) {
      inconsistencies.push({
        code: "RESOLUTION_ATTEMPT_NOT_UNKNOWN",
        nodeId,
        detail: `Resolution targets ${attempt.value.status} Attempt ${attemptId}`,
        attemptIds: [attemptId],
      });
      continue;
    }
    const state = stateByNode.get(nodeId);
    if (!state) continue;
    if (
      attempt.value.attempt_no !== state.value.latest_attempt_no ||
      unsafeNodes.has(nodeId)
    ) {
      inconsistencies.push({
        code: "RESOLUTION_NOT_CURRENT_ATTEMPT",
        nodeId,
        detail: `Resolution attempt ${attemptId} is not the uniquely current State attempt`,
        attemptIds: [attemptId],
      });
      continue;
    }
    const outcome = grouped[0]!.value.resolved_outcome;
    if (state.value.status === outcome) continue;
    const resolvable =
      state.value.status === "UNKNOWN" ||
      (state.value.status === "FAILED" &&
        attempt.value.status === "FAILED" &&
        !state.value.idempotent);
    inconsistencies.push({
      code: resolvable
        ? "ATTEMPT_RESOLUTION_PENDING_APPLY"
        : "RESOLUTION_STATE_NOT_UNKNOWN",
      nodeId,
      detail: resolvable
        ? `Resolution for Attempt ${attemptId} has not been applied to Node State`
        : `Resolution cannot be applied to State ${state.value.status}`,
      attemptIds: [attemptId],
    });
  }

  const aggregate = computeRunAggregateStatus(
    states.map(({ value }) => value.status),
    run.value.started_at,
  );
  if (aggregate !== run.value.status) {
    inconsistencies.push({
      code: "RUN_AGGREGATE_MISMATCH",
      detail: `Run status ${run.value.status} differs from computed ${aggregate}`,
    });
  }
  return { inconsistencies };
}

async function recordRepair(
  repository: PersistenceRepository,
  runId: string,
  repaired: ReconciliationRepair[],
  repair: Omit<ReconciliationRepair, "auditEventId">,
  occurredAt: string,
): Promise<void> {
  const auditEventId = randomUUID();
  await repository.appendOperationAudit({
    event_id: auditEventId,
    event_type: "RECONCILIATION_REPAIR",
    repair_type: repair.type,
    run_id: runId,
    target_type: repair.targetType,
    target_id: repair.targetId,
    before: repair.before,
    after: repair.after,
    basis: repair.basis,
    occurred_at: occurredAt,
  });
  repaired.push({ ...repair, auditEventId });
}

async function repairState(
  repository: PersistenceRepository,
  current: Versioned<NodeState>,
  status: NodeState["status"],
  finishedAt: string | null,
  reason: string,
  resolutionEvent?: NodeStateWrite["resolution_event"],
): Promise<Versioned<NodeState>> {
  const now = new Date().toISOString();
  return repository.upsertNodeState({
    value: {
      ...current.value,
      status,
      active_attempt_id: null,
      status_reason: reason,
      finished_at: finishedAt,
      updated_at: now,
    },
    expected_revision: current.revision,
    ...(resolutionEvent === undefined
      ? {}
      : { resolution_event: resolutionEvent }),
  });
}

/** D-09 pre-DAG gate. Throws RECONCILIATION_REQUIRED after retaining safe repairs. */
export async function reconcileRun(
  repository: PersistenceRepository,
  runId: string,
): Promise<ReconciliationResult> {
  const repaired: ReconciliationRepair[] = [];
  const inconsistencies: ReconciliationInconsistency[] = [];
  const run = await repository.getRun(runId);
  const initialStates = await repository.getNodeStates(runId);
  const attempts = await repository.getAttempts(runId);
  const resolutions = await repository.getResolutions(runId);
  const attemptsByNode = groupByNode(attempts);
  const unsafeNodes = new Set<string>();
  const states = new Map(
    initialStates.map((state) => [state.value.node_id, state]),
  );

  for (const [nodeId, nodeAttempts] of attemptsByNode) {
    if (!states.has(nodeId)) {
      inconsistencies.push({
        code: "ATTEMPT_NODE_STATE_MISSING",
        nodeId,
        detail: "Node Attempts exist without a corresponding Node State",
        attemptIds: nodeAttempts.map(({ value }) => value.node_attempt_id),
      });
      unsafeNodes.add(nodeId);
    }
  }

  for (const initialState of initialStates) {
    let state = states.get(initialState.value.node_id)!;
    const nodeAttempts = attemptsByNode.get(state.value.node_id) ?? [];
    const running = nodeAttempts.filter(
      ({ value }) => value.status === "RUNNING",
    );
    if (running.length > 1) {
      inconsistencies.push({
        code: "MULTIPLE_RUNNING_ATTEMPTS",
        nodeId: state.value.node_id,
        detail: "one node has multiple RUNNING attempts",
        attemptIds: running.map(({ value }) => value.node_attempt_id),
      });
      unsafeNodes.add(state.value.node_id);
    }
    if (state.value.revision !== state.revision) {
      inconsistencies.push({
        code: "REVISION_SERIES_INVERTED",
        nodeId: state.value.node_id,
        detail: `business revision ${state.value.revision} differs from storage revision ${state.revision}`,
      });
      unsafeNodes.add(state.value.node_id);
    }
    for (const attempt of nodeAttempts) {
      if (attempt.value.state_revision_before === null) {
        inconsistencies.push({
          code: "REVISION_SERIES_UNDETERMINED",
          nodeId: state.value.node_id,
          detail: `Attempt ${attempt.value.node_attempt_id} has no state_revision_before`,
          attemptIds: [attempt.value.node_attempt_id],
        });
        unsafeNodes.add(state.value.node_id);
      } else if (attempt.value.state_revision_before > state.value.revision) {
        inconsistencies.push({
          code: "REVISION_SERIES_INVERTED",
          nodeId: state.value.node_id,
          detail: `Attempt ${attempt.value.node_attempt_id} state_revision_before ${attempt.value.state_revision_before} is not older than State revision ${state.value.revision}`,
          attemptIds: [attempt.value.node_attempt_id],
        });
        unsafeNodes.add(state.value.node_id);
      } else if (attempt.value.state_revision_before === state.value.revision) {
        inconsistencies.push({
          code: "REVISION_SERIES_UNDETERMINED",
          nodeId: state.value.node_id,
          detail: `Attempt ${attempt.value.node_attempt_id} was created from State revision ${state.value.revision}, but no later State revision is visible`,
          attemptIds: [attempt.value.node_attempt_id],
        });
        unsafeNodes.add(state.value.node_id);
      }
    }
    if (
      state.value.status === "RUNNING" &&
      state.value.active_attempt_id === null
    ) {
      inconsistencies.push({
        code: "ACTIVE_ATTEMPT_ID_MISSING",
        nodeId: state.value.node_id,
        detail: "RUNNING Node State has no active_attempt_id",
      });
      unsafeNodes.add(state.value.node_id);
      continue;
    }
    if (state.value.active_attempt_id === null) continue;
    const active = nodeAttempts.filter(
      ({ value }) => value.node_attempt_id === state.value.active_attempt_id,
    );
    if (active.length !== 1) {
      inconsistencies.push({
        code: "ACTIVE_ATTEMPT_NOT_FOUND",
        nodeId: state.value.node_id,
        detail: `active attempt cardinality is ${active.length}`,
        attemptIds: [state.value.active_attempt_id],
      });
      unsafeNodes.add(state.value.node_id);
      continue;
    }
    const attempt = active[0]!;
    if (unsafeNodes.has(state.value.node_id)) continue;
    if (attempt.value.status === state.value.status) {
      if (TERMINAL_ATTEMPTS.has(attempt.value.status)) {
        const before = {
          status: state.value.status,
          active_attempt_id: state.value.active_attempt_id,
          revision: state.value.revision,
        };
        state = await repairState(
          repository,
          state,
          state.value.status,
          attempt.value.finished_at,
          "reconciled terminal active attempt",
        );
        states.set(state.value.node_id, state);
        await recordRepair(
          repository,
          runId,
          repaired,
          {
            type: "TERMINAL_ATTEMPT_APPLIED",
            targetType: "NODE_STATE",
            targetId: state.value.node_state_id,
            before,
            after: {
              status: state.value.status,
              active_attempt_id: null,
              revision: state.value.revision,
            },
            basis: `terminal attempt ${attempt.value.node_attempt_id} matched State status; cleared stale active_attempt_id`,
          },
          state.value.updated_at,
        );
      }
      continue;
    }
    if (
      state.value.status === "RUNNING" &&
      TERMINAL_ATTEMPTS.has(attempt.value.status)
    ) {
      const before = {
        status: state.value.status,
        active_attempt_id: state.value.active_attempt_id,
        revision: state.value.revision,
      };
      state = await repairState(
        repository,
        state,
        attempt.value.status,
        attempt.value.finished_at,
        "reconciled from terminal active attempt",
      );
      states.set(state.value.node_id, state);
      await recordRepair(
        repository,
        runId,
        repaired,
        {
          type: "TERMINAL_ATTEMPT_APPLIED",
          targetType: "NODE_STATE",
          targetId: state.value.node_state_id,
          before,
          after: {
            status: state.value.status,
            active_attempt_id: null,
            revision: state.value.revision,
          },
          basis: `terminal attempt ${attempt.value.node_attempt_id} is the unique active attempt`,
        },
        state.value.updated_at,
      );
    } else if (
      TERMINAL_STATES.has(state.value.status) &&
      attempt.value.status === "RUNNING"
    ) {
      inconsistencies.push({
        code: "STATE_TERMINAL_ATTEMPT_RUNNING",
        nodeId: state.value.node_id,
        detail: "Node State is terminal while its active Attempt is RUNNING",
        attemptIds: [attempt.value.node_attempt_id],
      });
    } else {
      inconsistencies.push({
        code: "STATE_ATTEMPT_STATUS_MISMATCH",
        nodeId: state.value.node_id,
        detail: `State ${state.value.status} and Attempt ${attempt.value.status} do not match`,
        attemptIds: [attempt.value.node_attempt_id],
      });
    }
  }

  const attemptById = new Map(
    attempts.map((attempt) => [attempt.value.node_attempt_id, attempt]),
  );
  for (const [attemptId, grouped] of resolutionGroups(resolutions)) {
    const attempt = attemptById.get(attemptId);
    if (!attempt) continue;
    const outcomes = new Set(
      grouped.map(({ value }) => value.resolved_outcome),
    );
    if (outcomes.size > 1) {
      inconsistencies.push({
        code: "CONFLICTING_ATTEMPT_RESOLUTIONS",
        nodeId: attempt.value.node_id,
        detail: `Attempt ${attemptId} has conflicting Resolution outcomes`,
        attemptIds: [attemptId],
      });
      continue;
    }
    if (
      attempt.value.status !== "UNKNOWN" &&
      attempt.value.status !== "FAILED"
    ) {
      inconsistencies.push({
        code: "RESOLUTION_ATTEMPT_NOT_UNKNOWN",
        nodeId: attempt.value.node_id,
        detail: `Resolution targets ${attempt.value.status} Attempt ${attemptId}`,
        attemptIds: [attemptId],
      });
      continue;
    }
    const state = states.get(attempt.value.node_id);
    if (!state) continue;
    if (
      attempt.value.attempt_no !== state.value.latest_attempt_no ||
      unsafeNodes.has(state.value.node_id)
    ) {
      inconsistencies.push({
        code: "RESOLUTION_NOT_CURRENT_ATTEMPT",
        nodeId: state.value.node_id,
        detail: `Resolution attempt ${attemptId} is not the uniquely current State attempt`,
        attemptIds: [attemptId],
      });
      continue;
    }
    const outcome = grouped[0]!.value.resolved_outcome;
    if (state.value.status === outcome) continue;
    const resolvableState =
      state.value.status === "UNKNOWN" ||
      (state.value.status === "FAILED" &&
        attempt.value.status === "FAILED" &&
        !state.value.idempotent);
    if (!resolvableState) {
      inconsistencies.push({
        code: "RESOLUTION_STATE_NOT_UNKNOWN",
        nodeId: state.value.node_id,
        detail: `Resolution cannot be applied to State ${state.value.status}`,
        attemptIds: [attemptId],
      });
      continue;
    }
    const resolution = grouped.reduce((latest, item) =>
      item.value.resolved_at > latest.value.resolved_at ? item : latest,
    );
    const before = {
      status: state.value.status,
      revision: state.value.revision,
    };
    const updated = await repairState(
      repository,
      state,
      outcome,
      resolution.value.resolved_at,
      "reconciled from Attempt Resolution",
      {
        event_type: "ATTEMPT_RESOLVED",
        attempt_id: attemptId,
        resolved_outcome: outcome,
        resolved_at: resolution.value.resolved_at,
      },
    );
    states.set(updated.value.node_id, updated);
    await recordRepair(
      repository,
      runId,
      repaired,
      {
        type: "ATTEMPT_RESOLUTION_APPLIED",
        targetType: "NODE_STATE",
        targetId: updated.value.node_state_id,
        before,
        after: {
          status: updated.value.status,
          revision: updated.value.revision,
        },
        basis: `Attempt Resolution for ${attemptId} uniquely resolved outcome to ${outcome}`,
      },
      updated.value.updated_at,
    );
  }

  const aggregate = computeRunAggregateStatus(
    [...states.values()].map(({ value }) => value.status),
    run.value.started_at,
  );
  let aggregateUpdated = false;
  if (aggregate !== run.value.status) {
    const now = new Date().toISOString();
    const updated = await repository.updateRunAggregate(runId, run.revision, {
      status: aggregate,
      started_at: run.value.started_at,
      finished_at: run.value.finished_at,
      updated_at: now,
    });
    await recordRepair(
      repository,
      runId,
      repaired,
      {
        type: "RUN_AGGREGATE_RECOMPUTED",
        targetType: "NETWORK_RUN",
        targetId: runId,
        before: { status: run.value.status, revision: run.revision },
        after: { status: updated.value.status, revision: updated.revision },
        basis:
          "Network Run status recomputed from the complete Node State set using specification section 10",
      },
      now,
    );
    aggregateUpdated = true;
  }

  const result = { repaired, inconsistencies, aggregateUpdated };
  if (inconsistencies.length > 0) throw new ReconciliationRequiredError(result);
  return result;
}
