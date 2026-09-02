import { REQUEST_VALUE_LIMITS } from "../../src/requests/request-model.js";
import { KintoneRecordError } from "./kintone-record.js";

export const START_CANDIDATE_LIMIT = 500;
export const START_CANDIDATE_PAGE_SIZE = 100;

export const START_INPUT_MODES = [
  "scheduled",
  "correction",
  "explicit",
] as const;
export type StartInputMode = (typeof START_INPUT_MODES)[number];

export const START_MODE_LABELS: Readonly<Record<StartInputMode, string>> = {
  scheduled: "定期キー(対象期間のみ)",
  correction: "補正(補正キー+対象期間)",
  explicit: "explicit(業務キーのみ)",
};

export interface StartFormInput {
  readonly mode: StartInputMode;
  readonly networkId: string;
  readonly businessKey: string;
  readonly scheduledForLocal: string;
  readonly reason: string;
}

export interface NormalizedStartInput {
  readonly mode: StartInputMode;
  readonly networkId: string;
  readonly businessKey: string | null;
  readonly scheduledFor: string | null;
  readonly reason: string;
}

export interface StartGuardKey {
  readonly mode: StartInputMode;
  readonly networkId: string;
  readonly businessKey: string | null;
  readonly scheduledFor: string | null;
}

export interface StartCandidate {
  readonly networkId: string;
  readonly businessKey: string | null;
  readonly scheduledFor: string | null;
}

export interface StartCandidateGroupModel {
  readonly state: "ready" | "unavailable";
  readonly label: string;
  readonly items: readonly StartCandidate[];
  readonly limitReached: boolean;
  readonly note: string | null;
  readonly warning: string | null;
}

function assertText(value: string, field: string, maximum: number): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new KintoneRecordError(`${field}を入力してください。`);
  }
  if (Array.from(trimmed).length > maximum) {
    throw new KintoneRecordError(`${field}が長すぎます。`);
  }
  return trimmed;
}

/** datetime-localを日本標準時(+09:00)として解釈し、kintone保存値と同じUTC ISOへする。 */
export function normalizeJstDatetimeLocal(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value,
  );
  if (match === null) {
    throw new KintoneRecordError("対象期間は日時まで入力してください。");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? "0");
  const wallClock = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second),
  );
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) {
    throw new KintoneRecordError("対象期間に実在する日時を入力してください。");
  }
  // kintoneのDATETIMEは分精度(秒なし)で、APIは"…T15:00:00Z"形式(秒は常に
  // 00)を返す。秒・ミリ秒が残るとPOST値と保存値が食い違い、重複ガードの
  // 一致とクエリの両方が壊れるため、kintoneの保存挙動と同じく分へ切り捨てた
  // 正準形式でPOST・クエリ・比較のすべてを揃える。
  const utc = new Date(wallClock.getTime() - 9 * 60 * 60 * 1_000);
  utc.setUTCSeconds(0, 0);
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * kintone保存値とフォーム正規化値の表現ゆれ(ミリ秒有無・オフセット表記)に
 * 頑健な時刻同値比較。パース不能な値は文字列一致へフォールバックする。
 */
export function sameScheduledInstant(
  a: string | null,
  b: string | null,
): boolean {
  if (a === null || b === null) return a === b;
  const parsedA = Date.parse(a);
  const parsedB = Date.parse(b);
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return a === b;
  return parsedA === parsedB;
}

export function normalizeStartFormInput(
  input: StartFormInput,
): NormalizedStartInput {
  const networkId = assertText(
    input.networkId,
    "network_id",
    REQUEST_VALUE_LIMITS.networkId,
  );
  const reason = assertText(input.reason, "理由", REQUEST_VALUE_LIMITS.reason);
  const needsBusinessKey = input.mode !== "scheduled";
  const needsScheduledFor = input.mode !== "explicit";
  return {
    mode: input.mode,
    networkId,
    businessKey: needsBusinessKey
      ? assertText(
          input.businessKey,
          "business_key",
          REQUEST_VALUE_LIMITS.businessKey,
        )
      : null,
    scheduledFor: needsScheduledFor
      ? normalizeJstDatetimeLocal(input.scheduledForLocal)
      : null,
    reason,
  };
}

export function startGuardKey(input: NormalizedStartInput): StartGuardKey {
  return {
    mode: input.mode,
    networkId: input.networkId,
    businessKey: input.businessKey,
    scheduledFor: input.scheduledFor,
  };
}

export function matchesStartGuard(
  candidate: StartCandidate,
  key: StartGuardKey,
): boolean {
  if (candidate.networkId !== key.networkId) return false;
  if (key.mode === "explicit") {
    return candidate.businessKey === key.businessKey;
  }
  if (key.mode === "scheduled") {
    return sameScheduledInstant(candidate.scheduledFor, key.scheduledFor);
  }
  return (
    candidate.businessKey === key.businessKey &&
    sameScheduledInstant(candidate.scheduledFor, key.scheduledFor)
  );
}

export function aggregateStartCandidates(
  label: string,
  candidates: readonly StartCandidate[],
  options: { readonly unavailable?: boolean; readonly warning?: string } = {},
): StartCandidateGroupModel {
  if (options.unavailable === true) {
    return {
      state: "unavailable",
      label,
      items: [],
      limitReached: false,
      note: null,
      warning:
        options.warning ?? "候補を取得できませんでした。自由入力できます。",
    };
  }
  const unique = new Map<string, StartCandidate>();
  for (const candidate of candidates.slice(0, START_CANDIDATE_LIMIT)) {
    const key = JSON.stringify([
      candidate.networkId,
      candidate.businessKey,
      candidate.scheduledFor,
    ]);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const limitReached = candidates.length >= START_CANDIDATE_LIMIT;
  return {
    state: "ready",
    label,
    items: [...unique.values()],
    limitReached,
    note: limitReached
      ? `取得上限${START_CANDIDATE_LIMIT}件に達したため、候補が欠けている場合があります。`
      : null,
    warning: null,
  };
}

export function startCandidateDisplay(candidate: StartCandidate): string {
  return [candidate.networkId, candidate.businessKey, candidate.scheduledFor]
    .filter((value): value is string => value !== null && value !== "")
    .join(" / ");
}
