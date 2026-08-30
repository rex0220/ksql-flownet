import { attemptKey } from "../../domain/canonical-record-key.js";
import { MAX_KINTONE_UNIQUE_KEY_LENGTH } from "../../domain/canonical-lock-key.js";
import type {
  AttemptResolution,
  NetworkRun,
  NodeAttempt,
  NodeState,
  OperationAudit,
  RunInvocation,
} from "../../domain/persistence-model.js";
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
} from "../repository.js";
import { RepositoryError } from "../repository.js";
import { isAllowedNodeStateTransition } from "../state-transition.js";
import {
  KintoneApiError,
  KintoneClient,
  KintoneTransportError,
  type KintoneFieldValue,
  type KintoneRecord,
} from "./client.js";

export interface KintoneRepositoryConfig {
  baseUrl: string;
  stateAppId: number;
  stateApiToken: string;
  auditAppId: number;
  auditApiToken: string;
  fetch?: typeof fetch;
}

const field = (value: unknown): KintoneFieldValue => ({ value });
const text = (record: KintoneRecord, code: string): string =>
  String(record[code]?.value ?? "");
const nullableText = (record: KintoneRecord, code: string): string | null => {
  const value = text(record, code);
  return value === "" ? null : value;
};
const numberValue = (record: KintoneRecord, code: string): number =>
  Number(record[code]?.value);
const nullableNumber = (record: KintoneRecord, code: string): number | null => {
  const value = record[code]?.value;
  return value === "" || value === null || value === undefined
    ? null
    : Number(value);
};
const jsonArray = (record: KintoneRecord, code: string): string[] =>
  JSON.parse(text(record, code)) as string[];
const revisionOf = (record: KintoneRecord): number =>
  Number(record.$revision?.value);

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function inQuery(fieldCode: string, value: string): string {
  return `${fieldCode} in (${quote(value)})`;
}

function uniqueKey(value: string): string {
  if (value.length > MAX_KINTONE_UNIQUE_KEY_LENGTH) {
    throw new RepositoryError(
      "UNIQUE_KEY_TOO_LONG",
      `unique key exceeds ${MAX_KINTONE_UNIQUE_KEY_LENGTH} characters`,
    );
  }
  return value;
}

function mapError(error: unknown): never {
  if (error instanceof KintoneApiError) {
    if (error.status === 409 && error.apiCode === "GAIA_CO02") {
      throw new RepositoryError("REVISION_CONFLICT", error.message, error);
    }
    if (error.status === 400 && error.apiCode === "CB_VA01") {
      throw new RepositoryError("DUPLICATE_RECORD", error.message, error);
    }
  }
  if (error instanceof KintoneTransportError) {
    throw new RepositoryError("AMBIGUOUS_WRITE", error.message, error);
  }
  throw new RepositoryError("REMOTE_ERROR", "kintone operation failed", error);
}

function versioned<T>(
  record: KintoneRecord,
  decode: (r: KintoneRecord) => T,
): Versioned<T> {
  return { value: decode(record), revision: revisionOf(record) };
}

function runRecord(run: NetworkRun): KintoneRecord {
  return {
    record_key: field(uniqueKey(`RUN:${run.run_id}`)),
    record_type: field("NETWORK_RUN"),
    run_id: field(run.run_id),
    network_id: field(run.network_id),
    business_key: field(run.business_key),
    max_active_runs: field(run.max_active_runs),
    status: field(run.status),
    lifecycle_status: field(run.lifecycle_status),
    resume_allowed: field(String(run.resume_allowed)),
    as_of: field(run.as_of ?? ""),
    definition_schema_version: field(run.definition_schema_version),
    definition_sha256: field(run.definition_sha256),
    source_bundle_sha256: field(run.source_bundle_sha256),
    // The schema stores an attachment, whose upload fileKey is supplied here.
    // Bundle upload/filename reconciliation belongs to FN-07/M4.
    source_bundle_attachment: field([
      { fileKey: run.source_bundle_attachment },
    ]),
    resolved_profile_snapshot: field(
      JSON.stringify(run.resolved_profile_snapshot),
    ),
    resolved_profile_sha256: field(run.resolved_profile_sha256),
    ksql_flow_version: field(run.ksql_flow_version),
    engine_version: field(run.engine_version),
    dialect: field(run.dialect),
    created_at: field(run.created_at),
    started_at: field(run.started_at ?? ""),
    finished_at: field(run.finished_at ?? ""),
    updated_at: field(run.updated_at),
  };
}

function decodeRun(record: KintoneRecord): NetworkRun {
  const attachments = record.source_bundle_attachment?.value as
    { fileKey?: string; name?: string }[] | undefined;
  return {
    run_id: text(record, "run_id"),
    network_id: text(record, "network_id"),
    business_key: text(record, "business_key"),
    max_active_runs: numberValue(record, "max_active_runs"),
    status: text(record, "status") as NetworkRun["status"],
    lifecycle_status: text(
      record,
      "lifecycle_status",
    ) as NetworkRun["lifecycle_status"],
    resume_allowed: text(record, "resume_allowed") === "true",
    as_of: nullableText(record, "as_of"),
    definition_schema_version: numberValue(record, "definition_schema_version"),
    definition_sha256: text(record, "definition_sha256"),
    source_bundle_sha256: text(record, "source_bundle_sha256"),
    source_bundle_attachment:
      attachments?.[0]?.fileKey ?? attachments?.[0]?.name ?? "",
    resolved_profile_snapshot: JSON.parse(
      text(record, "resolved_profile_snapshot"),
    ) as NetworkRun["resolved_profile_snapshot"],
    resolved_profile_sha256: text(record, "resolved_profile_sha256"),
    ksql_flow_version: text(record, "ksql_flow_version"),
    engine_version: text(record, "engine_version"),
    dialect: numberValue(record, "dialect"),
    created_at: text(record, "created_at"),
    started_at: nullableText(record, "started_at"),
    finished_at: nullableText(record, "finished_at"),
    updated_at: text(record, "updated_at"),
  };
}

function invocationRecord(value: RunInvocation): KintoneRecord {
  return {
    record_key: field(uniqueKey(`INV:${value.invocation_id}`)),
    record_type: field("RUN_INVOCATION"),
    run_id: field(value.run_id),
    started_at: field(value.started_at),
    finished_at: field(value.finished_at ?? ""),
    status: field(value.status),
    result_code: field(value.result_code),
    invocation_id: field(value.invocation_id),
    mode: field(value.mode),
    requested_by: field(value.requested_by),
    host: field(value.host),
    selected_node_ids: field(JSON.stringify(value.selected_node_ids)),
    preserved_node_ids: field(JSON.stringify(value.preserved_node_ids)),
    blocked_node_ids: field(JSON.stringify(value.blocked_node_ids)),
    reason: field(value.reason),
  };
}

function decodeInvocation(record: KintoneRecord): RunInvocation {
  return {
    invocation_id: text(record, "invocation_id"),
    run_id: text(record, "run_id"),
    mode: text(record, "mode") as RunInvocation["mode"],
    requested_by: text(record, "requested_by"),
    host: text(record, "host"),
    started_at: text(record, "started_at"),
    finished_at: nullableText(record, "finished_at"),
    status: text(record, "status") as RunInvocation["status"],
    result_code: text(record, "result_code"),
    selected_node_ids: jsonArray(record, "selected_node_ids"),
    preserved_node_ids: jsonArray(record, "preserved_node_ids"),
    blocked_node_ids: jsonArray(record, "blocked_node_ids"),
    reason: text(record, "reason"),
  };
}

function stateRecord(value: NodeState): KintoneRecord {
  return {
    record_key: field(uniqueKey(`STATE:${value.node_state_key}`)),
    record_type: field("NODE_STATE"),
    run_id: field(value.run_id),
    revision: field(value.revision),
    status: field(value.status),
    started_at: field(value.started_at ?? ""),
    finished_at: field(value.finished_at ?? ""),
    updated_at: field(value.updated_at),
    node_state_id: field(value.node_state_id),
    node_state_key: field(uniqueKey(value.node_state_key)),
    node_id: field(value.node_id),
    job_id: field(value.job_id),
    latest_attempt_no: field(value.latest_attempt_no),
    active_attempt_id: field(value.active_attempt_id ?? ""),
    idempotent: field(String(value.idempotent)),
    trigger_rule: field(value.trigger_rule),
    blocked_by: field(JSON.stringify(value.blocked_by)),
    status_reason: field(value.status_reason ?? ""),
  };
}

function decodeState(record: KintoneRecord): NodeState {
  return {
    node_state_id: text(record, "node_state_id"),
    node_state_key: text(
      record,
      "node_state_key",
    ) as NodeState["node_state_key"],
    run_id: text(record, "run_id"),
    node_id: text(record, "node_id"),
    job_id: text(record, "job_id"),
    status: text(record, "status") as NodeState["status"],
    latest_attempt_no: numberValue(record, "latest_attempt_no"),
    active_attempt_id: nullableText(record, "active_attempt_id"),
    revision: numberValue(record, "revision"),
    idempotent: text(record, "idempotent") === "true",
    trigger_rule: text(record, "trigger_rule") as "all_success",
    blocked_by: jsonArray(record, "blocked_by"),
    status_reason: nullableText(record, "status_reason"),
    started_at: nullableText(record, "started_at"),
    finished_at: nullableText(record, "finished_at"),
    updated_at: text(record, "updated_at"),
  };
}

function attemptRecord(value: NodeAttempt): KintoneRecord {
  return {
    record_key: field(uniqueKey(`ATT:${value.node_attempt_id}`)),
    record_type: field("NODE_ATTEMPT"),
    run_id: field(value.run_id),
    finished_at: field(value.finished_at ?? ""),
    status: field(value.status),
    result_code: field(value.result_code),
    node_attempt_id: field(uniqueKey(value.node_attempt_id)),
    attempt_key: field(uniqueKey(value.attempt_key)),
    node_id: field(value.node_id),
    job_id: field(value.job_id),
    invocation_id: field(value.invocation_id),
    attempt_no: field(value.attempt_no),
    execution_started_at: field(value.execution_started_at ?? ""),
    runner_execution_started_at: field(value.runner_execution_started_at ?? ""),
    execution_id: field(value.execution_id ?? ""),
    duration_sec: field(value.duration_sec ?? ""),
    error_message: field(value.error_message ?? ""),
    read_count: field(value.read_count),
    written_count: field(value.written_count),
    last_successful_chunk_no: field(value.last_successful_chunk_no ?? ""),
    last_written_key: field(value.last_written_key ?? ""),
    state_revision_before: field(value.state_revision_before ?? ""),
  };
}

function decodeAttempt(record: KintoneRecord): NodeAttempt {
  return {
    node_attempt_id: text(record, "node_attempt_id"),
    attempt_key: text(record, "attempt_key") as NodeAttempt["attempt_key"],
    run_id: text(record, "run_id"),
    node_id: text(record, "node_id"),
    job_id: text(record, "job_id"),
    invocation_id: text(record, "invocation_id"),
    attempt_no: numberValue(record, "attempt_no"),
    status: text(record, "status") as NodeAttempt["status"],
    result_code: text(record, "result_code"),
    execution_started_at: nullableText(record, "execution_started_at"),
    runner_execution_started_at: nullableText(
      record,
      "runner_execution_started_at",
    ),
    execution_id: nullableText(record, "execution_id"),
    finished_at: nullableText(record, "finished_at"),
    duration_sec: nullableNumber(record, "duration_sec"),
    error_message: nullableText(record, "error_message"),
    read_count: numberValue(record, "read_count"),
    written_count: numberValue(record, "written_count"),
    last_successful_chunk_no: nullableNumber(
      record,
      "last_successful_chunk_no",
    ),
    last_written_key: nullableText(record, "last_written_key"),
    state_revision_before: nullableNumber(record, "state_revision_before"),
  };
}

export class KintonePersistenceRepository implements PersistenceRepository {
  private readonly state: KintoneClient;
  private readonly audit: KintoneClient;

  constructor(config: KintoneRepositoryConfig) {
    this.state = new KintoneClient({
      baseUrl: config.baseUrl,
      appId: config.stateAppId,
      apiToken: config.stateApiToken,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
    this.audit = new KintoneClient({
      baseUrl: config.baseUrl,
      appId: config.auditAppId,
      apiToken: config.auditApiToken,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  async createRun(run: NetworkRun): Promise<Versioned<NetworkRun>> {
    return this.createWithAdjudication(
      this.state,
      `RUN:${run.run_id}`,
      runRecord(run),
      decodeRun,
      (found) => found.run_id === run.run_id,
    );
  }

  async getRunByBusinessKey(
    profile: string,
    networkId: string,
    businessKey: string,
  ): Promise<Versioned<NetworkRun> | null> {
    const records = await this.state.getRecords(
      [
        inQuery("record_type", "NETWORK_RUN"),
        inQuery("network_id", networkId),
        inQuery("business_key", businessKey),
      ].join(" and "),
    );
    const matches = records
      .map((record) => versioned(record, decodeRun))
      .filter(
        ({ value }) => value.resolved_profile_snapshot.profile === profile,
      );
    if (matches.length > 1) {
      throw new RepositoryError("MULTIPLE_RECORDS", "multiple runs matched");
    }
    return matches[0] ?? null;
  }

  async getRun(runId: string): Promise<Versioned<NetworkRun>> {
    return this.requiredByRecordKey(this.state, `RUN:${runId}`, decodeRun);
  }

  async updateRunAggregate(
    runId: string,
    expectedRevision: number,
    update: RunAggregateUpdate,
  ): Promise<Versioned<NetworkRun>> {
    const current = await this.requiredByRecordKey(
      this.state,
      `RUN:${runId}`,
      decodeRun,
    );
    const value = { ...current.value, ...update };
    await this.put(this.state, `RUN:${runId}`, expectedRevision, {
      status: field(update.status),
      started_at: field(update.started_at ?? ""),
      finished_at: field(update.finished_at ?? ""),
      updated_at: field(update.updated_at),
    });
    return { value, revision: expectedRevision + 1 };
  }

  async createInvocation(
    value: RunInvocation,
  ): Promise<Versioned<RunInvocation>> {
    return this.createWithAdjudication(
      this.audit,
      `INV:${value.invocation_id}`,
      invocationRecord(value),
      decodeInvocation,
      (found) => found.invocation_id === value.invocation_id,
    );
  }

  async finalizeInvocation(
    invocationId: string,
    expectedRevision: number,
    finalization: InvocationFinalization,
  ): Promise<Versioned<RunInvocation>> {
    const key = `INV:${invocationId}`;
    const current = await this.requiredByRecordKey(
      this.audit,
      key,
      decodeInvocation,
    );
    if (current.value.status !== "RUNNING") {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        "only a running invocation can be finalized",
      );
    }
    await this.put(this.audit, key, expectedRevision, {
      status: field(finalization.status),
      result_code: field(finalization.result_code),
      finished_at: field(finalization.finished_at),
    });
    return {
      value: { ...current.value, ...finalization },
      revision: expectedRevision + 1,
    };
  }

  async getNodeStates(runId: string): Promise<Versioned<NodeState>[]> {
    const records = await this.state.getRecords(
      `${inQuery("record_type", "NODE_STATE")} and ${inQuery("run_id", runId)}`,
    );
    return records.map((record) => versioned(record, decodeState));
  }

  async getAttempts(runId: string): Promise<Versioned<NodeAttempt>[]> {
    const records = await this.audit.getRecords(
      `${inQuery("record_type", "NODE_ATTEMPT")} and ${inQuery("run_id", runId)}`,
    );
    return records.map((record) => versioned(record, decodeAttempt));
  }

  async getResolutions(runId: string): Promise<Versioned<AttemptResolution>[]> {
    const attemptIds = new Set(
      (await this.getAttempts(runId)).map(({ value }) => value.node_attempt_id),
    );
    const records = await this.audit.getRecords(
      inQuery("record_type", "ATTEMPT_RESOLUTION"),
    );
    return records
      .filter((record) => attemptIds.has(text(record, "attempt_id")))
      .map((record) =>
        versioned(record, (value) => ({
          event_type: text(
            value,
            "event_type",
          ) as AttemptResolution["event_type"],
          attempt_id: text(value, "attempt_id"),
          resolved_outcome: text(
            value,
            "resolved_outcome",
          ) as AttemptResolution["resolved_outcome"],
          evidence_ref: text(value, "evidence_ref"),
          service_principal: text(value, "service_principal"),
          requested_by: text(value, "requested_by"),
          approved_by: text(value, "approved_by"),
          resolved_at: text(value, "resolved_at"),
        })),
      );
  }

  async upsertNodeState(write: NodeStateWrite): Promise<Versioned<NodeState>> {
    const key = `STATE:${write.value.node_state_key}`;
    if (write.expected_revision === null) {
      if (write.value.status !== "WAITING") {
        throw new RepositoryError(
          "INVALID_STATE_TRANSITION",
          "a new node state must be WAITING",
        );
      }
      return this.createWithAdjudication(
        this.state,
        key,
        stateRecord(write.value),
        decodeState,
        (found) => found.node_state_key === write.value.node_state_key,
      );
    }
    const current = await this.requiredByRecordKey(
      this.state,
      key,
      decodeState,
    );
    if (
      !isAllowedNodeStateTransition(current.value.status, write.value.status)
    ) {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        `${current.value.status} -> ${write.value.status} is not allowed`,
      );
    }
    if (
      (current.value.status === "FAILED" ||
        current.value.status === "CANCELLED") &&
      write.value.status === "WAITING" &&
      !current.value.idempotent
    ) {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        "a non-idempotent node cannot resume automatically",
      );
    }
    const newRevision = write.expected_revision + 1;
    const value = { ...write.value, revision: newRevision };
    await this.put(
      this.state,
      key,
      write.expected_revision,
      stateRecord(value),
    );
    return { value, revision: newRevision };
  }

  async createAttempt(
    input: CreateAttemptInput,
  ): Promise<Versioned<NodeAttempt>> {
    const state = input.node_state.value;
    const attemptNo = state.latest_attempt_no + 1;
    const value: NodeAttempt = {
      node_attempt_id: input.node_attempt_id,
      attempt_key: attemptKey(state.run_id, state.node_id, attemptNo),
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
      state_revision_before: input.node_state.revision,
    };
    try {
      return await this.createWithAdjudication(
        this.audit,
        `ATT:${value.node_attempt_id}`,
        attemptRecord(value),
        decodeAttempt,
        (found) => found.node_attempt_id === value.node_attempt_id,
      );
    } catch (error) {
      if (
        error instanceof RepositoryError &&
        (error.code === "DUPLICATE_RECORD" || error.code === "AMBIGUOUS_WRITE")
      ) {
        const matches = await this.audit.getRecords(
          `${inQuery("record_type", "NODE_ATTEMPT")} and ${inQuery("attempt_key", value.attempt_key)}`,
        );
        if (
          matches.length === 1 &&
          text(matches[0]!, "node_attempt_id") === value.node_attempt_id
        ) {
          return versioned(matches[0]!, decodeAttempt);
        }
        throw new RepositoryError(
          "ATTEMPT_NUMBER_CONFLICT",
          `attempt number ${attemptNo} cannot be uniquely confirmed`,
          error,
        );
      }
      throw error;
    }
  }

  async setAttemptExecutionStarted(
    attemptId: string,
    expectedRevision: number,
    start: AttemptExecutionStart,
  ): Promise<Versioned<NodeAttempt>> {
    const key = `ATT:${attemptId}`;
    const current = await this.requiredByRecordKey(
      this.audit,
      key,
      decodeAttempt,
    );
    if (current.value.status !== "RUNNING")
      throw new RepositoryError("ATTEMPT_TERMINAL", "attempt is terminal");
    if (current.value.execution_started_at !== null)
      throw new RepositoryError(
        "ATTEMPT_LIFECYCLE_VIOLATION",
        "execution_started_at is already set",
      );
    await this.put(this.audit, key, expectedRevision, {
      execution_started_at: field(start.execution_started_at),
    });
    return {
      value: { ...current.value, ...start },
      revision: expectedRevision + 1,
    };
  }

  async finalizeAttempt(
    attemptId: string,
    expectedRevision: number,
    finalization: AttemptFinalization,
  ): Promise<Versioned<NodeAttempt>> {
    const key = `ATT:${attemptId}`;
    const current = await this.requiredByRecordKey(
      this.audit,
      key,
      decodeAttempt,
    );
    if (current.value.status !== "RUNNING")
      throw new RepositoryError("ATTEMPT_TERMINAL", "attempt is terminal");
    const value = { ...current.value, ...finalization };
    await this.put(this.audit, key, expectedRevision, attemptRecord(value));
    return { value, revision: expectedRevision + 1 };
  }

  async appendResolution(
    value: AttemptResolution,
  ): Promise<Versioned<AttemptResolution>> {
    const attempt = await this.requiredByRecordKey(
      this.audit,
      `ATT:${value.attempt_id}`,
      decodeAttempt,
    );
    if (attempt.value.status !== "UNKNOWN")
      throw new RepositoryError(
        "ATTEMPT_LIFECYCLE_VIOLATION",
        "only UNKNOWN attempts can be resolved",
      );
    const key = uniqueKey(`RES:${value.attempt_id}:${value.resolved_at}`);
    const record: KintoneRecord = {
      record_key: field(key),
      record_type: field("ATTEMPT_RESOLUTION"),
      event_type: field(value.event_type),
      attempt_id: field(value.attempt_id),
      resolved_outcome: field(value.resolved_outcome),
      evidence_ref: field(value.evidence_ref),
      service_principal: field(value.service_principal),
      requested_by: field(value.requested_by),
      approved_by: field(value.approved_by),
      resolved_at: field(value.resolved_at),
    };
    return this.createWithAdjudication(
      this.audit,
      key,
      record,
      () => value,
      () => true,
    );
  }

  async appendOperationAudit(
    value: OperationAudit,
  ): Promise<Versioned<OperationAudit>> {
    const key = uniqueKey(`OP:${value.event_id}`);
    const record: KintoneRecord = {
      record_key: field(key),
      record_type: field("OPERATION_AUDIT"),
      run_id: field(value.run_id),
      result_code: field(value.repair_type),
      reason: field(JSON.stringify(value)),
      resolved_at: field(value.occurred_at),
    };
    return this.createWithAdjudication(
      this.audit,
      key,
      record,
      () => value,
      (found) => found.event_id === value.event_id,
    );
  }

  async listInconsistencies(runId: string): Promise<Inconsistency[]> {
    const states = await this.getNodeStates(runId);
    const attemptRecords = await this.audit.getRecords(
      `${inQuery("record_type", "NODE_ATTEMPT")} and ${inQuery("run_id", runId)}`,
    );
    const attempts = attemptRecords.map((record) =>
      versioned(record, decodeAttempt),
    );
    const result: Inconsistency[] = [];
    for (const state of states) {
      const nodeAttempts = attempts.filter(
        ({ value }) => value.node_id === state.value.node_id,
      );
      const running = nodeAttempts.filter(
        ({ value }) => value.status === "RUNNING",
      );
      if (running.length > 1)
        result.push({
          code: "MULTIPLE_RUNNING_ATTEMPTS",
          node_state: state,
          attempts: running,
        });
      if (state.value.active_attempt_id) {
        const active = nodeAttempts.find(
          ({ value }) =>
            value.node_attempt_id === state.value.active_attempt_id,
        );
        if (!active)
          result.push({ code: "ACTIVE_ATTEMPT_MISSING", node_state: state });
        else if (active.value.status !== state.value.status)
          result.push({
            code: "STATE_ATTEMPT_STATUS_MISMATCH",
            node_state: state,
            attempt: active,
          });
      }
    }
    return result;
  }

  private async createWithAdjudication<T>(
    client: KintoneClient,
    recordKey: string,
    record: KintoneRecord,
    decode: (r: KintoneRecord) => T,
    same: (value: T) => boolean,
  ): Promise<Versioned<T>> {
    try {
      const created = await client.postRecord(record);
      return {
        value: decode({
          ...record,
          $revision: field(String(created.revision)),
        }),
        revision: created.revision,
      };
    } catch (error) {
      if (
        !(error instanceof KintoneTransportError) &&
        !(
          error instanceof KintoneApiError &&
          error.status === 400 &&
          error.apiCode === "CB_VA01"
        )
      )
        mapError(error);
      const records = await client.getRecords(inQuery("record_key", recordKey));
      if (records.length === 1) {
        const found = versioned(records[0]!, decode);
        if (same(found.value)) return found;
      }
      if (error instanceof KintoneTransportError)
        throw new RepositoryError(
          "AMBIGUOUS_WRITE",
          "insert cannot be uniquely confirmed",
          error,
        );
      throw new RepositoryError(
        "DUPLICATE_RECORD",
        "insert unique conflict belongs to another record",
        error,
      );
    }
  }

  private async requiredByRecordKey<T>(
    client: KintoneClient,
    recordKey: string,
    decode: (r: KintoneRecord) => T,
  ): Promise<Versioned<T>> {
    let records: KintoneRecord[];
    try {
      records = await client.getRecords(inQuery("record_key", recordKey));
    } catch (error) {
      mapError(error);
    }
    if (records.length === 0)
      throw new RepositoryError("RECORD_NOT_FOUND", `${recordKey} not found`);
    if (records.length !== 1)
      throw new RepositoryError(
        "MULTIPLE_RECORDS",
        `${recordKey} is not unique`,
      );
    return versioned(records[0]!, decode);
  }

  private async put(
    client: KintoneClient,
    recordKey: string,
    revision: number,
    record: KintoneRecord,
  ): Promise<void> {
    try {
      // TODO(FDR): define a retry policy. Until then, deliberately do not retry;
      // callers must re-GET and reconcile ambiguous outcomes before continuing.
      const update = { ...record };
      delete update.record_key;
      await client.putRecord(recordKey, revision, update);
    } catch (error) {
      if (
        error instanceof KintoneApiError &&
        error.status === 400 &&
        error.apiCode === "GAIA_DA02"
      ) {
        // A concurrent updateKey PUT loser can be reported as GAIA_DA02 rather
        // than GAIA_CO02. Only reclassify it when a re-GET proves that the
        // expected revision lost its target; otherwise retain fail-closed
        // REMOTE_ERROR behavior for unrelated GAIA_DA02 responses.
        let records: KintoneRecord[];
        try {
          records = await client.getRecords(inQuery("record_key", recordKey));
        } catch {
          mapError(error);
        }
        if (
          records.length === 0 ||
          (records.length === 1 && revisionOf(records[0]!) > revision)
        ) {
          throw new RepositoryError("REVISION_CONFLICT", error.message, error);
        }
      }
      mapError(error);
    }
  }
}
