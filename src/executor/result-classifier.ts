import { readFile } from "node:fs/promises";

export const NO_EXECUTION_RESULT = "NO_EXECUTION_RESULT" as const;

export type AttemptOutcome =
  "SUCCESS" | "FAILED" | "CANCELLED" | "UNKNOWN" | "LOCK_CONFLICT";

export interface ExecutionError {
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly detailsTruncated: boolean;
}

export interface ExecutionInputFile {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly encoding: string;
}

export interface ExecutionOutputFile {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly encoding: string;
}

export interface ExecutionResult {
  readonly formatVersion: 1;
  readonly kind: "EXECUTION_RESULT";
  readonly contract: "ksql-flow.execution/v1";
  readonly correlationId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly jobId: string;
  readonly profile: string;
  readonly status: "SUCCESS" | "FAILED" | "CANCELLED";
  readonly resultCode: string;
  readonly executionStarted: boolean;
  readonly exitCode: number;
  readonly asOf: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly readCount: number;
  readonly writtenCount: number;
  readonly deletedCount: number;
  readonly apiCalls: number;
  readonly lastSuccessfulChunkNo: number | null;
  readonly lastWrittenKey: string | null;
  readonly ksqlFlowVersion: string;
  readonly engineVersion: string;
  readonly error: ExecutionError | null;
  readonly input_files?: readonly ExecutionInputFile[];
  readonly output_files?: readonly ExecutionOutputFile[];
}

export interface ClassificationContext {
  readonly correlationId: string;
  readonly attemptId: string;
  readonly processExitCode: number | null;
}

export interface ResultClassification {
  readonly kind: "VALID_RESULT" | "INVALID_RESULT" | "NO_RESULT";
  readonly attemptOutcome: AttemptOutcome;
  readonly resultCode: string | null;
  readonly details: readonly string[];
  readonly result: ExecutionResult | null;
  readonly invocationResultCode: string | null;
}

export type ResultFileReader = (path: string) => Promise<string>;

const KNOWN_RESULTS: Readonly<
  Record<string, { status: ExecutionResult["status"]; exitCode: number }>
> = {
  OK: { status: "SUCCESS", exitCode: 0 },
  NO_DATA: { status: "SUCCESS", exitCode: 0 },
  VALIDATION_ERROR: { status: "FAILED", exitCode: 1 },
  ASSERT_FAILED: { status: "FAILED", exitCode: 2 },
  SQL_ERROR: { status: "FAILED", exitCode: 1 },
  API_ERROR: { status: "FAILED", exitCode: 3 },
  AUTH_ERROR: { status: "FAILED", exitCode: 3 },
  EXECUTION_TIMEOUT: { status: "FAILED", exitCode: 3 },
  LOCK_UNAVAILABLE: { status: "FAILED", exitCode: 3 },
  INTERNAL_ERROR: { status: "FAILED", exitCode: 3 },
  CANCELLED: { status: "CANCELLED", exitCode: 3 },
  LOCK_CONFLICT: { status: "FAILED", exitCode: 5 },
};

export async function readAndClassifyResult(
  path: string,
  context: ClassificationContext,
  reader: ResultFileReader = (filePath) => readFile(filePath, "utf8"),
): Promise<ResultClassification> {
  let source: string;
  try {
    source = await reader(path);
  } catch {
    return noResult("result file does not exist or could not be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return noResult("result file is not complete JSON");
  }
  return classifyResult(value, context);
}

export function classifyResult(
  value: unknown,
  context: ClassificationContext,
): ResultClassification {
  const errors = validateShape(value);
  if (errors.length > 0 || !isRecord(value)) return invalid(errors);

  if (value.correlationId !== context.correlationId)
    errors.push("correlationId does not echo the invocation value");
  if (value.attemptId !== context.attemptId)
    errors.push("attemptId does not echo the invocation value");
  if (value.exitCode !== context.processExitCode)
    errors.push("result exitCode does not match process exit code");

  const status = value.status as ExecutionResult["status"];
  const resultCode = value.resultCode as string;
  const exitCode = value.exitCode as number;
  const known = KNOWN_RESULTS[resultCode];
  if (known) {
    if (known.status !== status || known.exitCode !== exitCode)
      errors.push("status/resultCode/exitCode combination is inconsistent");
  } else if (!isStatusExitCompatible(status, exitCode)) {
    errors.push("unknown resultCode has an inconsistent status/exitCode");
  }

  if (
    (resultCode === "VALIDATION_ERROR" || resultCode === "LOCK_CONFLICT") &&
    value.executionStarted !== false
  )
    errors.push(`${resultCode} requires executionStarted=false`);
  if (status === "SUCCESS" && value.executionStarted !== true)
    errors.push("SUCCESS requires executionStarted=true");

  if (errors.length > 0) return invalid(errors);

  const result = value as unknown as ExecutionResult;
  const attemptOutcome =
    resultCode === "LOCK_CONFLICT"
      ? "LOCK_CONFLICT"
      : status === "SUCCESS"
        ? "SUCCESS"
        : status === "CANCELLED"
          ? "CANCELLED"
          : "FAILED";
  return {
    kind: "VALID_RESULT",
    attemptOutcome,
    resultCode,
    details: [],
    result,
    invocationResultCode:
      resultCode === "LOCK_CONFLICT" ? "LOCK_CONFLICT" : null,
  };
}

function validateShape(value: unknown): string[] {
  if (!isRecord(value)) return ["result must be a JSON object"];
  const errors: string[] = [];
  literal(value, "formatVersion", 1, errors);
  literal(value, "kind", "EXECUTION_RESULT", errors);
  literal(value, "contract", "ksql-flow.execution/v1", errors);
  for (const field of [
    "correlationId",
    "attemptId",
    "executionId",
    "jobId",
    "profile",
    "resultCode",
    "finishedAt",
    "ksqlFlowVersion",
    "engineVersion",
  ])
    requireString(value, field, errors);
  if (!["SUCCESS", "FAILED", "CANCELLED"].includes(String(value.status)))
    errors.push("status must be SUCCESS, FAILED, or CANCELLED");
  if (typeof value.executionStarted !== "boolean")
    errors.push("executionStarted must be boolean");
  if (!Number.isSafeInteger(value.exitCode))
    errors.push("exitCode must be an integer");
  if (!(value.asOf === null || isOffsetIso(value.asOf)))
    errors.push("asOf must be an ISO-8601 timestamp or null");
  if (!(value.startedAt === null || isUtcIso(value.startedAt)))
    errors.push("startedAt must be a UTC ISO-8601 timestamp or null");
  if (!isUtcIso(value.finishedAt))
    errors.push("finishedAt must be a UTC ISO-8601 timestamp");
  if (
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  )
    errors.push("durationMs must be non-negative");
  for (const field of ["readCount", "writtenCount", "deletedCount", "apiCalls"])
    requireNonNegativeInteger(value, field, errors);
  if (!(
    value.lastSuccessfulChunkNo === null ||
    (Number.isSafeInteger(value.lastSuccessfulChunkNo) &&
      (value.lastSuccessfulChunkNo as number) >= 0)
  ))
    errors.push("lastSuccessfulChunkNo must be a non-negative integer or null");
  if (!(
    value.lastWrittenKey === null || typeof value.lastWrittenKey === "string"
  ))
    errors.push("lastWrittenKey must be string or null");
  if (!(value.error === null || isExecutionError(value.error)))
    errors.push("error must be a contract error object or null");
  if (
    value.input_files !== undefined &&
    !isExecutionFileReceipts(value.input_files, false)
  )
    errors.push("input_files must contain safe input receipt entries");
  if (
    value.output_files !== undefined &&
    !isExecutionFileReceipts(value.output_files, true)
  )
    errors.push("output_files must contain safe output receipt entries");
  if (value.status === "SUCCESS" && value.error !== null)
    errors.push("SUCCESS requires error=null");
  if (value.status !== "SUCCESS" && value.error === null)
    errors.push("non-success result requires an error object");
  return errors;
}

function isExecutionFileReceipts(
  value: unknown,
  output: boolean,
): value is readonly (ExecutionInputFile | ExecutionOutputFile)[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      (output &&
        !hasOnlyKeys(item, ["name", "sha256", "bytes", "rows", "encoding"])) ||
      typeof item.name !== "string" ||
      !isSafeSourceName(item.name) ||
      names.has(item.name) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      (item.bytes as number) < 0 ||
      !Number.isSafeInteger(item.rows) ||
      (item.rows as number) < 0 ||
      typeof item.encoding !== "string" ||
      (output
        ? !["utf8", "sjis"].includes(item.encoding)
        : !/^[A-Za-z0-9._-]{1,32}$/u.test(item.encoding))
    )
      return false;
    names.add(item.name);
  }
  return true;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function isSafeSourceName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    value !== "__net__" &&
    !value.includes(":") &&
    !value.includes("=") &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function isStatusExitCompatible(
  status: ExecutionResult["status"],
  exitCode: number,
): boolean {
  if (status === "SUCCESS") return exitCode === 0;
  if (status === "CANCELLED") return exitCode === 3;
  return [1, 2, 3, 5].includes(exitCode);
}

function isExecutionError(value: unknown): value is ExecutionError {
  return (
    isRecord(value) &&
    typeof value.category === "string" &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    typeof value.detailsTruncated === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUtcIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /T.*Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isOffsetIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function literal(
  value: Record<string, unknown>,
  field: string,
  expected: unknown,
  errors: string[],
): void {
  if (value[field] !== expected)
    errors.push(`${field} must be ${String(expected)}`);
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  errors: string[],
): void {
  if (typeof value[field] !== "string" || value[field].length === 0)
    errors.push(`${field} must be a non-empty string`);
}

function requireNonNegativeInteger(
  value: Record<string, unknown>,
  field: string,
  errors: string[],
): void {
  if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0)
    errors.push(`${field} must be a non-negative integer`);
}

function invalid(details: readonly string[]): ResultClassification {
  return {
    kind: "INVALID_RESULT",
    attemptOutcome: "UNKNOWN",
    resultCode: null,
    details,
    result: null,
    invocationResultCode: "INVALID_EXECUTION_RESULT",
  };
}

function noResult(detail: string): ResultClassification {
  return {
    kind: "NO_RESULT",
    attemptOutcome: "UNKNOWN",
    resultCode: null,
    details: [detail],
    result: null,
    invocationResultCode: NO_EXECUTION_RESULT,
  };
}
