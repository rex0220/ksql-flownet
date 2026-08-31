import type { KintoneRecord } from "../persistence/kintone/client.js";

export const REQUEST_TYPES = ["RERUN", "STOP", "RELEASE"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATES = [
  "REQUESTED",
  "ACCEPTED",
  "DONE",
  "REJECTED",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export type TerminalRequestState = Extract<RequestState, "DONE" | "REJECTED">;

export const REQUEST_VALUE_LIMITS = {
  runId: 128,
  rerunFromNode: 128,
  reason: 65_535,
  creatorCode: 256,
  claimedHost: 256,
  resultCode: 128,
  resultMessage: 65_535,
} as const;

export interface RequestRecord {
  readonly id: string;
  readonly revision: number;
  readonly creatorCode: string;
  readonly createdAt: string;
  readonly requestType: RequestType;
  readonly runId: string;
  readonly rerunFromNode: string | null;
  readonly reason: string;
  readonly requestState: RequestState;
  readonly claimedAt: string | null;
  readonly claimedHost: string | null;
  readonly claimHeartbeatAt: string | null;
  readonly resultCode: string | null;
  readonly resultMessage: string | null;
}

export interface RequestValidationIssue {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export class RequestValidationError extends Error {
  readonly issues: readonly RequestValidationIssue[];

  constructor(issues: readonly RequestValidationIssue[]) {
    super(issues.map(({ code, field }) => `${field}:${code}`).join(", "));
    this.name = "RequestValidationError";
    this.issues = issues;
  }
}

function rawValue(record: KintoneRecord, field: string): unknown {
  return record[field]?.value;
}

function stringValue(record: KintoneRecord, field: string): string {
  const value = rawValue(record, field);
  if (typeof value !== "string") {
    throw new RequestValidationError([
      { code: "FIELD_TYPE_INVALID", field, message: "must be a string" },
    ]);
  }
  return value;
}

function optionalString(record: KintoneRecord, field: string): string | null {
  const value = stringValue(record, field);
  return value === "" ? null : value;
}

function creatorCode(record: KintoneRecord): string {
  const value = rawValue(record, "作成者");
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "string"
  ) {
    throw new RequestValidationError([
      {
        code: "CREATOR_INVALID",
        field: "作成者",
        message: "creator code is missing",
      },
    ]);
  }
  return value.code;
}

function choice<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new RequestValidationError([
      {
        code: "UNKNOWN_CHOICE",
        field,
        message: `unsupported value: ${value}`,
      },
    ]);
  }
  return value as T;
}

function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return false;
  const canonical = new Date(milliseconds).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function addLengthIssue(
  issues: RequestValidationIssue[],
  field: string,
  value: string | null,
  maximum: number,
): void {
  if (value !== null && Array.from(value).length > maximum) {
    issues.push({
      code: "VALUE_TOO_LONG",
      field,
      message: `must be at most ${maximum} Unicode characters`,
    });
  }
}

export function validateRequestRecord(
  record: RequestRecord,
): readonly RequestValidationIssue[] {
  const issues: RequestValidationIssue[] = [];
  if (!/^\d+$/.test(record.id)) {
    issues.push({
      code: "ID_INVALID",
      field: "$id",
      message: "must be decimal",
    });
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    issues.push({
      code: "REVISION_INVALID",
      field: "$revision",
      message: "must be a positive integer",
    });
  }
  if (!isIsoDateTime(record.createdAt)) {
    issues.push({
      code: "DATETIME_INVALID",
      field: "作成日時",
      message: "must be an ISO UTC datetime",
    });
  }
  if (record.runId.trim() === "") {
    issues.push({
      code: "REQUIRED",
      field: "run_id",
      message: "must not be blank",
    });
  }
  if (record.reason.trim() === "") {
    issues.push({
      code: "REQUIRED",
      field: "reason",
      message: "must not be blank",
    });
  }
  if (record.creatorCode.trim() === "") {
    issues.push({
      code: "REQUIRED",
      field: "作成者",
      message: "must not be blank",
    });
  }
  addLengthIssue(issues, "run_id", record.runId, REQUEST_VALUE_LIMITS.runId);
  addLengthIssue(
    issues,
    "rerun_from_node",
    record.rerunFromNode,
    REQUEST_VALUE_LIMITS.rerunFromNode,
  );
  addLengthIssue(issues, "reason", record.reason, REQUEST_VALUE_LIMITS.reason);
  addLengthIssue(
    issues,
    "作成者",
    record.creatorCode,
    REQUEST_VALUE_LIMITS.creatorCode,
  );
  addLengthIssue(
    issues,
    "claimed_host",
    record.claimedHost,
    REQUEST_VALUE_LIMITS.claimedHost,
  );
  addLengthIssue(
    issues,
    "result_code",
    record.resultCode,
    REQUEST_VALUE_LIMITS.resultCode,
  );
  addLengthIssue(
    issues,
    "result_message",
    record.resultMessage,
    REQUEST_VALUE_LIMITS.resultMessage,
  );

  if (record.requestType !== "RERUN" && record.rerunFromNode !== null) {
    issues.push({
      code: "FIELD_NOT_ALLOWED",
      field: "rerun_from_node",
      message: "is only allowed for RERUN",
    });
  }
  const claimValues = [
    record.claimedAt,
    record.claimedHost,
    record.claimHeartbeatAt,
  ];
  const claimCount = claimValues.filter((value) => value !== null).length;
  if (claimCount !== 0 && claimCount !== claimValues.length) {
    issues.push({
      code: "CLAIM_FIELDS_INCOMPLETE",
      field: "claimed_at",
      message: "claim fields must be all empty or all populated",
    });
  }
  if (record.claimedHost !== null && record.claimedHost.trim() === "") {
    issues.push({
      code: "REQUIRED",
      field: "claimed_host",
      message: "must not be blank when populated",
    });
  }
  for (const [field, value] of [
    ["claimed_at", record.claimedAt],
    ["claim_heartbeat_at", record.claimHeartbeatAt],
  ] as const) {
    if (value !== null && !isIsoDateTime(value)) {
      issues.push({
        code: "DATETIME_INVALID",
        field,
        message: "must be ISO UTC",
      });
    }
  }

  const hasResult = record.resultCode !== null || record.resultMessage !== null;
  if (record.requestState === "REQUESTED") {
    if (claimCount !== 0 || hasResult) {
      issues.push({
        code: "STATE_FIELDS_INVALID",
        field: "request_state",
        message: "REQUESTED must not contain machine-owned values",
      });
    }
  } else if (record.requestState === "ACCEPTED") {
    if (claimCount !== claimValues.length || hasResult) {
      issues.push({
        code: "STATE_FIELDS_INVALID",
        field: "request_state",
        message: "ACCEPTED requires claim fields and no result",
      });
    }
  } else if (record.resultCode === null || record.resultCode.trim() === "") {
    issues.push({
      code: "RESULT_REQUIRED",
      field: "result_code",
      message: "terminal requests require a result code",
    });
  }
  return issues;
}

export function parseRequestRecord(record: KintoneRecord): RequestRecord {
  const revisionText = stringValue(record, "$revision");
  const parsed: RequestRecord = {
    id: stringValue(record, "$id"),
    revision: Number(revisionText),
    creatorCode: creatorCode(record),
    createdAt: stringValue(record, "作成日時"),
    requestType: choice(
      stringValue(record, "request_type"),
      REQUEST_TYPES,
      "request_type",
    ),
    runId: stringValue(record, "run_id"),
    rerunFromNode: optionalString(record, "rerun_from_node"),
    reason: stringValue(record, "reason"),
    requestState: choice(
      stringValue(record, "request_state"),
      REQUEST_STATES,
      "request_state",
    ),
    claimedAt: optionalString(record, "claimed_at"),
    claimedHost: optionalString(record, "claimed_host"),
    claimHeartbeatAt: optionalString(record, "claim_heartbeat_at"),
    resultCode: optionalString(record, "result_code"),
    resultMessage: optionalString(record, "result_message"),
  };
  const issues = validateRequestRecord(parsed);
  if (issues.length > 0) throw new RequestValidationError(issues);
  return parsed;
}
