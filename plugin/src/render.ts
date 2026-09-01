import type { RunActivity } from "./activity-entry.js";

export interface ActivityRowViewModel {
  readonly runId: string;
  readonly businessKey: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly activity: RunActivity | null;
  readonly evidence: string;
  readonly actionText: string;
  readonly judgedAt: number;
  readonly error: string | null;
}

export interface BoardViewModel {
  readonly state: "ready" | "error";
  readonly rows: readonly ActivityRowViewModel[];
  readonly judgedAt: number | null;
  readonly error: string | null;
}

export type DetailViewModel =
  | { readonly state: "terminal" }
  | { readonly state: "ready"; readonly row: ActivityRowViewModel }
  | { readonly state: "error"; readonly error: string };

export const ACTION_TEXT: Readonly<Record<RunActivity, string>> = {
  LIVE: "待つ(触らない)",
  IDLE: "定期起動を待つ",
  STOPPED: "止めた本人に確認。解除はRELEASE要求",
  INTERRUPTED: "二次対応者へ連絡(Run IDを添えて)",
};

const MAX_DISPLAY_LENGTH = 160;

export function limitDisplayValue(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_DISPLAY_LENGTH) return value;
  return `${characters.slice(0, MAX_DISPLAY_LENGTH).join("")}…`;
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

function replaceChildren(root: HTMLElement, child: HTMLElement): void {
  root.replaceChildren(child);
}

export function renderBoardLoading(root: HTMLElement): void {
  replaceChildren(
    root,
    element(root.ownerDocument, "p", "ksql-flownet-loading", "読込中…"),
  );
}

export function renderBoard(
  root: HTMLElement,
  model: BoardViewModel,
  onReload: () => void,
): void {
  const pageDocument = root.ownerDocument;
  const board = element(pageDocument, "section", "ksql-flownet-board");
  board.append(element(pageDocument, "h2", undefined, "Run状況"));

  if (model.state === "error") {
    board.append(
      element(pageDocument, "p", "ksql-flownet-error", "判定不能"),
      element(
        pageDocument,
        "p",
        "ksql-flownet-error-detail",
        model.error ?? "読込に失敗しました。CLI statusで確認してください。",
      ),
    );
  } else if (model.rows.length === 0) {
    board.append(
      element(
        pageDocument,
        "p",
        "ksql-flownet-empty",
        "未終端Runはありません。",
      ),
    );
  } else {
    const table = element(pageDocument, "table", "ksql-flownet-table");
    const thead = element(pageDocument, "thead");
    const header = element(pageDocument, "tr");
    for (const label of [
      "Business Key",
      "Run ID",
      "Status",
      "Activity",
      "Started At",
      "根拠・一次対応",
    ]) {
      header.append(element(pageDocument, "th", undefined, label));
    }
    thead.append(header);
    const tbody = element(pageDocument, "tbody");
    for (const row of model.rows) {
      const tr = element(pageDocument, "tr");
      tr.append(
        element(pageDocument, "td", undefined, row.businessKey),
        element(pageDocument, "td", undefined, row.runId),
        element(pageDocument, "td", undefined, row.status),
        activityCell(pageDocument, row),
        element(pageDocument, "td", undefined, row.startedAt ?? "未開始"),
        element(
          pageDocument,
          "td",
          row.error === null ? undefined : "ksql-flownet-error-detail",
          row.error ??
            [row.evidence, row.actionText].filter(Boolean).join(" / "),
        ),
      );
      tbody.append(tr);
    }
    table.append(thead, tbody);
    board.append(table);
  }

  const footer = element(pageDocument, "footer", "ksql-flownet-footer");
  footer.append(
    element(
      pageDocument,
      "span",
      "ksql-flownet-judged-at",
      model.judgedAt === null
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
  reload.addEventListener("click", onReload);
  footer.append(reload);
  board.append(footer);
  replaceChildren(root, board);
}

export function renderDetail(root: HTMLElement, model: DetailViewModel): void {
  const pageDocument = root.ownerDocument;
  const content = element(pageDocument, "div", "ksql-flownet-detail");
  if (model.state === "terminal") {
    content.append(
      element(pageDocument, "span", undefined, "終端(activityなし)"),
    );
  } else if (model.state === "error") {
    content.append(
      element(pageDocument, "span", "ksql-flownet-error", "判定不能"),
      element(pageDocument, "span", "ksql-flownet-error-detail", model.error),
    );
  } else {
    const { row } = model;
    if (row.error !== null || row.activity === null) {
      content.append(
        element(pageDocument, "span", "ksql-flownet-error", "判定不能"),
        element(
          pageDocument,
          "span",
          "ksql-flownet-error-detail",
          row.error ?? "activityを導出できませんでした。",
        ),
      );
    } else {
      content.append(
        badge(pageDocument, row.activity),
        element(pageDocument, "span", undefined, row.evidence),
        element(pageDocument, "span", undefined, row.actionText),
      );
    }
  }
  replaceChildren(root, content);
}
