import type { NetworkRunStatus } from "../../src/domain/persistence-model.js";
import type { CancelActionDetails } from "./activity-input.js";
import type {
  BoardActionViewModel,
  BoardRequestAction,
} from "./board-action.js";
import type { RunActivity } from "./activity-entry.js";
import type { ErrorSummary, ErrorSummaryItem } from "./error-summary.js";
import type {
  PendingStartRequest,
  PendingRequest,
  TerminalStartRequest,
} from "./request-client.js";
import type { RecentTerminalRun } from "./terminal-run-loader.js";

export interface ActionRowViewModel {
  readonly runId: string;
  readonly recordId: string;
  readonly recordUrl: string;
  readonly businessKey: string;
  readonly status: NetworkRunStatus;
  readonly updatedAt: string;
  readonly activity: RunActivity | null;
  readonly resumeAllowed: boolean;
  readonly lifecycleStatus: "ACTIVE" | "ARCHIVED";
  readonly action: BoardActionViewModel;
  readonly actionError: string | null;
  readonly cancelDetails: CancelActionDetails | null;
  readonly errorSummary: ErrorSummary;
}

export interface ActivityRowViewModel extends ActionRowViewModel {
  readonly startedAt: string | null;
  readonly evidence: string;
  readonly actionText: string;
  readonly judgedAt: number;
  readonly error: string | null;
}

export type TerminalRowViewModel = ActionRowViewModel;

export interface BoardSectionViewModel<T> {
  readonly state: "ready" | "error";
  readonly rows: readonly T[];
  readonly error: string | null;
}

export interface BoardViewModel {
  readonly activeSection: BoardSectionViewModel<ActivityRowViewModel>;
  readonly attentionSection: BoardSectionViewModel<TerminalRowViewModel>;
  readonly attentionRemainingCount: number;
  readonly pendingWarning: string | null;
  readonly pendingStartCount: number | null;
  readonly pendingStartRequests: readonly PendingStartRequest[] | null;
  readonly terminalStartRequests: readonly TerminalStartRequest[] | null;
  readonly recentTerminalRuns: readonly RecentTerminalRun[] | null;
  readonly stateAppId: string;
  readonly requestEnabled: boolean;
  readonly requestAppId: string | null;
  readonly loginUserCode: string;
  readonly judgedAt: number;
  /** P2-08の公開単体契約との互換値。 */
  readonly state: "ready" | "error";
  readonly rows: readonly ActivityRowViewModel[];
  readonly error: string | null;
}

export type DetailViewModel =
  | {
      readonly state: "ready";
      readonly row: ActivityRowViewModel | TerminalRowViewModel;
      readonly terminal: boolean;
      readonly requestEnabled: boolean;
      readonly requestAppId: string | null;
      readonly allowRerunFromNode: boolean;
    }
  | { readonly state: "error"; readonly error: string };

export interface ActionTarget {
  readonly action: BoardRequestAction;
  readonly runId: string;
  readonly allowRerunFromNode: boolean;
  readonly interrupted: boolean;
  readonly cancelDetails: CancelActionDetails | null;
  readonly terminal: boolean;
}

export interface RenderCallbacks {
  readonly onReload: () => void;
  readonly onStart?: () => void;
  readonly onAction?: (target: ActionTarget) => void;
  readonly onCancelRequest?: (request: PendingRequest) => void;
  readonly onCopyRunId?: (runId: string, button: HTMLButtonElement) => void;
}

export const ACTION_TEXT: Readonly<Record<RunActivity, string>> = {
  LIVE: "待つ(触らない)",
  IDLE: "定期起動を待つ",
  STOPPED: "止めた本人に確認。解除はRELEASE要求",
  INTERRUPTED: "二次対応者へ連絡(Run IDを添えて)",
};

const ACTION_LABEL: Readonly<Record<BoardRequestAction, string>> = {
  RERUN: "リラン要求",
  STOP: "停止要求",
  RELEASE: "解除要求",
  CLOSE: "クローズ要求",
};

const MAX_DISPLAY_LENGTH = 160;

export function limitDisplayValue(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_DISPLAY_LENGTH) return value;
  return `${characters.slice(0, MAX_DISPLAY_LENGTH).join("")}…`;
}

/** ISO日時をJST(ja-JP、分まで)で表示する。不正値は原文のまま。 */
export function formatLocalDateTime(value: string): string {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return value;
  return new Date(milliseconds).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

function element(
  pageDocument: Document,
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node = pageDocument.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = limitDisplayValue(text);
  return node;
}

function badge(pageDocument: Document, activity: RunActivity): HTMLElement {
  return element(
    pageDocument,
    "span",
    `ksql-flownet-badge ksql-flownet-badge--${activity.toLowerCase()}`,
    activity,
  );
}

function statusBadge(
  pageDocument: Document,
  status: "SUCCESS" | "DONE" | "REJECTED",
): HTMLElement {
  return element(
    pageDocument,
    "span",
    `ksql-flownet-status ksql-flownet-status--${status.toLowerCase()}`,
    status,
  );
}

function activityCell(
  pageDocument: Document,
  row: ActivityRowViewModel,
): HTMLElement {
  const cell = element(pageDocument, "td");
  if (row.error !== null) {
    cell.append(
      element(pageDocument, "span", "ksql-flownet-error", "判定不能"),
    );
  } else if (row.activity !== null) {
    cell.append(badge(pageDocument, row.activity));
  }
  return cell;
}

function requestLink(
  pageDocument: Document,
  requestAppId: string,
  requestId: string,
  label: string,
): HTMLAnchorElement {
  const link = pageDocument.createElement("a");
  link.className = "ksql-flownet-pending";
  link.textContent = limitDisplayValue(label);
  link.setAttribute("href", `/k/${requestAppId}/show#record=${requestId}`);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  return link;
}

function copyButton(
  pageDocument: Document,
  runId: string,
  callback?: RenderCallbacks["onCopyRunId"],
): HTMLButtonElement {
  const button = element(
    pageDocument,
    "button",
    "ksql-flownet-copy",
    "Run IDをコピー",
  ) as HTMLButtonElement;
  button.type = "button";
  button.addEventListener("click", () => {
    if (callback !== undefined) {
      callback(runId, button);
      return;
    }
    void copyRunId(pageDocument, runId).then((copied) => {
      button.textContent = copied ? "コピーしました" : "コピーできませんでした";
    });
  });
  return button;
}

export async function copyRunId(
  pageDocument: Document,
  runId: string,
): Promise<boolean> {
  try {
    const clipboard = pageDocument.defaultView?.navigator.clipboard;
    if (clipboard !== undefined) {
      await clipboard.writeText(runId);
      return true;
    }
    const textarea = pageDocument.createElement("textarea");
    textarea.value = runId;
    textarea.setAttribute("readonly", "");
    pageDocument.body.append(textarea);
    textarea.select();
    const copied = pageDocument.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function actionContent(
  pageDocument: Document,
  row: ActionRowViewModel,
  requestEnabled: boolean,
  requestAppId: string | null,
  callbacks: RenderCallbacks,
  allowRerunFromNode: boolean,
  loginUserCode: string,
): HTMLElement {
  const content = element(pageDocument, "div", "ksql-flownet-action-cell");
  switch (row.action.kind) {
    case "invalid":
      content.append(
        element(pageDocument, "span", "ksql-flownet-error", "判定不能"),
        element(
          pageDocument,
          "span",
          "ksql-flownet-error-detail",
          row.actionError ?? row.action.message,
        ),
      );
      break;
    case "pending":
      for (const pending of row.action.pending) {
        const pendingRow = element(pageDocument, "div", "ksql-flownet-pending");
        const label = `#${pending.id} ${pending.requestType} / ${pending.requestState}`;
        pendingRow.append(
          requestAppId === null
            ? element(pageDocument, "span", undefined, label)
            : requestLink(pageDocument, requestAppId, pending.id, label),
          element(
            pageDocument,
            "span",
            undefined,
            `起票者: ${pending.creatorCode} / 理由: ${pending.reason}`,
          ),
        );
        if (
          pending.requestState === "REQUESTED" &&
          pending.creatorCode === loginUserCode &&
          callbacks.onCancelRequest !== undefined
        ) {
          const cancel = element(
            pageDocument,
            "button",
            "ksql-flownet-action",
            "取消",
          ) as HTMLButtonElement;
          cancel.type = "button";
          cancel.addEventListener("click", () =>
            callbacks.onCancelRequest?.(pending),
          );
          pendingRow.append(cancel);
        }
        content.append(pendingRow);
      }
      if (row.action.secondaryNotice !== null) {
        content.append(
          element(pageDocument, "span", undefined, row.action.secondaryNotice),
        );
      }
      if (row.action.copyRunId) {
        content.append(
          copyButton(pageDocument, row.runId, callbacks.onCopyRunId),
        );
      }
      break;
    case "disabled":
      content.append(
        element(
          pageDocument,
          "span",
          "ksql-flownet-disabled",
          row.action.message,
        ),
      );
      break;
    case "actions":
      if (requestEnabled && callbacks.onAction !== undefined) {
        for (const action of row.action.actions) {
          const button = element(
            pageDocument,
            "button",
            "ksql-flownet-action",
            ACTION_LABEL[action],
          ) as HTMLButtonElement;
          button.type = "button";
          button.addEventListener("click", () =>
            callbacks.onAction?.({
              action,
              runId: row.runId,
              allowRerunFromNode,
              interrupted: row.activity === "INTERRUPTED",
              cancelDetails: row.cancelDetails,
              terminal: row.status === "FAILED" || row.status === "CANCELLED",
            }),
          );
          content.append(button);
        }
      }
      break;
    case "unknown":
      content.append(
        element(pageDocument, "span", undefined, row.action.message),
        copyButton(pageDocument, row.runId, callbacks.onCopyRunId),
      );
      if (row.action.holdNotice !== null) {
        content.append(
          element(pageDocument, "span", undefined, row.action.holdNotice),
        );
      }
      break;
    case "none":
      break;
  }
  return content;
}

function recordCell(
  pageDocument: Document,
  row: ActionRowViewModel,
): HTMLElement {
  const link = pageDocument.createElement("a");
  link.textContent = row.recordId;
  link.setAttribute("href", row.recordUrl);
  // レコード番号は別タブで詳細を開く(2026-09-01ユーザー要望)
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  const cell = element(pageDocument, "td", "ksql-flownet-record-cell");
  cell.append(link);
  return cell;
}

function tableHeader(
  pageDocument: Document,
  labels: readonly string[],
  lastIsOperation = true,
): HTMLElement {
  const thead = element(pageDocument, "thead");
  const header = element(pageDocument, "tr");
  labels.forEach((label, index) => {
    const className =
      index === 0
        ? "ksql-flownet-record-cell"
        : lastIsOperation && index === labels.length - 1
          ? "ksql-flownet-operation-cell"
          : undefined;
    header.append(element(pageDocument, "th", className, label));
  });
  thead.append(header);
  return thead;
}

function renderActiveTable(
  pageDocument: Document,
  rows: readonly ActivityRowViewModel[],
  model: BoardViewModel,
  callbacks: RenderCallbacks,
): HTMLElement {
  const table = element(pageDocument, "table", "ksql-flownet-table");
  const thead = tableHeader(pageDocument, [
    "レコード",
    "業務キー",
    "Run ID",
    "状態",
    "アクティビティ",
    "開始時刻",
    "根拠・一次対応",
    "操作",
  ]);
  const tbody = element(pageDocument, "tbody");
  for (const row of rows) {
    const tr = element(pageDocument, "tr");
    const actionCell = element(
      pageDocument,
      "td",
      "ksql-flownet-operation-cell",
    );
    actionCell.append(
      actionContent(
        pageDocument,
        row,
        model.requestEnabled,
        model.requestAppId,
        callbacks,
        false,
        model.loginUserCode,
      ),
    );
    tr.append(
      recordCell(pageDocument, row),
      element(pageDocument, "td", undefined, row.businessKey),
      element(pageDocument, "td", undefined, row.runId),
      element(pageDocument, "td", "ksql-flownet-cell-nowrap", row.status),
      activityCell(pageDocument, row),
      element(
        pageDocument,
        "td",
        "ksql-flownet-cell-nowrap",
        row.startedAt === null ? "未開始" : formatLocalDateTime(row.startedAt),
      ),
      element(
        pageDocument,
        "td",
        row.error === null ? undefined : "ksql-flownet-error-detail",
        row.error ?? [row.evidence, row.actionText].filter(Boolean).join(" / "),
      ),
      actionCell,
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function startKeyAndSchedule(
  row: PendingStartRequest | TerminalStartRequest,
): string {
  const businessKey =
    "target" in row ? row.target.businessKey : row.businessKey;
  const scheduledFor =
    "target" in row ? row.target.scheduledFor : row.scheduledFor;
  return [
    businessKey === null ? null : `業務キー: ${businessKey}`,
    scheduledFor === null
      ? null
      : `対象日時: ${formatLocalDateTime(scheduledFor)}`,
  ]
    .filter((value): value is string => value !== null)
    .join(" / ");
}

function renderStartRequestTable(
  pageDocument: Document,
  pendingRows: readonly PendingStartRequest[],
  terminalRows: readonly TerminalStartRequest[],
  requestAppId: string,
  loginUserCode: string,
  callbacks: RenderCallbacks,
): HTMLElement {
  const table = element(
    pageDocument,
    "table",
    "ksql-flownet-table ksql-flownet-start-request-table",
  );
  const thead = tableHeader(
    pageDocument,
    [
      "レコード",
      "状態",
      "network_id",
      "業務キー / 対象日時",
      "起票者",
      "理由",
      "結果",
    ],
    false,
  );
  const tbody = element(pageDocument, "tbody");
  for (const row of [...pendingRows, ...terminalRows]) {
    const tr = element(pageDocument, "tr");
    if (row.requestState === "DONE" || row.requestState === "REJECTED") {
      tr.className =
        row === terminalRows[0] && pendingRows.length > 0
          ? "ksql-flownet-start-request-terminal-row ksql-flownet-start-request-terminal-row--first"
          : "ksql-flownet-start-request-terminal-row";
    }
    const record = element(pageDocument, "td", "ksql-flownet-record-cell");
    record.append(
      requestLink(pageDocument, requestAppId, row.id, `#${row.id} START`),
    );
    tr.append(
      record,
      (() => {
        const stateCell = element(
          pageDocument,
          "td",
          "ksql-flownet-cell-nowrap",
        );
        stateCell.append(
          row.requestState === "DONE" || row.requestState === "REJECTED"
            ? statusBadge(pageDocument, row.requestState)
            : element(pageDocument, "span", undefined, row.requestState),
        );
        return stateCell;
      })(),
      element(
        pageDocument,
        "td",
        undefined,
        "target" in row ? row.target.networkId : row.networkId,
      ),
      element(pageDocument, "td", undefined, startKeyAndSchedule(row)),
      element(
        pageDocument,
        "td",
        undefined,
        "creatorCode" in row
          ? row.creatorCode
          : `${row.creatorName} / ${formatLocalDateTime(row.createdAt)}`,
      ),
      element(
        pageDocument,
        "td",
        "ksql-flownet-start-request-reason",
        row.reason,
      ),
      element(
        pageDocument,
        "td",
        "ksql-flownet-start-request-result",
        "resultCode" in row
          ? [row.resultCode, row.resultMessage].filter(Boolean).join(" / ")
          : "—",
      ),
    );
    if (
      "creatorCode" in row &&
      row.requestState === "REQUESTED" &&
      row.creatorCode === loginUserCode &&
      callbacks.onCancelRequest !== undefined
    ) {
      const cancel = element(
        pageDocument,
        "button",
        "ksql-flownet-action",
        "取消",
      ) as HTMLButtonElement;
      cancel.type = "button";
      cancel.addEventListener("click", () => callbacks.onCancelRequest?.(row));
      record.append(cancel);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function renderRecentTerminalRunTable(
  pageDocument: Document,
  rows: readonly RecentTerminalRun[],
  stateAppId: string,
): HTMLElement {
  const table = element(pageDocument, "table", "ksql-flownet-table");
  const thead = tableHeader(
    pageDocument,
    ["レコード", "状態", "network_id", "業務キー", "対象日時", "更新時刻"],
    false,
  );
  const tbody = element(pageDocument, "tbody");
  for (const row of rows) {
    const record = element(pageDocument, "td", "ksql-flownet-record-cell");
    const link = pageDocument.createElement("a");
    link.textContent = `#${row.recordId}`;
    link.setAttribute("href", `/k/${stateAppId}/show#record=${row.recordId}`);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    record.append(link);
    const stateCell = element(pageDocument, "td", "ksql-flownet-cell-nowrap");
    stateCell.append(
      row.status === "SUCCESS"
        ? statusBadge(pageDocument, "SUCCESS")
        : element(pageDocument, "span", undefined, row.status),
    );
    const tr = element(pageDocument, "tr");
    tr.append(
      record,
      stateCell,
      element(pageDocument, "td", undefined, row.networkId),
      element(pageDocument, "td", undefined, row.businessKey),
      element(
        pageDocument,
        "td",
        "ksql-flownet-cell-nowrap",
        row.asOf === null ? "—" : formatLocalDateTime(row.asOf),
      ),
      element(
        pageDocument,
        "td",
        "ksql-flownet-cell-nowrap",
        formatLocalDateTime(row.updatedAt),
      ),
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function renderTerminalTable(
  pageDocument: Document,
  rows: readonly TerminalRowViewModel[],
  model: BoardViewModel,
  callbacks: RenderCallbacks,
): HTMLElement {
  const table = element(pageDocument, "table", "ksql-flownet-table");
  const thead = tableHeader(pageDocument, [
    "レコード",
    "業務キー",
    "Run ID",
    "状態",
    "エラー概要",
    "更新時刻",
    "操作",
  ]);
  const tbody = element(pageDocument, "tbody");
  for (const row of rows) {
    const errorSummary = row.errorSummary ?? {
      state: "ready" as const,
      items: [],
    };
    const tr = element(pageDocument, "tr");
    const actionCell = element(
      pageDocument,
      "td",
      "ksql-flownet-operation-cell",
    );
    actionCell.append(
      actionContent(
        pageDocument,
        row,
        model.requestEnabled,
        model.requestAppId,
        callbacks,
        false,
        model.loginUserCode,
      ),
    );
    tr.append(
      recordCell(pageDocument, row),
      element(pageDocument, "td", undefined, row.businessKey),
      element(pageDocument, "td", undefined, row.runId),
      element(pageDocument, "td", "ksql-flownet-cell-nowrap", row.status),
      element(
        pageDocument,
        "td",
        errorSummary.state === "unavailable"
          ? "ksql-flownet-error-detail ksql-flownet-cell-nowrap"
          : "ksql-flownet-cell-nowrap",
        formatErrorSummaryLine(errorSummary),
      ),
      element(
        pageDocument,
        "td",
        "ksql-flownet-cell-nowrap",
        formatLocalDateTime(row.updatedAt),
      ),
      actionCell,
    );
    tbody.append(tr);
    // エラー本文はメイン行に入れず全幅のサブ行で折り返し表示する
    // (1セルに長文を入れると表全体が崩れる — 2026-09-01実機フィードバック)
    const message = errorSummaryMessage(errorSummary);
    if (message !== null) {
      const messageRow = element(
        pageDocument,
        "tr",
        "ksql-flownet-error-message-row",
      );
      const messageCell = element(
        pageDocument,
        "td",
        "ksql-flownet-error-message-cell",
        message,
      );
      messageCell.setAttribute("colspan", "7");
      messageRow.append(messageCell);
      tbody.append(messageRow);
    }
  }
  table.append(thead, tbody);
  return table;
}

function classificationText(item: ErrorSummaryItem): string {
  // status_reasonがresult_codeと同値なら重複表示しない(2026-09-01実機フィードバック)
  const reason =
    item.statusReason === null || item.statusReason === item.resultCode
      ? ""
      : ` / ${item.statusReason}`;
  return `${item.nodeId}: ${item.resultCode}${reason}`;
}

function errorSummaryItemText(item: ErrorSummaryItem): string {
  if (typeof item.errorMessage === "string") {
    return `${item.nodeId}: ${item.resultCode} — ${item.errorMessage}`;
  }
  return classificationText(item);
}

/** ボードのエラー概要セル用: 分類のみ(本文はサブ行で表示)。 */
export function formatErrorSummaryLine(summary: ErrorSummary): string {
  if (summary.state === "unavailable") {
    return "(エラー概要を取得できません)";
  }
  const first = summary.items[0];
  if (first === undefined) return "—";
  const remaining = summary.items.length - 1;
  return limitDisplayValue(
    `${classificationText(first)}${remaining === 0 ? "" : ` / 他${remaining} node`}`,
  );
}

/** サブ行に出すエラー本文(先頭ノード分)。無ければnull。 */
export function errorSummaryMessage(summary: ErrorSummary): string | null {
  if (summary.state === "unavailable") return null;
  const first = summary.items[0];
  if (first === undefined || typeof first.errorMessage !== "string")
    return null;
  return limitDisplayValue(`${first.nodeId}: ${first.errorMessage}`);
}

function renderDetailErrorSummary(
  pageDocument: Document,
  summary: ErrorSummary,
): HTMLElement {
  const box = element(pageDocument, "div", "ksql-flownet-error-summary");
  box.append(element(pageDocument, "strong", undefined, "エラー概要"));
  if (summary.state === "unavailable") {
    box.append(
      element(
        pageDocument,
        "span",
        "ksql-flownet-error-detail",
        "(エラー概要を取得できません)",
      ),
    );
    return box;
  }
  if (summary.items.length === 0) {
    box.append(element(pageDocument, "span", undefined, "該当情報なし"));
    return box;
  }
  const list = element(pageDocument, "ul");
  for (const item of summary.items.slice(0, 3)) {
    const row = element(pageDocument, "li");
    if (typeof item.errorMessage === "string") {
      row.append(
        element(
          pageDocument,
          "span",
          undefined,
          `${item.nodeId}: ${item.resultCode} — `,
        ),
        element(pageDocument, "span", undefined, item.errorMessage),
      );
    } else {
      row.textContent = limitDisplayValue(errorSummaryItemText(item));
    }
    list.append(row);
  }
  box.append(list);
  return box;
}

function sectionError(
  pageDocument: Document,
  message: string | null,
): HTMLElement {
  const box = element(pageDocument, "div", "ksql-flownet-section-error");
  box.append(
    element(pageDocument, "span", "ksql-flownet-error", "読込失敗(判定不能)"),
    element(
      pageDocument,
      "span",
      "ksql-flownet-error-detail",
      message ?? "読込に失敗しました。",
    ),
  );
  return box;
}

function replaceChildren(root: HTMLElement, child: HTMLElement): void {
  root.replaceChildren(child);
}

export function renderBoardLoading(root: HTMLElement): void {
  replaceChildren(
    root,
    element(root.ownerDocument, "p", "ksql-flownet-loading", "読込中…"),
  );
}

function normalizeCallbacks(
  callbacksOrReload: RenderCallbacks | (() => void),
): RenderCallbacks {
  return typeof callbacksOrReload === "function"
    ? { onReload: callbacksOrReload }
    : callbacksOrReload;
}

function normalizeLegacyModel(model: BoardViewModel): BoardViewModel {
  if (model.activeSection !== undefined) {
    return {
      ...model,
      pendingStartCount: model.pendingStartCount ?? null,
      pendingStartRequests: model.pendingStartRequests ?? null,
      terminalStartRequests:
        model.terminalStartRequests ??
        (model.pendingStartRequests === null ? null : []),
      recentTerminalRuns: model.recentTerminalRuns ?? null,
      stateAppId: model.stateAppId ?? "",
      loginUserCode: model.loginUserCode ?? "",
    };
  }
  const legacy = model as unknown as {
    state: "ready" | "error";
    rows: readonly ActivityRowViewModel[];
    error: string | null;
    judgedAt: number | null;
  };
  const rows = legacy.rows.map((row) => {
    const optional = row as unknown as Partial<ActionRowViewModel>;
    return Object.assign({}, row, {
      updatedAt: optional.updatedAt ?? row.startedAt ?? "",
      resumeAllowed: optional.resumeAllowed ?? true,
      lifecycleStatus: optional.lifecycleStatus ?? ("ACTIVE" as const),
      action: optional.action ?? ({ kind: "none" } as const),
      actionError: optional.actionError ?? null,
      cancelDetails: optional.cancelDetails ?? null,
      errorSummary: optional.errorSummary ?? { state: "ready", items: [] },
    });
  });
  return {
    activeSection: { state: legacy.state, rows, error: legacy.error },
    attentionSection: { state: "ready", rows: [], error: null },
    attentionRemainingCount: 0,
    pendingWarning: null,
    pendingStartCount: null,
    pendingStartRequests: null,
    terminalStartRequests: null,
    recentTerminalRuns: null,
    stateAppId: "",
    requestEnabled: false,
    requestAppId: null,
    loginUserCode: "",
    judgedAt: legacy.judgedAt ?? 0,
    state: legacy.state,
    rows,
    error: legacy.error,
  } as BoardViewModel;
}

const START_SECTION_COLLAPSED_STORAGE_KEY =
  "ksql-flownet-start-section-collapsed";

function readStartSectionCollapsed(pageDocument: Document): boolean {
  try {
    return (
      pageDocument.defaultView?.sessionStorage.getItem(
        START_SECTION_COLLAPSED_STORAGE_KEY,
      ) === "1"
    );
  } catch {
    return false;
  }
}

function writeStartSectionCollapsed(
  pageDocument: Document,
  collapsed: boolean,
): void {
  try {
    pageDocument.defaultView?.sessionStorage.setItem(
      START_SECTION_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
  } catch {
    // sessionStorageを利用できない環境ではセッション保持を省略する。
  }
}

function sectionHeader(
  pageDocument: Document,
  title: string,
  count: number,
  collapsibleContent?: HTMLElement,
): HTMLElement {
  const header = element(pageDocument, "header", "ksql-flownet-section-header");
  const heading = element(
    pageDocument,
    "h3",
    "ksql-flownet-section-title",
    title,
  );
  const countBadge = element(
    pageDocument,
    "span",
    "ksql-flownet-count-badge",
    `${count}件`,
  );
  if (collapsibleContent === undefined) {
    header.append(heading, countBadge);
    return header;
  }

  header.className += " ksql-flownet-section-header--collapsible";
  const toggle = element(
    pageDocument,
    "button",
    "ksql-flownet-section-toggle",
  ) as HTMLButtonElement;
  const toggleTitle = element(
    pageDocument,
    "span",
    "ksql-flownet-section-toggle-title",
    title,
  );
  const chevron = element(
    pageDocument,
    "span",
    "ksql-flownet-section-chevron",
    "▼",
  );
  toggle.type = "button";
  const initiallyCollapsed = readStartSectionCollapsed(pageDocument);
  toggle.setAttribute("aria-expanded", String(!initiallyCollapsed));
  toggle.setAttribute("aria-controls", collapsibleContent.id);
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = initiallyCollapsed ? "▶" : "▼";
  collapsibleContent.hidden = initiallyCollapsed;
  let expanded = !initiallyCollapsed;
  heading.textContent = "";
  toggle.append(chevron, toggleTitle, countBadge);
  heading.append(toggle);
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    collapsibleContent.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    chevron.textContent = expanded ? "▼" : "▶";
    writeStartSectionCollapsed(pageDocument, !expanded);
  });
  header.append(heading);
  return header;
}

export function renderBoard(
  root: HTMLElement,
  rawModel: BoardViewModel,
  callbacksOrReload: RenderCallbacks | (() => void),
): void {
  const model = normalizeLegacyModel(rawModel);
  const callbacks = normalizeCallbacks(callbacksOrReload);
  const pageDocument = root.ownerDocument;
  const board = element(pageDocument, "section", "ksql-flownet-board");
  const toolbar = element(pageDocument, "header", "ksql-flownet-toolbar");
  toolbar.append(
    element(pageDocument, "h2", "ksql-flownet-toolbar-title", "Run状況"),
  );
  const toolbarActions = element(
    pageDocument,
    "div",
    "ksql-flownet-toolbar-actions",
  );
  if (model.requestEnabled && callbacks.onStart !== undefined) {
    const start = element(
      pageDocument,
      "button",
      "ksql-flownet-action ksql-flownet-start-action",
      "新規実行",
    ) as HTMLButtonElement;
    start.type = "button";
    start.addEventListener("click", callbacks.onStart);
    toolbarActions.append(start);
  }
  if (
    model.requestEnabled &&
    model.requestAppId !== null &&
    model.pendingStartCount !== null
  ) {
    const pendingLink = pageDocument.createElement("a");
    pendingLink.className = "ksql-flownet-start-pending";
    pendingLink.textContent = `処理待ちのSTART要求 ${model.pendingStartCount}件`;
    pendingLink.setAttribute(
      "href",
      `/k/${model.requestAppId}/?query=${encodeURIComponent(
        'request_type in ("START") and request_state in ("REQUESTED", "ACCEPTED")',
      )}`,
    );
    toolbarActions.append(pendingLink);
  }
  toolbarActions.append(
    element(
      pageDocument,
      "span",
      "ksql-flownet-judged-at",
      !model.judgedAt
        ? "判定時刻: 未判定"
        : `判定時刻: ${new Date(model.judgedAt).toLocaleString("ja-JP")}`,
    ),
  );
  const reload = element(
    pageDocument,
    "button",
    "ksql-flownet-reload",
    "再読込",
  ) as HTMLButtonElement;
  reload.type = "button";
  reload.addEventListener("click", callbacks.onReload);
  toolbarActions.append(reload);
  toolbar.append(toolbarActions);
  board.append(toolbar);

  if (
    model.requestAppId !== null &&
    (model.pendingStartRequests?.length ?? 0) +
      (model.terminalStartRequests?.length ?? 0) >
      0
  ) {
    const pendingStart = element(
      pageDocument,
      "section",
      "ksql-flownet-section ksql-flownet-start-request-section",
    );
    const pendingStartTable = renderStartRequestTable(
      pageDocument,
      model.pendingStartRequests ?? [],
      model.terminalStartRequests ?? [],
      model.requestAppId,
      model.loginUserCode,
      callbacks,
    );
    pendingStartTable.id = "ksql-flownet-start-request-content";
    pendingStart.append(
      sectionHeader(
        pageDocument,
        "START要求",
        (model.pendingStartRequests?.length ?? 0) +
          (model.terminalStartRequests?.length ?? 0),
        pendingStartTable,
      ),
      pendingStartTable,
    );
    const cancelled = pageDocument.createElement("a");
    cancelled.className = "ksql-flownet-pending";
    cancelled.textContent =
      "取消済みSTART要求は操作要求アプリの「03_取消済み」一覧で確認してください。";
    cancelled.setAttribute(
      "href",
      `/k/${model.requestAppId}/?query=${encodeURIComponent(
        'request_type in ("START") and request_state in ("CANCELLED")',
      )}`,
    );
    pendingStart.append(cancelled);
    board.append(pendingStart);
  }

  const active = element(pageDocument, "section", "ksql-flownet-section");
  active.append(
    sectionHeader(pageDocument, "進行中のRun", model.activeSection.rows.length),
  );
  if (model.activeSection.state === "error") {
    active.append(sectionError(pageDocument, model.activeSection.error));
  } else if (model.activeSection.rows.length === 0) {
    active.append(
      element(
        pageDocument,
        "p",
        "ksql-flownet-empty",
        "進行中のRunはありません。",
      ),
    );
  } else {
    active.append(
      renderActiveTable(
        pageDocument,
        model.activeSection.rows,
        model,
        callbacks,
      ),
    );
  }
  board.append(active);

  const attention = element(pageDocument, "section", "ksql-flownet-section");
  attention.append(
    sectionHeader(
      pageDocument,
      "終了済み・対応が必要なRun",
      model.attentionSection.rows.length,
    ),
  );
  if (model.attentionSection.state === "error") {
    attention.append(sectionError(pageDocument, model.attentionSection.error));
  } else if (model.attentionSection.rows.length === 0) {
    attention.append(
      element(
        pageDocument,
        "p",
        "ksql-flownet-empty",
        "終了済みで対応が必要なRunはありません。",
      ),
    );
  } else {
    attention.append(
      renderTerminalTable(
        pageDocument,
        model.attentionSection.rows,
        model,
        callbacks,
      ),
    );
    if (model.attentionRemainingCount > 0) {
      attention.append(
        element(
          pageDocument,
          "p",
          "ksql-flownet-remaining",
          `他${model.attentionRemainingCount}件(決着済みを含む)`,
        ),
      );
    }
  }
  board.append(attention);

  if (
    model.recentTerminalRuns !== null &&
    model.recentTerminalRuns.length > 0
  ) {
    const recent = element(pageDocument, "section", "ksql-flownet-section");
    recent.append(
      sectionHeader(
        pageDocument,
        "最近の終了Run（直近10件）",
        model.recentTerminalRuns.length,
      ),
      renderRecentTerminalRunTable(
        pageDocument,
        model.recentTerminalRuns,
        model.stateAppId,
      ),
    );
    board.append(recent);
  }

  if (model.pendingWarning !== null) {
    board.append(
      element(pageDocument, "p", "ksql-flownet-warning", model.pendingWarning),
    );
  }
  replaceChildren(root, board);
}

export function renderDetail(
  root: HTMLElement,
  model: DetailViewModel,
  callbacks: Omit<RenderCallbacks, "onReload"> = {},
): void {
  const pageDocument = root.ownerDocument;
  const content = element(pageDocument, "div", "ksql-flownet-detail");
  if ((model as unknown as { state: string }).state === "terminal") {
    content.append(
      element(pageDocument, "span", undefined, "終端(activityなし)"),
    );
    replaceChildren(root, content);
    return;
  }
  if (model.state === "error") {
    content.append(
      element(pageDocument, "span", "ksql-flownet-error", "判定不能"),
      element(pageDocument, "span", "ksql-flownet-error-detail", model.error),
    );
  } else {
    const legacyRow = model.row as ActivityRowViewModel;
    const optional = legacyRow as unknown as Partial<ActionRowViewModel>;
    const row: ActivityRowViewModel | TerminalRowViewModel = Object.assign(
      {},
      legacyRow,
      {
        updatedAt: optional.updatedAt ?? legacyRow.startedAt ?? "",
        resumeAllowed: optional.resumeAllowed ?? true,
        lifecycleStatus: optional.lifecycleStatus ?? ("ACTIVE" as const),
        action: optional.action ?? ({ kind: "none" } as const),
        actionError: optional.actionError ?? null,
        cancelDetails: optional.cancelDetails ?? null,
        errorSummary: optional.errorSummary ?? { state: "ready", items: [] },
      },
    );
    if (model.terminal) {
      content.append(
        element(pageDocument, "span", undefined, "終端(activityなし)"),
      );
    } else if ("error" in row && row.error !== null) {
      content.append(
        element(pageDocument, "span", "ksql-flownet-error", "判定不能"),
        element(pageDocument, "span", "ksql-flownet-error-detail", row.error),
      );
    } else if (row.activity !== null) {
      content.append(badge(pageDocument, row.activity));
      if ("evidence" in row) {
        content.append(
          element(pageDocument, "span", undefined, row.evidence),
          element(pageDocument, "span", undefined, row.actionText),
        );
      }
    }
    content.append(
      actionContent(
        pageDocument,
        row,
        model.requestEnabled,
        model.requestAppId,
        { onReload: () => {}, ...callbacks },
        model.allowRerunFromNode,
        "",
      ),
    );
    if (model.terminal && row.status !== "SUCCESS") {
      content.append(renderDetailErrorSummary(pageDocument, row.errorSummary));
    }
  }
  replaceChildren(root, content);
}
