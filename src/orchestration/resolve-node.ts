import type {
  AttemptResolution,
  NodeState,
} from "../domain/persistence-model.js";
import type {
  PersistenceRepository,
  Versioned,
} from "../persistence/repository.js";

export type ResolutionOutcome = "SUCCESS" | "FAILED" | "CANCELLED";
export type ResolutionType = AttemptResolution["resolution_type"];

export interface ResolveNodeInput {
  repository: PersistenceRepository;
  runId: string;
  nodeId: string;
  outcome: ResolutionOutcome;
  resolutionType: ResolutionType;
  reason: string;
  evidenceRef: string;
  servicePrincipal: string;
  requestedBy: string;
  approvedBy: string;
  stopConfirmedBy: string;
  stopEvidenceRef: string;
  now?: () => Date;
}

export interface ResolveNodeResult {
  resolution: Versioned<AttemptResolution>;
  nodeState: Versioned<NodeState>;
}

export class ResolveNodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ResolveNodeError";
    this.code = code;
  }
}

export async function resolveNode(
  input: ResolveNodeInput,
): Promise<ResolveNodeResult> {
  validateRequiredAuditInput(input);
  if (
    input.resolutionType === "NODE_COMPENSATION_COMPLETED" &&
    input.outcome === "SUCCESS"
  ) {
    throw new ResolveNodeError(
      "COMPENSATION_CANNOT_SUCCEED",
      "NODE_COMPENSATION_COMPLETED cannot resolve a node to SUCCESS",
    );
  }
  if (
    input.outcome === "SUCCESS" &&
    input.resolutionType !== "NODE_MANUAL_COMPLETION_CONFIRMED"
  ) {
    throw new ResolveNodeError(
      "MANUAL_COMPLETION_REQUIRED",
      "SUCCESS requires NODE_MANUAL_COMPLETION_CONFIRMED",
    );
  }
  if (
    input.resolutionType === "NODE_MANUAL_COMPLETION_CONFIRMED" &&
    input.outcome !== "SUCCESS"
  ) {
    throw new ResolveNodeError(
      "MANUAL_COMPLETION_REQUIRES_SUCCESS",
      "NODE_MANUAL_COMPLETION_CONFIRMED can only resolve to SUCCESS",
    );
  }

  await input.repository.getRun(input.runId);
  const states = (await input.repository.getNodeStates(input.runId)).filter(
    ({ value }) => value.node_id === input.nodeId,
  );
  if (states.length !== 1) {
    throw new ResolveNodeError(
      "NODE_STATE_NOT_UNIQUE",
      `expected exactly one Node State for ${input.runId}/${input.nodeId}, found ${states.length}`,
    );
  }
  const state = states[0]!;
  const eligible =
    state.value.status === "UNKNOWN" ||
    (state.value.status === "FAILED" && !state.value.idempotent);
  if (!eligible) {
    throw new ResolveNodeError(
      "NODE_NOT_RESOLVABLE",
      `Node State ${state.value.status} is not UNKNOWN or non-idempotent FAILED`,
    );
  }
  const approvedBy = input.approvedBy.trim();
  const requestedBy = input.requestedBy.trim();
  const servicePrincipal = input.servicePrincipal.trim();
  if (
    !state.value.idempotent &&
    input.outcome === "SUCCESS" &&
    (approvedBy === "" ||
      approvedBy === requestedBy ||
      approvedBy === servicePrincipal)
  ) {
    throw new ResolveNodeError(
      "DISTINCT_APPROVER_REQUIRED",
      "non-idempotent SUCCESS requires an approved_by distinct from requested_by and service_principal",
    );
  }

  const currentAttempts = (
    await input.repository.getAttempts(input.runId)
  ).filter(
    ({ value }) =>
      value.node_id === input.nodeId &&
      value.attempt_no === state.value.latest_attempt_no,
  );
  if (currentAttempts.length !== 1) {
    throw new ResolveNodeError(
      "CURRENT_ATTEMPT_NOT_UNIQUE",
      `expected exactly one latest Attempt for ${input.runId}/${input.nodeId}, found ${currentAttempts.length}`,
    );
  }
  const attempt = currentAttempts[0]!;
  if (attempt.value.status !== state.value.status) {
    throw new ResolveNodeError(
      "STATE_ATTEMPT_MISMATCH",
      `Node State ${state.value.status} does not match latest Attempt ${attempt.value.status}`,
    );
  }

  const resolvedAt = (input.now ?? (() => new Date()))().toISOString();
  const resolution = await input.repository.appendResolution({
    event_type: "ATTEMPT_RESOLVED",
    resolution_type: input.resolutionType,
    attempt_id: attempt.value.node_attempt_id,
    resolved_outcome: input.outcome,
    reason: input.reason.trim(),
    evidence_ref: input.evidenceRef.trim(),
    service_principal: servicePrincipal,
    requested_by: requestedBy,
    approved_by: approvedBy,
    stop_confirmed_by: input.stopConfirmedBy.trim(),
    stop_evidence_ref: input.stopEvidenceRef.trim(),
    resolved_at: resolvedAt,
  });
  const nodeState = await input.repository.upsertNodeState({
    expected_revision: state.revision,
    resolution_event: {
      event_type: "ATTEMPT_RESOLVED",
      attempt_id: attempt.value.node_attempt_id,
      resolved_outcome: input.outcome,
      resolved_at: resolvedAt,
    },
    value: {
      ...state.value,
      status: input.outcome,
      active_attempt_id: null,
      status_reason: input.resolutionType,
      finished_at: state.value.finished_at ?? resolvedAt,
      updated_at: resolvedAt,
    },
  });
  return { resolution, nodeState };
}

function validateRequiredAuditInput(input: ResolveNodeInput): void {
  const required: ReadonlyArray<[string, string]> = [
    ["runId", input.runId],
    ["nodeId", input.nodeId],
    ["reason", input.reason],
    ["evidenceRef", input.evidenceRef],
    ["servicePrincipal", input.servicePrincipal],
    ["requestedBy", input.requestedBy],
    ["stopConfirmedBy", input.stopConfirmedBy],
    ["stopEvidenceRef", input.stopEvidenceRef],
  ];
  const missing = required
    .filter(([, value]) => value.trim() === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ResolveNodeError(
      "AUDIT_INPUT_REQUIRED",
      `required audit input is empty: ${missing.join(", ")}`,
    );
  }
}
