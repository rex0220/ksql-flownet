import type {
  AttemptResolution,
  CancelRequest,
  NetworkRun,
  NetworkRunStatus,
  NodeAttempt,
  NodeAttemptStatus,
  NodeState,
  OperationAudit,
  RunInvocation,
  RunInvocationStatus,
} from "../domain/persistence-model.js";

export type RepositoryErrorCode =
  | "DUPLICATE_RECORD"
  | "REVISION_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "ATTEMPT_NUMBER_CONFLICT"
  | "ATTEMPT_TERMINAL"
  | "ATTEMPT_LIFECYCLE_VIOLATION"
  | "AMBIGUOUS_WRITE"
  | "RECORD_NOT_FOUND"
  | "MULTIPLE_RECORDS"
  | "UNIQUE_KEY_TOO_LONG"
  | "REMOTE_ERROR"
  | "AUDIT_CONFLICT";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly causeDetail: unknown;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    causeDetail?: unknown,
  ) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
    this.causeDetail = causeDetail;
  }
}

export interface Versioned<T> {
  value: T;
  revision: number;
}

export interface RunAggregateUpdate {
  status: NetworkRunStatus;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface InvocationFinalization {
  status: Exclude<RunInvocationStatus, "RUNNING">;
  result_code: string;
  finished_at: string;
  selected_node_ids?: readonly string[];
  preserved_node_ids?: readonly string[];
  blocked_node_ids?: readonly string[];
  reason?: string;
}

export interface NodeStateWrite {
  value: NodeState;
  expected_revision: number | null;
  resolution_event?: {
    event_type: "ATTEMPT_RESOLVED";
    attempt_id: string;
    resolved_outcome: "SUCCESS" | "FAILED" | "CANCELLED";
    resolved_at: string;
  };
}

export interface CreateAttemptInput {
  node_state: Versioned<NodeState>;
  node_attempt_id: string;
  invocation_id: string;
}

export interface AttemptExecutionStart {
  execution_started_at: string;
}

export interface AttemptInputBaselineWrite {
  error_message: string;
}

export interface AttemptFinalization {
  status: Exclude<NodeAttemptStatus, "RUNNING">;
  result_code: string;
  runner_execution_started_at: string | null;
  execution_id: string | null;
  finished_at: string;
  duration_sec: number | null;
  error_message: string | null;
  read_count: number;
  written_count: number;
  last_successful_chunk_no: number | null;
  last_written_key: string | null;
}

export type Inconsistency =
  | { code: "ACTIVE_ATTEMPT_MISSING"; node_state: Versioned<NodeState> }
  | {
      code: "STATE_ATTEMPT_STATUS_MISMATCH";
      node_state: Versioned<NodeState>;
      attempt: Versioned<NodeAttempt>;
    }
  | {
      code: "MULTIPLE_RUNNING_ATTEMPTS";
      node_state: Versioned<NodeState>;
      attempts: Versioned<NodeAttempt>[];
    };

export interface PersistenceRepository {
  createRun(run: NetworkRun): Promise<Versioned<NetworkRun>>;
  getRun(runId: string): Promise<Versioned<NetworkRun>>;
  getRunByBusinessKey(
    profile: string,
    networkId: string,
    businessKey: string,
  ): Promise<Versioned<NetworkRun> | null>;
  listRuns(
    profile: string,
    networkId: string,
  ): Promise<Versioned<NetworkRun>[]>;
  getCancelRequest(runId: string): Promise<Versioned<CancelRequest> | null>;
  createCancelRequest(
    request: CancelRequest,
  ): Promise<Versioned<CancelRequest>>;
  updateCancelRequest(
    runId: string,
    expectedRevision: number,
    request: CancelRequest,
  ): Promise<Versioned<CancelRequest>>;
  updateRunAggregate(
    runId: string,
    expectedRevision: number,
    update: RunAggregateUpdate,
  ): Promise<Versioned<NetworkRun>>;
  archiveRun(
    runId: string,
    expectedRevision: number,
    at: string,
  ): Promise<Versioned<NetworkRun>>;
  createInvocation(
    invocation: RunInvocation,
  ): Promise<Versioned<RunInvocation>>;
  getInvocations(runId: string): Promise<Versioned<RunInvocation>[]>;
  finalizeInvocation(
    invocationId: string,
    expectedRevision: number,
    finalization: InvocationFinalization,
  ): Promise<Versioned<RunInvocation>>;
  getNodeStates(runId: string): Promise<Versioned<NodeState>[]>;
  getAttempts(runId: string): Promise<Versioned<NodeAttempt>[]>;
  getResolutions(runId: string): Promise<Versioned<AttemptResolution>[]>;
  upsertNodeState(write: NodeStateWrite): Promise<Versioned<NodeState>>;
  createAttempt(input: CreateAttemptInput): Promise<Versioned<NodeAttempt>>;
  setAttemptInputBaseline(
    attemptId: string,
    expectedRevision: number,
    write: AttemptInputBaselineWrite,
  ): Promise<Versioned<NodeAttempt>>;
  setAttemptExecutionStarted(
    attemptId: string,
    expectedRevision: number,
    start: AttemptExecutionStart,
  ): Promise<Versioned<NodeAttempt>>;
  finalizeAttempt(
    attemptId: string,
    expectedRevision: number,
    finalization: AttemptFinalization,
  ): Promise<Versioned<NodeAttempt>>;
  appendResolution(
    resolution: AttemptResolution,
  ): Promise<Versioned<AttemptResolution>>;
  appendOperationAudit(
    audit: OperationAudit,
  ): Promise<Versioned<OperationAudit>>;
  getOperationAuditByEventId(
    eventId: string,
  ): Promise<Versioned<OperationAudit> | null>;
  listInconsistencies(runId: string): Promise<Inconsistency[]>;
}

/** The complete persistence surface available to read-only status inspection. */
export type StatusReadRepository = Pick<
  PersistenceRepository,
  | "getRun"
  | "getRunByBusinessKey"
  | "listRuns"
  | "getInvocations"
  | "getNodeStates"
  | "getAttempts"
  | "getResolutions"
  | "getCancelRequest"
>;
