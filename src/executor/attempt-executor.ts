import type { NodeAttempt, NodeState } from "../domain/persistence-model.js";
import type {
  AttemptFinalization,
  PersistenceRepository,
  Versioned,
} from "../persistence/repository.js";
import {
  KintoneApiError,
  KintoneTransportError,
} from "../persistence/kintone/client.js";
import {
  decideMissingResult,
  type JobLogMarker,
  type JobLogReader,
} from "./job-log-reader.js";
import {
  NO_EXECUTION_RESULT,
  readAndClassifyResult,
  type ResultClassification,
  type ResultFileReader,
} from "./result-classifier.js";
import type {
  RunRequest,
  RunSubprocess,
  SubprocessRunResult,
} from "./run-subprocess.js";
import {
  serializeIoAuditSummary,
  serializeInputAuditSummary,
  serializeInputBaseline,
  serializeOutputAuditSummary,
} from "../io/input-baseline.js";

export interface AttemptExecutorInput extends RunRequest {
  readonly attempt: Versioned<NodeAttempt>;
  readonly nodeState: Versioned<NodeState>;
  readonly executionStartedAt: string;
  /** D-29 gate evaluated after subprocess completion and before result writes. */
  readonly authorizeResultPersistence?: () => Promise<boolean>;
  /** Scheduler-scoped retry for transport failures after subprocess completion. */
  readonly runControlPlaneOperation?: <T>(
    operation: () => Promise<T>,
  ) => Promise<T>;
}

export interface AttemptExecutorOptions {
  readonly repository: PersistenceRepository;
  readonly runner: Pick<RunSubprocess, "run">;
  readonly jobLogReader: JobLogReader;
  readonly resultFileReader?: ResultFileReader;
  readonly now?: () => string;
}

export interface AttemptExecutionOutcome {
  readonly classification: ResultClassification;
  readonly process: SubprocessRunResult;
  readonly attempt: Versioned<NodeAttempt>;
  readonly nodeState: Versioned<NodeState>;
  readonly invocationResultCode: string | null;
}

export class AttemptResultPersistenceDeferredError extends Error {
  readonly code = "NETWORK_LEASE_INTERRUPTED";

  constructor(
    readonly classification: ResultClassification,
    readonly process: SubprocessRunResult,
  ) {
    super(
      "subprocess completed but the Network lease does not permit result persistence",
    );
    this.name = "AttemptResultPersistenceDeferredError";
  }
}

/** FN-10 entry point for one already-created RUNNING attempt and node state. */
export class AttemptExecutor {
  private readonly now: () => string;

  constructor(private readonly options: AttemptExecutorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async execute(input: AttemptExecutorInput): Promise<AttemptExecutionOutcome> {
    assertPrepared(input);
    const startedAttempt =
      await this.options.repository.setAttemptExecutionStarted(
        input.attempt.value.node_attempt_id,
        input.attempt.revision,
        { execution_started_at: input.executionStartedAt },
      );
    const process = await this.options.runner.run(input);
    let classification = await readAndClassifyResult(
      process.resultJsonPath,
      {
        correlationId: input.correlationId,
        attemptId: input.attemptId,
        processExitCode: process.exitCode,
      },
      this.options.resultFileReader,
    );

    if (
      classification.kind === "VALID_RESULT" &&
      (input.imports?.length ?? 0) > 0
    ) {
      const receipts = classification.result?.input_files;
      const actual = [...(receipts ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, sha256, bytes }) => ({ name, sha256, bytes }));
      const expectedWithBytes = [...(input.imports ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, sha256, bytes }) => ({ name, sha256, bytes }));
      if (
        receipts === undefined ||
        JSON.stringify(actual) !== JSON.stringify(expectedWithBytes)
      ) {
        classification = {
          kind: "INVALID_RESULT",
          attemptOutcome: "UNKNOWN",
          resultCode: null,
          details: ["input_files does not match the preflight input baseline"],
          result: null,
          invocationResultCode: "INVALID_EXECUTION_RESULT",
        };
      }
    }
    if (
      classification.kind === "VALID_RESULT" &&
      (input.exports?.length ?? 0) > 0
    ) {
      const receipts = classification.result?.output_files;
      const expectedNames = [...(input.exports ?? [])]
        .sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        )
        .map(({ name }) => name);
      const actualNames = (receipts ?? []).map(({ name }) => name);
      let previousIndex = -1;
      const matchesConfiguredOutputs = actualNames.every((name) => {
        const index = expectedNames.indexOf(name);
        if (index < 0 || index <= previousIndex) return false;
        previousIndex = index;
        return true;
      });
      if (receipts === undefined || !matchesConfiguredOutputs) {
        classification = {
          kind: "INVALID_RESULT",
          attemptOutcome: "UNKNOWN",
          resultCode: null,
          details: ["output_files does not match the configured export sinks"],
          result: null,
          invocationResultCode: "INVALID_EXECUTION_RESULT",
        };
      }
    } else if (
      classification.kind === "VALID_RESULT" &&
      (classification.result?.output_files?.length ?? 0) > 0
    ) {
      classification = {
        kind: "INVALID_RESULT",
        attemptOutcome: "UNKNOWN",
        resultCode: null,
        details: ["output_files contains an unconfigured export sink"],
        result: null,
        invocationResultCode: "INVALID_EXECUTION_RESULT",
      };
    }

    if (process.forced) {
      classification = {
        kind: "INVALID_RESULT",
        attemptOutcome: "UNKNOWN",
        resultCode: null,
        details: [
          "process exceeded its grace period and was forcibly terminated",
        ],
        result: null,
        invocationResultCode: "FORCED_TERMINATION",
      };
    }
    const controlPlane =
      input.runControlPlaneOperation ??
      (<T>(operation: () => Promise<T>): Promise<T> => operation());
    const marker = await controlPlane(() =>
      this.readMarker(input.attemptId, classification.result?.executionId),
    );
    const runnerStartedAt = marker?.runnerExecutionStartedAt ?? null;
    let terminalStatus: AttemptFinalization["status"];
    let resultCode: string;
    let stateStatus: NodeState["status"];
    let invocationResultCode = classification.invocationResultCode;

    if (classification.kind === "VALID_RESULT") {
      if (classification.attemptOutcome === "LOCK_CONFLICT") {
        terminalStatus = "CANCELLED";
        resultCode = "PREPARE_FAILED";
        stateStatus = "WAITING";
      } else {
        terminalStatus = classification.attemptOutcome;
        resultCode = classification.resultCode as string;
        stateStatus = terminalStatus;
      }
    } else {
      const missingDecision = decideMissingResult({
        orchestratorExecutionStartedAt:
          startedAttempt.value.execution_started_at,
        runnerExecutionStartedAt: runnerStartedAt,
        durableLaunchFailureConfirmed:
          process.launchFailureConfirmed && marker !== undefined,
      });
      if (missingDecision === "NOT_EXECUTED") {
        terminalStatus = "CANCELLED";
        resultCode = "PREPARE_FAILED";
        stateStatus = "WAITING";
        invocationResultCode ??= "PREPARE_FAILED";
      } else {
        terminalStatus = "UNKNOWN";
        resultCode = process.forced
          ? "FORCED_TERMINATION"
          : classification.kind === "NO_RESULT"
            ? NO_EXECUTION_RESULT
            : "INVALID_EXECUTION_RESULT";
        stateStatus = "UNKNOWN";
      }
    }

    const result = classification.result;
    const finishedAt = result?.finishedAt ?? this.now();
    if (
      input.authorizeResultPersistence !== undefined &&
      !(await input.authorizeResultPersistence())
    ) {
      throw new AttemptResultPersistenceDeferredError(classification, process);
    }
    const attempt = await controlPlane(() =>
      this.options.repository.finalizeAttempt(
        startedAttempt.value.node_attempt_id,
        startedAttempt.revision,
        {
          status: terminalStatus,
          result_code: resultCode,
          runner_execution_started_at: runnerStartedAt,
          execution_id: result?.executionId ?? marker?.executionId ?? null,
          finished_at: finishedAt,
          duration_sec: result ? result.durationMs / 1000 : null,
          error_message: auditSummary(input, result, classification),
          read_count: result?.readCount ?? 0,
          written_count: result?.writtenCount ?? 0,
          last_successful_chunk_no: result?.lastSuccessfulChunkNo ?? null,
          last_written_key: result?.lastWrittenKey ?? null,
        },
      ),
    );

    const waiting = stateStatus === "WAITING";
    const nodeState = await controlPlane(() =>
      this.options.repository.upsertNodeState({
        expected_revision: input.nodeState.revision,
        value: {
          ...input.nodeState.value,
          status: stateStatus,
          active_attempt_id: null,
          status_reason: waiting ? "PREPARE_FAILED" : resultCode,
          started_at: waiting ? null : input.nodeState.value.started_at,
          finished_at: waiting ? null : finishedAt,
          updated_at: finishedAt,
        },
      }),
    );

    return {
      classification,
      process,
      attempt,
      nodeState,
      invocationResultCode,
    };
  }

  private async readMarker(
    attemptId: string,
    executionId: string | undefined,
  ): Promise<JobLogMarker | null | undefined> {
    try {
      return await this.options.jobLogReader.findExecutionStarted({
        attemptId,
        ...(executionId === undefined ? {} : { executionId }),
      });
    } catch (error) {
      if (
        error instanceof KintoneTransportError ||
        error instanceof KintoneApiError
      )
        throw error;
      return undefined;
    }
  }
}

function auditSummary(
  input: AttemptExecutorInput,
  result: ResultClassification["result"],
  classification: ResultClassification,
): string | null {
  const imports = input.imports ?? [];
  const exports = input.exports ?? [];
  if (result !== null && imports.length > 0 && exports.length > 0) {
    return serializeIoAuditSummary(
      imports,
      (result.input_files ?? []).map((file) => ({
        source: file.name,
        sha256: file.sha256,
        bytes: file.bytes,
        rows: file.rows,
        encoding: file.encoding,
      })),
      result.output_files ?? [],
    );
  }
  if (result !== null && exports.length > 0) {
    return serializeOutputAuditSummary(result.output_files ?? []);
  }
  if (imports.length > 0) {
    return result?.input_files === undefined
      ? serializeInputBaseline(imports)
      : serializeInputAuditSummary(
          imports,
          result.input_files.map((file) => ({
            source: file.name,
            sha256: file.sha256,
            bytes: file.bytes,
            rows: file.rows,
            encoding: file.encoding,
          })),
        );
  }
  return result?.error?.message ?? (classification.details.join("; ") || null);
}

function assertPrepared(input: AttemptExecutorInput): void {
  if (
    input.attempt.value.status !== "RUNNING" ||
    input.nodeState.value.status !== "RUNNING" ||
    input.nodeState.value.active_attempt_id !==
      input.attempt.value.node_attempt_id ||
    input.attempt.value.node_attempt_id !== input.attemptId
  )
    throw new Error(
      "attempt and node state must be the same prepared RUNNING execution",
    );
}
