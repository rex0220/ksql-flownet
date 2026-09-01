import type { NetworkRunStatus } from "../../src/domain/persistence-model.js";
import type { RunActivity } from "../../src/orchestration/run-activity.js";

export type BoardRequestAction = "RERUN" | "STOP" | "RELEASE";
export type ActionMatrixValue =
  BoardRequestAction | "NONE" | "UNKNOWN" | "INVALID";

export interface PendingActionSummary {
  readonly oldestId: string;
  readonly count: number;
  readonly label: string;
}

export interface DecideBoardActionOptions {
  readonly status: NetworkRunStatus;
  readonly activity: RunActivity | null;
  readonly resumeAllowed: boolean;
  readonly lifecycleStatus: "ACTIVE" | "ARCHIVED";
  readonly pending?: PendingActionSummary | null;
  readonly judgementError?: boolean;
}

export type BoardActionViewModel =
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "pending";
      readonly pending: PendingActionSummary;
      readonly secondaryNotice: string | null;
      readonly copyRunId: boolean;
    }
  | { readonly kind: "disabled"; readonly message: string }
  | { readonly kind: "action"; readonly action: BoardRequestAction }
  | { readonly kind: "none" }
  | {
      readonly kind: "unknown";
      readonly message: string;
      readonly copyRunId: true;
    };

const INVALID_MESSAGE =
  "状態を安全に判定できません。CLI statusを正として確認してください。";
const UNKNOWN_MESSAGE = "二次対応者へ連絡してください。";

const MATRIX: Readonly<
  Record<NetworkRunStatus, Readonly<Record<string, ActionMatrixValue>>>
> = {
  CREATED: {
    null: "INVALID",
    IDLE: "NONE",
    LIVE: "STOP",
    STOPPED: "RELEASE",
    INTERRUPTED: "RERUN",
  },
  RUNNING: {
    null: "INVALID",
    IDLE: "NONE",
    LIVE: "STOP",
    STOPPED: "RELEASE",
    INTERRUPTED: "RERUN",
  },
  SUCCESS: {
    null: "NONE",
    IDLE: "INVALID",
    LIVE: "INVALID",
    STOPPED: "INVALID",
    INTERRUPTED: "INVALID",
  },
  FAILED: {
    null: "RERUN",
    IDLE: "INVALID",
    LIVE: "INVALID",
    STOPPED: "INVALID",
    INTERRUPTED: "INVALID",
  },
  CANCELLED: {
    null: "RERUN",
    IDLE: "INVALID",
    LIVE: "INVALID",
    STOPPED: "INVALID",
    INTERRUPTED: "INVALID",
  },
  UNKNOWN: {
    null: "UNKNOWN",
    IDLE: "INVALID",
    LIVE: "INVALID",
    STOPPED: "INVALID",
    INTERRUPTED: "INVALID",
  },
};

export function matrixAction(
  status: NetworkRunStatus,
  activity: RunActivity | null,
): ActionMatrixValue {
  const row = MATRIX[status];
  if (row === undefined) return "INVALID";
  return row[activity === null ? "null" : activity] ?? "INVALID";
}

/** ボードと詳細画面で共有する唯一のaction表示判定。 */
export function decideBoardAction(
  options: DecideBoardActionOptions,
): BoardActionViewModel {
  const matrix = matrixAction(options.status, options.activity);
  if (options.judgementError === true || matrix === "INVALID") {
    return { kind: "invalid", message: INVALID_MESSAGE };
  }
  if (options.pending !== undefined && options.pending !== null) {
    return {
      kind: "pending",
      pending: options.pending,
      secondaryNotice: matrix === "UNKNOWN" ? UNKNOWN_MESSAGE : null,
      copyRunId: matrix === "UNKNOWN",
    };
  }
  if (
    matrix === "RERUN" &&
    (!options.resumeAllowed || options.lifecycleStatus !== "ACTIVE")
  ) {
    return { kind: "disabled", message: "再開が無効化されています。" };
  }
  if (matrix === "NONE") return { kind: "none" };
  if (matrix === "UNKNOWN") {
    return { kind: "unknown", message: UNKNOWN_MESSAGE, copyRunId: true };
  }
  return { kind: "action", action: matrix };
}
