import { attemptKey, runKey } from "../domain/canonical-record-key.js";
import type {
  AttemptResolution,
  NetworkRun,
  NodeAttempt,
  NodeState,
  OperationAudit,
  RunInvocation,
} from "../domain/persistence-model.js";
import type {
  AttemptExecutionStart,
  AttemptFinalization,
  CreateAttemptInput,
  Inconsistency,
  InvocationFinalization,
  NodeStateWrite,
  PersistenceRepository,
  RunAggregateUpdate,
  Versioned,
} from "./repository.js";
import { RepositoryError } from "./repository.js";
import { isAllowedNodeStateTransition } from "./state-transition.js";

interface Stored<T> {
  value: T;
  revision: number;
}

function copy<T>(stored: Stored<T>): Versioned<T> {
  return structuredClone(stored);
}

function next<T>(stored: Stored<T>, value: T): Versioned<T> {
  stored.value = structuredClone(value);
  stored.revision += 1;
  return copy(stored);
}

function assertRevision<T>(stored: Stored<T>, expected: number): void {
  if (stored.revision !== expected) {
    throw new RepositoryError(
      "REVISION_CONFLICT",
      `expected revision ${expected}, actual ${stored.revision}`,
    );
  }
}

/** A deterministic component-test fake. It intentionally models unique keys and revisions. */
export class InMemoryPersistenceRepository implements PersistenceRepository {
  private readonly runs = new Map<string, Stored<NetworkRun>>();
  private readonly runKeys = new Map<string, string>();
  private readonly invocations = new Map<string, Stored<RunInvocation>>();
  private readonly states = new Map<string, Stored<NodeState>>();
  private readonly attempts = new Map<string, Stored<NodeAttempt>>();
  private readonly attemptIds = new Map<string, string>();
  private readonly resolutions: Stored<AttemptResolution>[] = [];
  private readonly operationAudits: Stored<OperationAudit>[] = [];

  async createRun(run: NetworkRun): Promise<Versioned<NetworkRun>> {
    const key = runKey(
      run.resolved_profile_snapshot.profile,
      run.network_id,
      run.business_key,
    );
    if (this.runs.has(run.run_id)) {
      throw new RepositoryError("DUPLICATE_RECORD", `run ${run.run_id} exists`);
    }
    if (this.runKeys.has(key)) {
      throw new RepositoryError(
        "DUPLICATE_RECORD",
        "profile/network/business key already exists",
      );
    }
    const stored = { value: structuredClone(run), revision: 1 };
    this.runs.set(run.run_id, stored);
    this.runKeys.set(key, run.run_id);
    return copy(stored);
  }

  async getRunByBusinessKey(
    profile: string,
    networkId: string,
    businessKey: string,
  ): Promise<Versioned<NetworkRun> | null> {
    const runId = this.runKeys.get(runKey(profile, networkId, businessKey));
    return runId ? copy(this.required(this.runs, runId, "run")) : null;
  }

  async getRun(runId: string): Promise<Versioned<NetworkRun>> {
    return copy(this.required(this.runs, runId, "run"));
  }

  async listRuns(
    profile: string,
    networkId: string,
  ): Promise<Versioned<NetworkRun>[]> {
    return [...this.runs.values()]
      .filter(
        ({ value }) =>
          value.resolved_profile_snapshot.profile === profile &&
          value.network_id === networkId,
      )
      .map(copy)
      .sort((left, right) =>
        left.value.run_id.localeCompare(right.value.run_id),
      );
  }

  async updateRunAggregate(
    runId: string,
    expectedRevision: number,
    update: RunAggregateUpdate,
  ): Promise<Versioned<NetworkRun>> {
    const stored = this.required(this.runs, runId, "run");
    assertRevision(stored, expectedRevision);
    return next(stored, { ...stored.value, ...update });
  }

  async createInvocation(
    invocation: RunInvocation,
  ): Promise<Versioned<RunInvocation>> {
    if (this.invocations.has(invocation.invocation_id)) {
      throw new RepositoryError("DUPLICATE_RECORD", "invocation exists");
    }
    const stored = { value: structuredClone(invocation), revision: 1 };
    this.invocations.set(invocation.invocation_id, stored);
    return copy(stored);
  }

  async finalizeInvocation(
    invocationId: string,
    expectedRevision: number,
    finalization: InvocationFinalization,
  ): Promise<Versioned<RunInvocation>> {
    const stored = this.required(this.invocations, invocationId, "invocation");
    assertRevision(stored, expectedRevision);
    if (stored.value.status !== "RUNNING") {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        "only a running invocation can be finalized",
      );
    }
    return next(stored, { ...stored.value, ...finalization });
  }

  async getNodeStates(runId: string): Promise<Versioned<NodeState>[]> {
    return [...this.states.values()]
      .filter(({ value }) => value.run_id === runId)
      .map(copy)
      .sort((a, b) => a.value.node_id.localeCompare(b.value.node_id));
  }

  async getAttempts(runId: string): Promise<Versioned<NodeAttempt>[]> {
    return [...this.attempts.values()]
      .filter(({ value }) => value.run_id === runId)
      .map(copy)
      .sort((a, b) => a.value.attempt_no - b.value.attempt_no);
  }

  async getResolutions(runId: string): Promise<Versioned<AttemptResolution>[]> {
    const attemptIds = new Set(
      (await this.getAttempts(runId)).map(({ value }) => value.node_attempt_id),
    );
    return this.resolutions
      .filter(({ value }) => attemptIds.has(value.attempt_id))
      .map(copy);
  }

  async upsertNodeState(write: NodeStateWrite): Promise<Versioned<NodeState>> {
    const key = write.value.node_state_key;
    const stored = this.states.get(key);
    if (!stored) {
      if (write.expected_revision !== null) {
        throw new RepositoryError("RECORD_NOT_FOUND", "node state not found");
      }
      if (write.value.status !== "WAITING") {
        throw new RepositoryError(
          "INVALID_STATE_TRANSITION",
          "a new node state must be WAITING",
        );
      }
      const created = {
        value: structuredClone({ ...write.value, revision: 1 }),
        revision: 1,
      };
      this.states.set(key, created);
      return copy(created);
    }
    if (write.expected_revision === null) {
      throw new RepositoryError("DUPLICATE_RECORD", "node state exists");
    }
    assertRevision(stored, write.expected_revision);
    if (
      !isAllowedNodeStateTransition(stored.value.status, write.value.status)
    ) {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        `${stored.value.status} -> ${write.value.status} is not allowed`,
      );
    }
    if (
      (stored.value.status === "FAILED" ||
        stored.value.status === "CANCELLED") &&
      write.value.status === "WAITING" &&
      !stored.value.idempotent
    ) {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        "a non-idempotent failed/cancelled node cannot resume automatically",
      );
    }
    const revision = stored.revision + 1;
    return next(stored, { ...structuredClone(write.value), revision });
  }

  async createAttempt(
    input: CreateAttemptInput,
  ): Promise<Versioned<NodeAttempt>> {
    const { value: state, revision } = input.node_state;
    const attemptNo = state.latest_attempt_no + 1;
    const key = attemptKey(state.run_id, state.node_id, attemptNo);
    const existing = this.attempts.get(key);
    if (existing) {
      if (existing.value.node_attempt_id === input.node_attempt_id) {
        return copy(existing);
      }
      throw new RepositoryError(
        "ATTEMPT_NUMBER_CONFLICT",
        `attempt number ${attemptNo} was already allocated`,
      );
    }
    if (this.attemptIds.has(input.node_attempt_id)) {
      throw new RepositoryError("DUPLICATE_RECORD", "attempt id exists");
    }
    const attempt: NodeAttempt = {
      node_attempt_id: input.node_attempt_id,
      attempt_key: key,
      run_id: state.run_id,
      node_id: state.node_id,
      job_id: state.job_id,
      invocation_id: input.invocation_id,
      attempt_no: attemptNo,
      status: "RUNNING",
      result_code: "PENDING",
      execution_started_at: null,
      runner_execution_started_at: null,
      execution_id: null,
      finished_at: null,
      duration_sec: null,
      error_message: null,
      read_count: 0,
      written_count: 0,
      last_successful_chunk_no: null,
      last_written_key: null,
      state_revision_before: revision,
    };
    const stored = { value: attempt, revision: 1 };
    this.attempts.set(key, stored);
    this.attemptIds.set(input.node_attempt_id, key);
    return copy(stored);
  }

  async setAttemptExecutionStarted(
    attemptId: string,
    expectedRevision: number,
    start: AttemptExecutionStart,
  ): Promise<Versioned<NodeAttempt>> {
    const stored = this.attemptById(attemptId);
    assertRevision(stored, expectedRevision);
    if (stored.value.status !== "RUNNING") {
      throw new RepositoryError("ATTEMPT_TERMINAL", "attempt is terminal");
    }
    if (stored.value.execution_started_at !== null) {
      throw new RepositoryError(
        "ATTEMPT_LIFECYCLE_VIOLATION",
        "execution_started_at is already set",
      );
    }
    return next(stored, { ...stored.value, ...start });
  }

  async finalizeAttempt(
    attemptId: string,
    expectedRevision: number,
    finalization: AttemptFinalization,
  ): Promise<Versioned<NodeAttempt>> {
    const stored = this.attemptById(attemptId);
    assertRevision(stored, expectedRevision);
    if (stored.value.status !== "RUNNING") {
      throw new RepositoryError("ATTEMPT_TERMINAL", "attempt is terminal");
    }
    return next(stored, { ...stored.value, ...finalization });
  }

  async appendResolution(
    resolution: AttemptResolution,
  ): Promise<Versioned<AttemptResolution>> {
    const attempt = this.attemptById(resolution.attempt_id);
    if (attempt.value.status !== "UNKNOWN") {
      throw new RepositoryError(
        "ATTEMPT_LIFECYCLE_VIOLATION",
        "only UNKNOWN attempts can be resolved",
      );
    }
    const stored = { value: structuredClone(resolution), revision: 1 };
    this.resolutions.push(stored);
    return copy(stored);
  }

  async appendOperationAudit(
    audit: OperationAudit,
  ): Promise<Versioned<OperationAudit>> {
    if (
      this.operationAudits.some(
        ({ value }) => value.event_id === audit.event_id,
      )
    )
      throw new RepositoryError("DUPLICATE_RECORD", "operation audit exists");
    const stored = { value: structuredClone(audit), revision: 1 };
    this.operationAudits.push(stored);
    return copy(stored);
  }

  async listInconsistencies(runId: string): Promise<Inconsistency[]> {
    const result: Inconsistency[] = [];
    for (const state of await this.getNodeStates(runId)) {
      const attempts = [...this.attempts.values()]
        .filter(
          ({ value }) =>
            value.run_id === runId && value.node_id === state.value.node_id,
        )
        .map(copy);
      const running = attempts.filter(
        ({ value }) => value.status === "RUNNING",
      );
      if (running.length > 1) {
        result.push({
          code: "MULTIPLE_RUNNING_ATTEMPTS",
          node_state: state,
          attempts: running,
        });
      }
      if (state.value.active_attempt_id) {
        const active = attempts.find(
          ({ value }) =>
            value.node_attempt_id === state.value.active_attempt_id,
        );
        if (!active) {
          result.push({ code: "ACTIVE_ATTEMPT_MISSING", node_state: state });
        } else if (active.value.status !== state.value.status) {
          result.push({
            code: "STATE_ATTEMPT_STATUS_MISMATCH",
            node_state: state,
            attempt: active,
          });
        }
      }
    }
    return result;
  }

  private required<T>(
    map: Map<string, Stored<T>>,
    key: string,
    label: string,
  ): Stored<T> {
    const stored = map.get(key);
    if (!stored) {
      throw new RepositoryError("RECORD_NOT_FOUND", `${label} not found`);
    }
    return stored;
  }

  private attemptById(attemptId: string): Stored<NodeAttempt> {
    const key = this.attemptIds.get(attemptId);
    if (!key) {
      throw new RepositoryError("RECORD_NOT_FOUND", "attempt not found");
    }
    return this.required(this.attempts, key, "attempt");
  }
}
