import {
  parseRequestRecord,
  REQUEST_VALUE_LIMITS,
  type RequestRecord,
  type RequestType,
} from "../../src/requests/request-model.js";
import {
  quoteQueryValue,
  readAllByChunks,
  readAllByKeyset,
  type FetchRecords,
} from "./kintone-reader.js";
import {
  KintoneRecordError,
  nullableText,
  requiredText,
  requireLiteral,
  type KintoneField,
  type KintoneRecord,
} from "./kintone-record.js";
import {
  aggregateStartCandidates,
  matchesStartGuard,
  START_CANDIDATE_LIMIT,
  START_CANDIDATE_PAGE_SIZE,
  type NormalizedStartInput,
  type StartCandidate,
  type StartCandidateGroupModel,
  type StartGuardKey,
} from "./start-request.js";

export const PENDING_REQUEST_BASE_QUERY =
  'request_state in ("REQUESTED", "ACCEPTED")';
export const PENDING_REQUEST_FIELDS = [
  "$id",
  "run_id",
  "request_state",
] as const;
export const PENDING_MAX_VALUES = 100;
export const PENDING_MAX_CONDITION_LENGTH = 1_000;
export const PENDING_MAX_FINAL_QUERY_LENGTH = 1_200;

export const REQUEST_READBACK_FIELDS = [
  "$id",
  "$revision",
  "作成者",
  "作成日時",
  "request_type",
  "run_id",
  "network_id",
  "business_key",
  "scheduled_for",
  "rerun_from_node",
  "reason",
  "request_state",
  "claimed_at",
  "claimed_host",
  "claim_heartbeat_at",
  "result_code",
  "result_message",
] as const;

interface PendingRequest {
  readonly id: string;
  readonly runId: string;
}

export interface PendingRequestSummary {
  readonly oldestId: string;
  readonly count: number;
  readonly label: string;
}

export type PendingLoadResult =
  | {
      readonly state: "ready";
      readonly byRunId: ReadonlyMap<string, PendingRequestSummary>;
    }
  | {
      readonly state: "unavailable";
      readonly byRunId: ReadonlyMap<string, PendingRequestSummary>;
      readonly warning: string;
    };

function parsePendingRequest(record: KintoneRecord): PendingRequest {
  const id = requiredText(record, "$id");
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new KintoneRecordError("invalid pending request record ID");
  }
  requireLiteral(record, "request_state", ["REQUESTED", "ACCEPTED"] as const);
  return { id, runId: requiredText(record, "run_id") };
}

function summarizePending(
  records: readonly PendingRequest[],
): ReadonlyMap<string, PendingRequestSummary> {
  const grouped = new Map<string, PendingRequest[]>();
  for (const record of records) {
    const group = grouped.get(record.runId) ?? [];
    group.push(record);
    grouped.set(record.runId, group);
  }
  const summaries = new Map<string, PendingRequestSummary>();
  for (const [runId, group] of grouped) {
    group.sort((left, right) =>
      BigInt(left.id) < BigInt(right.id)
        ? -1
        : BigInt(left.id) > BigInt(right.id)
          ? 1
          : 0,
    );
    const oldest = group[0];
    if (oldest === undefined) continue;
    const count = group.length;
    summaries.set(runId, {
      oldestId: oldest.id,
      count,
      label:
        count === 1
          ? `要求処理待ち #${oldest.id}`
          : `要求処理待ち ${count}件(最古 #${oldest.id})`,
    });
  }
  return summaries;
}

/** 1 page/chunkでも失敗した場合は、部分結果を一切返さない。 */
export async function loadPendingRequests(
  fetchRecords: FetchRecords,
  requestAppId: number | string,
  runIds: readonly string[],
): Promise<PendingLoadResult> {
  try {
    const records = await readAllByChunks(fetchRecords, {
      app: requestAppId,
      baseQuery: PENDING_REQUEST_BASE_QUERY,
      field: "run_id",
      values: runIds,
      fields: PENDING_REQUEST_FIELDS,
      pageSize: 500,
      maxValues: PENDING_MAX_VALUES,
      maxQueryLength: PENDING_MAX_CONDITION_LENGTH,
      maxFinalQueryLength: PENDING_MAX_FINAL_QUERY_LENGTH,
    });
    const parsed = records.map(parsePendingRequest);
    const requestedRunIds = new Set(runIds);
    if (parsed.some((record) => !requestedRunIds.has(record.runId))) {
      throw new KintoneRecordError(
        "pending response contains a run_id outside the requested set",
      );
    }
    return {
      state: "ready",
      byRunId: summarizePending(parsed),
    };
  } catch {
    return {
      state: "unavailable",
      byRunId: new Map(),
      warning:
        "重複確認ができませんでした(処理待ち要求が既にある可能性があります)。",
    };
  }
}

export async function guardPendingRequest(
  fetchRecords: FetchRecords,
  requestAppId: number | string,
  runId: string,
): Promise<PendingLoadResult> {
  return loadPendingRequests(fetchRecords, requestAppId, [runId]);
}

interface RequestField extends KintoneField {
  readonly value: string;
}

export interface CreateRequestBody {
  readonly app: number | string;
  readonly record: Readonly<{
    request_type: RequestField;
    reason: RequestField;
    run_id?: RequestField;
    rerun_from_node?: RequestField;
    network_id?: RequestField;
    business_key?: RequestField;
    scheduled_for?: RequestField;
  }>;
}

export interface RunRequestInput {
  readonly requestType: Exclude<RequestType, "START">;
  readonly runId: string;
  readonly reason: string;
  readonly rerunFromNode?: string | null;
}

export interface StartRequestInput {
  readonly requestType: "START";
  readonly networkId: string;
  readonly businessKey: string | null;
  readonly scheduledFor: string | null;
  readonly reason: string;
}

export type RequestInput = RunRequestInput | StartRequestInput;

export interface CreateRecordResponse {
  readonly id: string;
  readonly revision: string;
}

export type PostRecord = (
  request: CreateRequestBody,
) => Promise<CreateRecordResponse>;

function assertValue(value: string, field: string, maximum: number): void {
  if (value.trim() === "") {
    throw new KintoneRecordError(`${field} must not be blank`);
  }
  if (Array.from(value).length > maximum) {
    throw new KintoneRecordError(`${field} exceeds its value limit`);
  }
}

export function buildCreateRequestBody(
  requestAppId: number | string,
  input: RequestInput,
): CreateRequestBody {
  if (input.requestType === "START") {
    assertValue(input.networkId, "network_id", REQUEST_VALUE_LIMITS.networkId);
    assertValue(input.reason, "reason", REQUEST_VALUE_LIMITS.reason);
    if (input.businessKey !== null) {
      assertValue(
        input.businessKey,
        "business_key",
        REQUEST_VALUE_LIMITS.businessKey,
      );
    }
    return {
      app: requestAppId,
      record: {
        request_type: { value: "START" },
        network_id: { value: input.networkId },
        business_key: { value: input.businessKey ?? "" },
        scheduled_for: { value: input.scheduledFor ?? "" },
        reason: { value: input.reason },
      },
    };
  }
  assertValue(input.runId, "run_id", REQUEST_VALUE_LIMITS.runId);
  assertValue(input.reason, "reason", REQUEST_VALUE_LIMITS.reason);
  const rerunFromNode =
    input.rerunFromNode === undefined || input.rerunFromNode === null
      ? null
      : input.rerunFromNode.trim() === ""
        ? null
        : input.rerunFromNode;
  if (rerunFromNode !== null) {
    if (input.requestType !== "RERUN") {
      throw new KintoneRecordError("rerun_from_node is only allowed for RERUN");
    }
    assertValue(
      rerunFromNode,
      "rerun_from_node",
      REQUEST_VALUE_LIMITS.rerunFromNode,
    );
  }
  const record: {
    request_type: RequestField;
    run_id: RequestField;
    reason: RequestField;
    rerun_from_node?: RequestField;
  } = {
    request_type: { value: input.requestType },
    run_id: { value: input.runId },
    reason: { value: input.reason },
  };
  if (rerunFromNode !== null) {
    record.rerun_from_node = { value: rerunFromNode };
  }
  return { app: requestAppId, record };
}

const START_PENDING_BASE_QUERY =
  'request_type in ("START") and request_state in ("REQUESTED", "ACCEPTED")';
const START_PENDING_FIELDS = ["$id", "request_type", "request_state"] as const;
const START_GUARD_FIELDS = [
  "$id",
  "request_type",
  "request_state",
  "network_id",
  "business_key",
  "scheduled_for",
] as const;
const START_DONE_CANDIDATE_FIELDS = [
  "$id",
  "request_type",
  "request_state",
  "network_id",
  "business_key",
  "scheduled_for",
] as const;
const RUN_CANDIDATE_FIELDS = [
  "$id",
  "record_type",
  "network_id",
  "business_key",
  "as_of",
] as const;

export interface PendingStartSummary {
  readonly count: number;
  readonly oldestId: string | null;
}

export type PendingStartLoadResult =
  | { readonly state: "ready"; readonly summary: PendingStartSummary }
  | {
      readonly state: "unavailable";
      readonly summary: PendingStartSummary;
      readonly warning: string;
    };

export async function loadPendingStartRequests(
  fetchRecords: FetchRecords,
  requestAppId: number | string,
): Promise<PendingStartLoadResult> {
  try {
    const records = await readAllByKeyset(fetchRecords, {
      app: requestAppId,
      baseQuery: START_PENDING_BASE_QUERY,
      fields: START_PENDING_FIELDS,
    });
    const ids = records.map((record) => {
      requireLiteral(record, "request_type", ["START"] as const);
      requireLiteral(record, "request_state", [
        "REQUESTED",
        "ACCEPTED",
      ] as const);
      const id = requiredText(record, "$id");
      if (!/^[1-9][0-9]*$/.test(id)) {
        throw new KintoneRecordError("invalid pending START record ID");
      }
      return id;
    });
    return {
      state: "ready",
      summary: { count: ids.length, oldestId: ids[0] ?? null },
    };
  } catch {
    return {
      state: "unavailable",
      summary: { count: 0, oldestId: null },
      warning:
        "処理待ちのSTART要求件数を取得できませんでした。新規実行は利用できます。",
    };
  }
}

function startCandidateFromRequest(record: KintoneRecord): StartCandidate {
  requireLiteral(record, "request_type", ["START"] as const);
  return {
    networkId: requiredText(record, "network_id"),
    businessKey: nullableText(record, "business_key"),
    scheduledFor: nullableText(record, "scheduled_for"),
  };
}

function startCandidateFromRun(record: KintoneRecord): StartCandidate {
  requireLiteral(record, "record_type", ["NETWORK_RUN"] as const);
  return {
    networkId: requiredText(record, "network_id"),
    businessKey: nullableText(record, "business_key"),
    scheduledFor: nullableText(record, "as_of"),
  };
}

function guardConditions(key: StartGuardKey): readonly string[] {
  const conditions = [`network_id = ${quoteQueryValue(key.networkId)}`];
  if (key.mode !== "scheduled") {
    if (key.businessKey === null) {
      throw new KintoneRecordError("business_key is required for START guard");
    }
    conditions.push(`business_key = ${quoteQueryValue(key.businessKey)}`);
  }
  if (key.mode !== "explicit") {
    if (key.scheduledFor === null) {
      throw new KintoneRecordError("scheduled_for is required for START guard");
    }
    conditions.push(`scheduled_for = ${quoteQueryValue(key.scheduledFor)}`);
  }
  return conditions;
}

export type StartGuardResult =
  | { readonly state: "ready"; readonly matchingIds: readonly string[] }
  | {
      readonly state: "unavailable";
      readonly matchingIds: readonly string[];
      readonly warning: string;
    };

/** kintoneの文字列`=`がトークン一致する実測に備え、応答を完全一致で再判定する。 */
export async function guardPendingStartRequest(
  fetchRecords: FetchRecords,
  requestAppId: number | string,
  key: StartGuardKey,
): Promise<StartGuardResult> {
  try {
    const records = await readAllByKeyset(fetchRecords, {
      app: requestAppId,
      baseQuery: `${START_PENDING_BASE_QUERY} and ${guardConditions(key).join(" and ")}`,
      fields: START_GUARD_FIELDS,
    });
    const matchingIds = records
      .filter((record) => {
        requireLiteral(record, "request_type", ["START"] as const);
        requireLiteral(record, "request_state", [
          "REQUESTED",
          "ACCEPTED",
        ] as const);
        return matchesStartGuard(startCandidateFromRequest(record), key);
      })
      .map((record) => requiredText(record, "$id"));
    return { state: "ready", matchingIds };
  } catch {
    return {
      state: "unavailable",
      matchingIds: [],
      warning:
        "START要求の重複確認ができませんでした(同じ要求が処理待ちの可能性があります)。",
    };
  }
}

async function readCandidatePage(
  fetchRecords: FetchRecords,
  app: number | string,
  baseQuery: string,
  fields: readonly string[],
): Promise<readonly KintoneRecord[]> {
  const records: KintoneRecord[] = [];
  let lastId: string | null = null;
  while (records.length < START_CANDIDATE_LIMIT) {
    const keyset = lastId === null ? "" : ` and $id > ${lastId}`;
    const response = await fetchRecords({
      app,
      query: `${baseQuery}${keyset} order by $id asc limit ${START_CANDIDATE_PAGE_SIZE}`,
      fields: fields.includes("$id") ? fields : [...fields, "$id"],
    });
    if (response.records.length > START_CANDIDATE_PAGE_SIZE) {
      throw new KintoneRecordError("candidate page exceeds page size");
    }
    for (const record of response.records) {
      const id = requiredText(record, "$id");
      if (!/^[1-9][0-9]*$/.test(id)) {
        throw new KintoneRecordError("invalid candidate record ID");
      }
      if (lastId !== null && BigInt(id) <= BigInt(lastId)) {
        throw new KintoneRecordError("candidate keyset did not advance");
      }
      lastId = id;
      records.push(record);
    }
    if (response.records.length < START_CANDIDATE_PAGE_SIZE) break;
  }
  return records.slice(0, START_CANDIDATE_LIMIT);
}

export interface StartCandidateLoadResult {
  readonly requestHistory: StartCandidateGroupModel;
  readonly runHistory: StartCandidateGroupModel;
}

/** 2群は独立して取得し、一方の失敗で他方の候補を捨てない。 */
export async function loadStartCandidates(
  fetchRecords: FetchRecords,
  requestAppId: number | string,
  stateAppId: number | string,
): Promise<StartCandidateLoadResult> {
  const [requests, runs] = await Promise.allSettled([
    readCandidatePage(
      fetchRecords,
      requestAppId,
      'request_type in ("START") and request_state in ("DONE")',
      START_DONE_CANDIDATE_FIELDS,
    ),
    readCandidatePage(
      fetchRecords,
      stateAppId,
      'record_type in ("NETWORK_RUN")',
      RUN_CANDIDATE_FIELDS,
    ),
  ]);
  return {
    requestHistory:
      requests.status === "fulfilled"
        ? aggregateStartCandidates(
            "START要求実績(DONE)",
            requests.value.map((record) => {
              requireLiteral(record, "request_state", ["DONE"] as const);
              return startCandidateFromRequest(record);
            }),
          )
        : aggregateStartCandidates("START要求実績(DONE)", [], {
            unavailable: true,
          }),
    runHistory:
      runs.status === "fulfilled"
        ? aggregateStartCandidates(
            "Run実績",
            runs.value.map(startCandidateFromRun),
          )
        : aggregateStartCandidates("Run実績", [], { unavailable: true }),
  };
}

export function createStartRequest(
  dependencies: CreateRequestDependencies,
  input: NormalizedStartInput,
): Promise<RequestRecord> {
  return createRequest(dependencies, {
    requestType: "START",
    networkId: input.networkId,
    businessKey: input.businessKey,
    scheduledFor: input.scheduledFor,
    reason: input.reason,
  });
}

function isForbidden(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Readonly<Record<string, unknown>>;
  for (const property of ["status", "statusCode"] as const) {
    if (candidate[property] === 403) return true;
  }
  if ("response" in candidate) return isForbidden(candidate.response);
  return false;
}

export class RequestPostError extends Error {
  readonly kind: "forbidden" | "failed";

  constructor(kind: "forbidden" | "failed", cause: unknown) {
    super(
      kind === "forbidden"
        ? "操作要求アプリへの追加権限がありません。管理者へ連絡してください。"
        : "操作要求の作成に失敗しました。自動再試行は行いません。",
      { cause },
    );
    this.name = "RequestPostError";
    this.kind = kind;
  }
}

export function classifyRequestPostError(error: unknown): RequestPostError {
  return new RequestPostError(
    isForbidden(error) ? "forbidden" : "failed",
    error,
  );
}

export interface CreateRequestDependencies {
  readonly fetchRecords: FetchRecords;
  readonly postRecord: PostRecord;
  readonly requestAppId: number | string;
}

/** POSTは正確に1回だけ行い、作成レコードをGETして正本parserで検証する。 */
export async function createRequest(
  dependencies: CreateRequestDependencies,
  input: RequestInput,
): Promise<RequestRecord> {
  const body = buildCreateRequestBody(dependencies.requestAppId, input);
  let created: CreateRecordResponse;
  try {
    created = await dependencies.postRecord(body);
  } catch (error) {
    throw classifyRequestPostError(error);
  }
  if (!/^[1-9][0-9]*$/.test(created.id)) {
    throw new KintoneRecordError("POST response has invalid record ID");
  }
  const response = await dependencies.fetchRecords({
    app: dependencies.requestAppId,
    query: `$id = ${created.id} limit 1`,
    fields: REQUEST_READBACK_FIELDS,
  });
  if (response.records.length !== 1) {
    throw new KintoneRecordError(
      "created request readback must return one record",
    );
  }
  const parsed = parseRequestRecord({ ...response.records[0] });
  if (parsed.id !== created.id) {
    throw new KintoneRecordError("created request readback ID does not match");
  }
  return parsed;
}
