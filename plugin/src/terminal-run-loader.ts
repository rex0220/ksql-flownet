import {
  parseRunActionAttributes,
  type RunActionAttributes,
} from "./activity-input.js";
import { readLimitedRecords, type FetchRecords } from "./kintone-reader.js";
import {
  requiredText,
  requireLiteral,
  type KintoneRecord,
} from "./kintone-record.js";

export const TERMINAL_RUN_QUERY =
  'record_type in ("NETWORK_RUN") and status in ("FAILED", "CANCELLED", "UNKNOWN") and lifecycle_status in ("ACTIVE") order by updated_at desc, $id desc limit 20';

export const TERMINAL_RUN_FIELDS = [
  "$id",
  "record_type",
  "run_id",
  "business_key",
  "status",
  "lifecycle_status",
  "resume_allowed",
  "updated_at",
] as const;

export interface TerminalRun extends RunActionAttributes {
  readonly recordId: string;
  readonly runId: string;
  readonly businessKey: string;
  readonly status: "FAILED" | "CANCELLED" | "UNKNOWN";
}

export interface TerminalRunLoadResult {
  readonly runs: readonly TerminalRun[];
  readonly totalCount: number;
  readonly remainingCount: number;
}

function parseTerminalRun(record: KintoneRecord): TerminalRun {
  if (requiredText(record, "record_type") !== "NETWORK_RUN") {
    throw new Error("要対応(終端)の対象外record_typeです。");
  }
  const status = requireLiteral(record, "status", [
    "FAILED",
    "CANCELLED",
    "UNKNOWN",
  ] as const);
  const attributes = parseRunActionAttributes(record);
  if (attributes.lifecycleStatus !== "ACTIVE") {
    throw new Error("要対応(終端)の対象外lifecycle_statusです。");
  }
  return {
    recordId: requiredText(record, "$id"),
    runId: requiredText(record, "run_id"),
    businessKey: requiredText(record, "business_key"),
    status,
    ...attributes,
  };
}

/**
 * 終端セクションだけのloader。呼出側はこの失敗を未終端loaderと別に扱う。
 */
export async function loadTerminalRuns(
  fetchRecords: FetchRecords,
  stateAppId: number | string,
): Promise<TerminalRunLoadResult> {
  const response = await readLimitedRecords(fetchRecords, {
    app: stateAppId,
    query: TERMINAL_RUN_QUERY,
    fields: TERMINAL_RUN_FIELDS,
  });
  if (response.records.length > 20) {
    throw new Error("要対応(終端)の応答が上限20件を超えています。");
  }
  const runs = response.records.map(parseTerminalRun);
  return {
    runs,
    totalCount: response.totalCount,
    remainingCount: Math.max(0, response.totalCount - runs.length),
  };
}
