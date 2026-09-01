import { validateAuditAppId, validateLogAppId } from "./config-validation.js";
import { readAllByChunks, type FetchRecords } from "./kintone-reader.js";
import {
  nullableText,
  requiredText,
  type KintoneRecord,
} from "./kintone-record.js";

const ATTEMPT_FIELDS = [
  "run_id",
  "node_id",
  "job_id",
  "status",
  "result_code",
  "$id",
] as const;
const JOB_LOG_FIELDS = [
  "correlation_id",
  "job_id",
  "status",
  "error_message",
  "$id",
] as const;
const NODE_STATE_FIELDS = [
  "run_id",
  "node_id",
  "status",
  "status_reason",
  "$id",
] as const;

export interface ErrorSummaryItem {
  readonly nodeId: string;
  readonly resultCode: string;
  readonly statusReason: string | null;
  readonly attemptRecordId: string;
  readonly errorMessage: string | null;
}

export interface RunErrorSummary {
  readonly state: "ready";
  readonly items: readonly ErrorSummaryItem[];
}

export interface UnavailableErrorSummary {
  readonly state: "unavailable";
}

export type ErrorSummary = RunErrorSummary | UnavailableErrorSummary;

interface ParsedAttempt {
  readonly runId: string;
  readonly nodeId: string;
  readonly resultCode: string;
  readonly jobId: string;
  readonly recordId: bigint;
}

interface ParsedNodeState {
  readonly runId: string;
  readonly nodeId: string;
  readonly statusReason: string | null;
  readonly recordId: bigint;
}

interface ParsedJobLog {
  readonly correlationId: string;
  readonly jobId: string;
  readonly errorMessage: string | null;
  readonly recordId: bigint;
}

function recordId(record: KintoneRecord): bigint {
  const value = requiredText(record, "$id");
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("エラー概要のレコードIDが不正です。");
  }
  return BigInt(value);
}

function recordKey(runId: string, nodeId: string): string {
  return `${runId.length}:${runId}${nodeId}`;
}

function ensureTargetRun(
  runId: string,
  targetRunIds: ReadonlySet<string>,
): void {
  if (!targetRunIds.has(runId)) {
    throw new Error("エラー概要に対象外のRunが含まれています。");
  }
}

function parseAttempt(
  record: KintoneRecord,
  targetRunIds: ReadonlySet<string>,
): ParsedAttempt | null {
  const runId = requiredText(record, "run_id");
  ensureTargetRun(runId, targetRunIds);
  if (requiredText(record, "status") === "SUCCESS") return null;
  return {
    runId,
    nodeId: requiredText(record, "node_id"),
    jobId: requiredText(record, "job_id"),
    resultCode: requiredText(record, "result_code"),
    recordId: recordId(record),
  };
}

function parseJobLog(
  record: KintoneRecord,
  targetRunIds: ReadonlySet<string>,
): ParsedJobLog {
  const correlationId = requiredText(record, "correlation_id");
  ensureTargetRun(correlationId, targetRunIds);
  const status = requiredText(record, "status");
  if (!new Set(["FAILED", "ABORTED", "TIMEOUT"]).has(status)) {
    throw new Error("エラー概要に対象外のJOBログが含まれています。");
  }
  return {
    correlationId,
    jobId: requiredText(record, "job_id"),
    errorMessage: nullableText(record, "error_message"),
    recordId: recordId(record),
  };
}

function parseNodeState(
  record: KintoneRecord,
  targetRunIds: ReadonlySet<string>,
): ParsedNodeState {
  const runId = requiredText(record, "run_id");
  ensureTargetRun(runId, targetRunIds);
  const status = requiredText(record, "status");
  if (!new Set(["FAILED", "UNKNOWN", "BLOCKED"]).has(status)) {
    throw new Error("エラー概要に対象外のNode Stateが含まれています。");
  }
  return {
    runId,
    nodeId: requiredText(record, "node_id"),
    statusReason: nullableText(record, "status_reason"),
    recordId: recordId(record),
  };
}

export function aggregateErrorSummaries(
  runIds: readonly string[],
  attemptRecords: readonly KintoneRecord[],
  nodeStateRecords: readonly KintoneRecord[],
  jobLogRecords: readonly KintoneRecord[] = [],
): ReadonlyMap<string, RunErrorSummary> {
  const uniqueRunIds = [...new Set(runIds)];
  const targetRunIds = new Set(uniqueRunIds);
  const latestAttempts = new Map<string, ParsedAttempt>();
  for (const record of attemptRecords) {
    const attempt = parseAttempt(record, targetRunIds);
    if (attempt === null) continue;
    const key = recordKey(attempt.runId, attempt.nodeId);
    const current = latestAttempts.get(key);
    if (current === undefined || attempt.recordId > current.recordId) {
      latestAttempts.set(key, attempt);
    }
  }

  const latestStates = new Map<string, ParsedNodeState>();
  for (const record of nodeStateRecords) {
    const state = parseNodeState(record, targetRunIds);
    const key = recordKey(state.runId, state.nodeId);
    const current = latestStates.get(key);
    if (current === undefined || state.recordId > current.recordId) {
      latestStates.set(key, state);
    }
  }

  const latestJobLogs = new Map<string, ParsedJobLog>();
  for (const record of jobLogRecords) {
    const log = parseJobLog(record, targetRunIds);
    const key = recordKey(log.correlationId, log.jobId);
    const current = latestJobLogs.get(key);
    if (current === undefined || log.recordId > current.recordId) {
      latestJobLogs.set(key, log);
    }
  }

  const itemsByRun = new Map<string, ErrorSummaryItem[]>();
  for (const attempt of latestAttempts.values()) {
    const key = recordKey(attempt.runId, attempt.nodeId);
    const item: ErrorSummaryItem = {
      nodeId: attempt.nodeId,
      resultCode: attempt.resultCode,
      statusReason: latestStates.get(key)?.statusReason ?? null,
      attemptRecordId: attempt.recordId.toString(),
      errorMessage:
        latestJobLogs.get(recordKey(attempt.runId, attempt.jobId))
          ?.errorMessage ?? null,
    };
    const items = itemsByRun.get(attempt.runId) ?? [];
    items.push(item);
    itemsByRun.set(attempt.runId, items);
  }

  return new Map(
    uniqueRunIds.map((runId) => [
      runId,
      {
        state: "ready" as const,
        items: (itemsByRun.get(runId) ?? []).sort((left, right) => {
          const byId =
            BigInt(right.attemptRecordId) - BigInt(left.attemptRecordId);
          if (byId !== 0n) return byId > 0n ? 1 : -1;
          return left.nodeId.localeCompare(right.nodeId);
        }),
      },
    ]),
  );
}

export async function loadErrorSummaries(
  fetchRecords: FetchRecords,
  stateAppId: number | string,
  auditAppId: string,
  runIds: readonly string[],
  logAppId: string | undefined = undefined,
): Promise<ReadonlyMap<string, ErrorSummary>> {
  const uniqueRunIds = [...new Set(runIds)];
  if (uniqueRunIds.length === 0) return new Map();
  const unavailable = (): ReadonlyMap<string, ErrorSummary> =>
    new Map(uniqueRunIds.map((runId) => [runId, { state: "unavailable" }]));
  const config = validateAuditAppId(auditAppId);
  if (!config.valid || config.value === null) return unavailable();
  let attempts: readonly KintoneRecord[];
  let nodeStates: readonly KintoneRecord[];
  try {
    [attempts, nodeStates] = await Promise.all([
      readAllByChunks(fetchRecords, {
        app: config.value,
        baseQuery: 'record_type in ("NODE_ATTEMPT")',
        field: "run_id",
        values: uniqueRunIds,
        fields: ATTEMPT_FIELDS,
      }),
      readAllByChunks(fetchRecords, {
        app: stateAppId,
        baseQuery:
          'record_type in ("NODE_STATE") and status in ("FAILED", "UNKNOWN", "BLOCKED")',
        field: "run_id",
        values: uniqueRunIds,
        fields: NODE_STATE_FIELDS,
      }),
    ]);
  } catch {
    return unavailable();
  }
  let fallback: ReadonlyMap<string, RunErrorSummary>;
  try {
    fallback = aggregateErrorSummaries(uniqueRunIds, attempts, nodeStates);
  } catch {
    return unavailable();
  }
  const logConfig = validateLogAppId(logAppId);
  if (!logConfig.valid || logConfig.value === null || logConfig.value === "") {
    return fallback;
  }
  try {
    const jobLogs = await readAllByChunks(fetchRecords, {
      app: logConfig.value,
      baseQuery: 'status in ("FAILED", "ABORTED", "TIMEOUT")',
      field: "correlation_id",
      values: uniqueRunIds,
      fields: JOB_LOG_FIELDS,
    });
    return aggregateErrorSummaries(uniqueRunIds, attempts, nodeStates, jobLogs);
  } catch {
    return fallback;
  }
}
