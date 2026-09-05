import {
  parseRequestRecord,
  REQUEST_VALUE_LIMITS,
  type RequestRecord,
  type RequestState,
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
  fieldValue,
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
  "$revision",
  "run_id",
  "network_id",
  "business_key",
  "scheduled_for",
  "request_type",
  "request_state",
  "作成者",
  "reason",
  "cancel_requested",
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
  "cancel_requested",
] as const;

export type PendingRequestTarget =
  | { readonly runId: string }
  | {
      readonly networkId: string;
      readonly businessKey: string | null;
      readonly scheduledFor: string | null;
    };

export interface PendingRequest {
  readonly id: string;
  readonly revision: string;
  readonly requestType: RequestType;
  readonly requestState: "REQUESTED" | "ACCEPTED";
  readonly creatorCode: string;
  readonly reason: string;
  readonly target: PendingRequestTarget;
  readonly cancelRequested: boolean;
}

export type PendingLoadResult =
  | {
      readonly state: "ready";
      readonly byRunId: ReadonlyMap<string, readonly PendingRequest[]>;
    }
  | {
      readonly state: "unavailable";
      readonly byRunId: ReadonlyMap<string, readonly PendingRequest[]>;
      readonly warning: string;
    };

function parseCreatorCode(record: KintoneRecord, context: string): string {
  const creator = fieldValue(record, "作成者");
  if (
    typeof creator !== "object" ||
    creator === null ||
    !("code" in creator) ||
    typeof creator.code !== "string" ||
    creator.code.trim() === ""
  ) {
    throw new KintoneRecordError(`invalid ${context} creator`);
  }
  return creator.code;
}

function parseCancelRequested(record: KintoneRecord): boolean {
  const value = fieldValue(record, "cancel_requested");
  if (
    !Array.isArray(value) ||
    value.length > 1 ||
    value.some((item) => item !== "取消")
  ) {
    throw new KintoneRecordError("invalid cancel_requested");
  }
  return value.length === 1;
}

function parseRunPendingRequest(record: KintoneRecord): PendingRequest {
  const id = requiredText(record, "$id");
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new KintoneRecordError("invalid pending request record ID");
  }
  const requestType = requireLiteral(record, "request_type", [
    "RERUN",
    "STOP",
    "RELEASE",
    "CLOSE",
  ] as const);
  return {
    id,
    revision: requiredText(record, "$revision"),
    requestType,
    requestState: requireLiteral(record, "request_state", [
      "REQUESTED",
      "ACCEPTED",
    ] as const),
    creatorCode: parseCreatorCode(record, "pending request"),
    reason: requiredText(record, "reason"),
    target: { runId: requiredText(record, "run_id") },
    cancelRequested: parseCancelRequested(record),
  };
}

function groupPendingByRun(
  records: readonly PendingRequest[],
): ReadonlyMap<string, readonly PendingRequest[]> {
  const grouped = new Map<string, PendingRequest[]>();
  for (const record of records) {
    if (!("runId" in record.target)) {
      throw new KintoneRecordError("pending Run request has no run_id target");
    }
    const group = grouped.get(record.target.runId) ?? [];
    group.push(record);
    grouped.set(record.target.runId, group);
  }
  for (const group of grouped.values()) {
    group.sort((left, right) =>
      BigInt(left.id) < BigInt(right.id)
        ? -1
        : BigInt(left.id) > BigInt(right.id)
          ? 1
          : 0,
    );
  }
  return grouped;
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
    const parsed = records.map(parseRunPendingRequest);
    const requestedRunIds = new Set(runIds);
    if (
      parsed.some(
        (record) =>
          !("runId" in record.target) ||
          !requestedRunIds.has(record.target.runId),
      )
    ) {
      throw new KintoneRecordError(
        "pending response contains a run_id outside the requested set",
      );
    }
    return {
      state: "ready",
      byRunId: groupPendingByRun(parsed),
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

export interface CancelRequestedBody {
  readonly app: number | string;
  readonly id: string;
  readonly revision: string;
  readonly record: Readonly<{
    cancel_requested: Readonly<{ value: readonly ["取消"] }>;
  }>;
}

export type PutCancelRequested = (
  app: number | string,
  id: string,
  revision: string,
) => Promise<unknown>;

export function buildCancelRequestedBody(
  app: number | string,
  id: string,
  revision: string,
): CancelRequestedBody {
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new KintoneRecordError("invalid request record ID");
  }
  if (!/^[1-9][0-9]*$/.test(revision)) {
    throw new KintoneRecordError("invalid request revision");
  }
  return {
    app,
    id,
    revision,
    record: { cancel_requested: { value: ["取消"] } },
  };
}

export function putCancelRequested(
  putRecord: (body: CancelRequestedBody) => Promise<unknown>,
  app: number | string,
  id: string,
  revision: string,
): Promise<unknown> {
  return putRecord(buildCancelRequestedBody(app, id, revision));
}

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
const START_PENDING_FIELDS = [
  "$id",
  "$revision",
  "request_type",
  "request_state",
  "network_id",
  "business_key",
  "scheduled_for",
  "reason",
  "作成者",
  "cancel_requested",
] as const;
export const START_TERMINAL_QUERY =
  'request_type in ("START") and request_state in ("DONE", "REJECTED") order by $id desc limit 10';
export const START_TERMINAL_FIELDS = [
  "$id",
  "request_state",
  "network_id",
  "business_key",
  "scheduled_for",
  "reason",
  "作成者",
  "作成日時",
  "result_code",
  "result_message",
] as const;
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
  readonly requests: readonly PendingStartRequest[];
}

export type PendingStartRequest = PendingRequest & {
  readonly requestType: "START";
  readonly target: Extract<
    PendingRequestTarget,
    { readonly networkId: string }
  >;
};

export interface TerminalStartRequest {
  readonly id: string;
  readonly requestState: "DONE" | "REJECTED";
  readonly networkId: string;
  readonly businessKey: string | null;
  readonly scheduledFor: string | null;
  readonly reason: string;
  readonly creatorName: string;
  readonly createdAt: string;
  readonly resultCode: string;
  readonly resultMessage: string | null;
}

export type TerminalStartLoadResult =
  | {
      readonly state: "ready";
      readonly requests: readonly TerminalStartRequest[];
    }
  | {
      readonly state: "unavailable";
      readonly requests: readonly TerminalStartRequest[];
      readonly warning: string;
    };

function parseCreatorName(record: KintoneRecord, context: string): string {
  const creator = fieldValue(record, "作成者");
  if (
    typeof creator !== "object" ||
    creator === null ||
    !("name" in creator) ||
    typeof creator.name !== "string" ||
    creator.name === ""
  ) {
    throw new KintoneRecordError(`invalid ${context} creator`);
  }
  return creator.name;
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
    const requests = records.map((record): PendingStartRequest => {
      const requestState = requireLiteral(record, "request_state", [
        "REQUESTED",
        "ACCEPTED",
      ] as const);
      const id = requiredText(record, "$id");
      if (!/^[1-9][0-9]*$/.test(id)) {
        throw new KintoneRecordError("invalid pending START record ID");
      }
      return {
        id,
        revision: requiredText(record, "$revision"),
        requestType: requireLiteral(record, "request_type", ["START"] as const),
        requestState,
        target: {
          networkId: requiredText(record, "network_id"),
          businessKey: nullableText(record, "business_key"),
          scheduledFor: nullableText(record, "scheduled_for"),
        },
        reason: requiredText(record, "reason"),
        creatorCode: parseCreatorCode(record, "pending START"),
        cancelRequested: parseCancelRequested(record),
      };
    });
    return {
      state: "ready",
      summary: {
        count: requests.length,
        oldestId: requests[0]?.id ?? null,
        requests,
      },
    };
  } catch {
    return {
      state: "unavailable",
      summary: { count: 0, oldestId: null, requests: [] },
      warning:
        "処理待ちのSTART要求件数を取得できませんでした。新規実行は利用できます。",
    };
  }
}

export async function loadTerminalStartRequests(
  fetchRecords: FetchRecords,
  requestAppId: number | string,
): Promise<TerminalStartLoadResult> {
  try {
    const response = await fetchRecords({
      app: requestAppId,
      query: START_TERMINAL_QUERY,
      fields: START_TERMINAL_FIELDS,
    });
    if (response.records.length > 10) {
      throw new KintoneRecordError("terminal START response exceeds limit 10");
    }
    return {
      state: "ready",
      requests: response.records.map((record): TerminalStartRequest => {
        const id = requiredText(record, "$id");
        if (!/^[1-9][0-9]*$/.test(id)) {
          throw new KintoneRecordError("invalid terminal START record ID");
        }
        return {
          id,
          requestState: requireLiteral(record, "request_state", [
            "DONE",
            "REJECTED",
          ] as const),
          networkId: requiredText(record, "network_id"),
          businessKey: nullableText(record, "business_key"),
          scheduledFor: nullableText(record, "scheduled_for"),
          reason: requiredText(record, "reason"),
          creatorName: parseCreatorName(record, "terminal START"),
          createdAt: requiredText(record, "作成日時"),
          resultCode: requiredText(record, "result_code"),
          resultMessage: nullableText(record, "result_message"),
        };
      }),
    };
  } catch {
    return {
      state: "unavailable",
      requests: [],
      warning:
        "最近の終了START要求を取得できませんでした。閲覧権限を確認してください。",
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

export interface CancellationSnapshot {
  readonly requestState: RequestState;
  readonly cancelRequested: boolean;
}

export async function getCancellationSnapshot(
  fetchRecords: FetchRecords,
  requestAppId: number | string,
  requestId: string,
): Promise<CancellationSnapshot> {
  if (!/^[1-9][0-9]*$/.test(requestId)) {
    throw new KintoneRecordError("invalid request record ID");
  }
  const response = await fetchRecords({
    app: requestAppId,
    query: `$id = ${requestId} limit 1`,
    fields: ["$id", "request_state", "cancel_requested"],
  });
  if (response.records.length !== 1) {
    throw new KintoneRecordError("cancel readback must return one record");
  }
  const record = response.records[0];
  if (record === undefined || requiredText(record, "$id") !== requestId) {
    throw new KintoneRecordError("cancel readback ID does not match");
  }
  return {
    requestState: requireLiteral(record, "request_state", [
      "REQUESTED",
      "ACCEPTED",
      "DONE",
      "REJECTED",
      "CANCELLED",
    ] as const),
    cancelRequested: parseCancelRequested(record),
  };
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
