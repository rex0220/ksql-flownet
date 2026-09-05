import {
  REQUEST_VALUE_LIMITS,
  type RequestRecord,
} from "../../src/requests/request-model.js";
import type { CancelActionDetails } from "./activity-input.js";
import type { BoardRequestAction } from "./board-action.js";
import type { FetchRecords } from "./kintone-reader.js";
import {
  createRequest,
  getCancellationSnapshot,
  guardPendingRequest,
  type PendingRequest,
  type PostRecord,
  type PutCancelRequested,
} from "./request-client.js";

export interface RequestDialogTarget {
  readonly action: BoardRequestAction;
  readonly runId: string;
  readonly allowRerunFromNode: boolean;
  readonly interrupted: boolean;
  readonly cancelDetails: CancelActionDetails | null;
  readonly terminal: boolean;
}

export interface RequestDialogOptions {
  readonly pageDocument: Document;
  readonly host: HTMLElement;
  readonly target: RequestDialogTarget;
  readonly fetchRecords: FetchRecords;
  readonly postRecord: PostRecord;
  readonly requestAppId: string;
  readonly onCreated: (record: RequestRecord) => void;
}

export interface RequestDialogHandle {
  close(): void;
}

export interface CancelRequestDialogOptions {
  readonly pageDocument: Document;
  readonly host: HTMLElement;
  readonly requestAppId: string;
  readonly request: PendingRequest;
  readonly fetchRecords: FetchRecords;
  readonly putCancelRequested: PutCancelRequested;
  readonly onCompleted: () => void;
}

const ACTION_NAME: Readonly<Record<BoardRequestAction, string>> = {
  RERUN: "リラン要求",
  STOP: "停止要求",
  RELEASE: "解除要求",
  CLOSE: "クローズ要求",
};

export function dialogNode(
  pageDocument: Document,
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const result = pageDocument.createElement(tag);
  if (className !== undefined) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

// 既存dialog内では短い別名を維持し、公開helperだけをSTART dialogと共有する。
const node = dialogNode;

export function requestUrl(appId: string, id: string): string {
  return `/k/${appId}/show#record=${id}`;
}

export function addRequestLink(
  pageDocument: Document,
  parent: HTMLElement,
  appId: string,
  id: string,
  label: string,
): void {
  const link = pageDocument.createElement("a");
  link.textContent = label;
  link.setAttribute("href", requestUrl(appId, id));
  parent.append(link);
}

export function definitionList(
  pageDocument: Document,
  items: readonly (readonly [string, string, boolean?])[],
  className = "ksql-flownet-dialog-details",
): HTMLElement {
  const list = node(pageDocument, "dl", className);
  for (const [label, value, codeValue] of items) {
    list.append(
      node(pageDocument, "dt", undefined, label),
      node(
        pageDocument,
        "dd",
        codeValue ? "ksql-flownet-dialog-code" : undefined,
        value,
      ),
    );
  }
  return list;
}

export function cancellationResultMessage(snapshot: {
  readonly requestState: string;
  readonly cancelRequested: boolean;
}): string {
  if (snapshot.requestState === "REQUESTED") {
    return snapshot.cancelRequested
      ? "取消受付済み・終端化待ち"
      : "取消できませんでした。現在も未受付です。再試行してください。";
  }
  return "処理開始済み・取消不可";
}

function cancellationTargetText(request: PendingRequest): string {
  if ("runId" in request.target) return `Run ID: ${request.target.runId}`;
  return [
    `network_id: ${request.target.networkId}`,
    request.target.businessKey === null
      ? null
      : `business_key: ${request.target.businessKey}`,
    request.target.scheduledFor === null
      ? null
      : `scheduled_for: ${request.target.scheduledFor}`,
  ]
    .filter((value): value is string => value !== null)
    .join(" / ");
}

export function openCancelRequestDialog(
  options: CancelRequestDialogOptions,
): RequestDialogHandle {
  const { pageDocument, request } = options;
  pageDocument.getElementById("ksql-flownet-cancel-dialog")?.remove();
  const overlay = node(pageDocument, "div", "ksql-flownet-dialog-overlay");
  overlay.id = "ksql-flownet-cancel-dialog";
  const dialog = node(pageDocument, "section", "ksql-flownet-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "ksql-flownet-cancel-dialog-title");
  const header = node(pageDocument, "header", "ksql-flownet-dialog-header");
  const heading = node(pageDocument, "div", "ksql-flownet-dialog-heading");
  heading.append(
    node(pageDocument, "span", "ksql-flownet-dialog-product", "kSQL-FlowNet"),
  );
  const title = node(
    pageDocument,
    "h2",
    "ksql-flownet-dialog-title",
    "要求の取消",
  );
  title.id = "ksql-flownet-cancel-dialog-title";
  heading.append(title);
  header.append(heading);
  const content = node(pageDocument, "div", "ksql-flownet-dialog-content");
  content.append(
    definitionList(pageDocument, [
      ["要求種別:", request.requestType],
      ["対象:", cancellationTargetText(request), true],
      ["理由:", request.reason],
    ]),
    node(
      pageDocument,
      "p",
      "ksql-flownet-warning",
      "取消は元に戻せません。再度実行するには新規に起票してください",
    ),
  );
  const result = node(pageDocument, "p", "ksql-flownet-error-detail");
  content.append(result);
  const footer = node(pageDocument, "footer", "ksql-flownet-dialog-footer");
  const close = node(
    pageDocument,
    "button",
    "ksql-flownet-dialog-close",
    "閉じる",
  ) as HTMLButtonElement;
  close.type = "button";
  close.addEventListener("click", () => overlay.remove());
  const send = node(
    pageDocument,
    "button",
    "ksql-flownet-action",
    "取消を確定",
  ) as HTMLButtonElement;
  send.type = "button";
  let sending = false;
  send.addEventListener("click", () => {
    if (sending) return;
    sending = true;
    send.disabled = true;
    result.textContent = "";
    void options
      .putCancelRequested(options.requestAppId, request.id, request.revision)
      .then(() => {
        result.className = "ksql-flownet-success";
        result.textContent =
          "取消を受け付けました。次のポーラー周期で CANCELLED になります";
        footer.replaceChildren(close);
        options.onCompleted();
      })
      .catch(() =>
        getCancellationSnapshot(
          options.fetchRecords,
          options.requestAppId,
          request.id,
        )
          .then((snapshot) => {
            result.textContent = cancellationResultMessage(snapshot);
            footer.replaceChildren(close);
          })
          .catch(() => {
            result.textContent =
              "取消結果を確認できません。処理開始済みの可能性があります。要求一覧で確認してください。";
            footer.replaceChildren(close);
          }),
      );
  });
  footer.append(close, send);
  dialog.append(header, content, footer);
  overlay.append(dialog);
  options.host.append(overlay);
  send.focus();
  return { close: () => overlay.remove() };
}

function releaseContext(
  pageDocument: Document,
  details: CancelActionDetails,
): HTMLElement {
  const box = node(pageDocument, "div", "ksql-flownet-dialog-info");
  box.append(
    definitionList(pageDocument, [
      ["停止要求者:", details.requestedBy],
      ["停止理由:", details.reason],
    ]),
  );
  return box;
}

function cautionText(target: RequestDialogTarget): readonly string[] {
  if (target.action === "STOP") {
    return ["停止は次のノード境界まで効きません(実行中SQLは完走します)。"];
  }
  if (target.action === "RELEASE") {
    return [
      "本人に確認しましたか?",
      "解除後、次の定期resumeが再開し得ます。",
      ...(target.terminal ? ["解除後にリラン要求を出してください。"] : []),
    ];
  }
  if (target.action === "CLOSE") {
    return [
      "以後この Run は再開できません。再集計は補正キーで新規実行してください。",
    ];
  }
  if (target.interrupted) {
    return [
      "中断分の結果はリラン時に裁定されます(確定できない場合はUNKNOWNとして保護)。要求のresult_codeがOK以外、または再び中断する場合は二次対応者へ連絡してください。",
    ];
  }
  return [];
}

export function openRequestDialog(
  options: RequestDialogOptions,
): RequestDialogHandle {
  const { pageDocument, target } = options;
  pageDocument.getElementById("ksql-flownet-request-dialog")?.remove();
  const overlay = node(pageDocument, "div", "ksql-flownet-dialog-overlay");
  overlay.id = "ksql-flownet-request-dialog";
  const dialog = node(pageDocument, "section", "ksql-flownet-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "ksql-flownet-dialog-title");
  const header = node(pageDocument, "header", "ksql-flownet-dialog-header");
  const brand = node(pageDocument, "div", "ksql-flownet-dialog-brand");
  const heading = node(pageDocument, "div", "ksql-flownet-dialog-heading");
  heading.append(
    node(pageDocument, "span", "ksql-flownet-dialog-product", "kSQL-FlowNet"),
  );
  const title = node(
    pageDocument,
    "h2",
    "ksql-flownet-dialog-title",
    ACTION_NAME[target.action],
  );
  title.id = "ksql-flownet-dialog-title";
  heading.append(title);
  header.append(brand, heading);
  const content = node(pageDocument, "div", "ksql-flownet-dialog-content");
  const footer = node(pageDocument, "footer", "ksql-flownet-dialog-footer");
  const close = node(
    pageDocument,
    "button",
    "ksql-flownet-dialog-close",
    "閉じる",
  ) as HTMLButtonElement;
  close.type = "button";
  close.addEventListener("click", () => overlay.remove());
  const renderFooter = (primary?: HTMLButtonElement): void => {
    footer.replaceChildren(close, ...(primary === undefined ? [] : [primary]));
  };
  dialog.append(header, content, footer);
  overlay.append(dialog);
  options.host.append(overlay);

  const renderInput = (): void => {
    title.textContent = ACTION_NAME[target.action];
    content.replaceChildren();
    const form = node(
      pageDocument,
      "form",
      "ksql-flownet-dialog-form",
    ) as HTMLFormElement;
    form.id = "ksql-flownet-dialog-form";
    form.append(
      definitionList(pageDocument, [["Run ID:", target.runId, true]]),
    );
    if (target.action === "RELEASE") {
      if (target.cancelDetails === null) {
        form.append(
          node(
            pageDocument,
            "p",
            "ksql-flownet-error-detail",
            "停止要求者または停止理由を確認できないため、解除要求を起票できません。",
          ),
        );
        content.append(form);
        renderFooter();
        return;
      }
      form.append(releaseContext(pageDocument, target.cancelDetails));
    }
    const reasonLabel = node(pageDocument, "label", undefined, "理由(必須)");
    const reason = pageDocument.createElement("textarea");
    reason.name = "reason";
    reason.required = true;
    reason.maxLength = REQUEST_VALUE_LIMITS.reason;
    reasonLabel.append(reason);
    form.append(reasonLabel);
    let rerunFromNode: HTMLInputElement | null = null;
    if (target.action === "RERUN" && target.allowRerunFromNode) {
      const rerunLabel = node(
        pageDocument,
        "label",
        undefined,
        "rerun_from_node(任意・上級)",
      );
      rerunFromNode = pageDocument.createElement("input");
      rerunFromNode.type = "text";
      rerunFromNode.name = "rerun_from_node";
      rerunFromNode.maxLength = REQUEST_VALUE_LIMITS.rerunFromNode;
      rerunLabel.append(rerunFromNode);
      form.append(
        rerunLabel,
        node(
          pageDocument,
          "p",
          "ksql-flownet-dialog-help",
          "二次対応者からRETRY_BRAKE解除等で具体的なNode IDを指示された場合のみ入力してください。",
        ),
      );
    }
    const error = node(pageDocument, "p", "ksql-flownet-error-detail");
    const proceed = node(
      pageDocument,
      "button",
      "ksql-flownet-action",
      "操作内容を確認",
    ) as HTMLButtonElement;
    proceed.type = "submit";
    proceed.setAttribute("form", form.id);
    form.append(error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const trimmedReason = reason.value.trim();
      if (trimmedReason === "") {
        error.textContent = "理由を入力してください。";
        return;
      }
      proceed.disabled = true;
      error.textContent = "";
      void guardPendingRequest(
        options.fetchRecords,
        options.requestAppId,
        target.runId,
      ).then((guard) => {
        if (guard.state === "ready") {
          const existing = guard.byRunId.get(target.runId);
          const pendingRequests = existing ?? [];
          const oldest = pendingRequests[0];
          if (oldest !== undefined) {
            content.replaceChildren(
              node(
                pageDocument,
                "p",
                "ksql-flownet-pending",
                "処理待ちの要求が既にあります。",
              ),
            );
            addRequestLink(
              pageDocument,
              content,
              options.requestAppId,
              oldest.id,
              pendingRequests.length === 1
                ? `要求処理待ち #${oldest.id}`
                : `要求処理待ち ${pendingRequests.length}件(最古 #${oldest.id})`,
            );
            renderFooter();
            return;
          }
        }
        renderConfirmation(
          trimmedReason,
          rerunFromNode?.value.trim() || null,
          guard.state === "unavailable" ? guard.warning : null,
        );
      });
    });
    content.append(form);
    renderFooter(proceed);
    reason.focus();
  };

  const renderConfirmation = (
    reason: string,
    rerunFromNode: string | null,
    warning: string | null,
  ): void => {
    title.textContent = "操作内容の確認";
    content.replaceChildren();
    content.append(
      definitionList(pageDocument, [
        ["操作:", ACTION_NAME[target.action]],
        ["Run ID:", target.runId, true],
        ["理由:", reason],
      ]),
    );
    if (rerunFromNode !== null) {
      content.append(
        definitionList(pageDocument, [
          ["rerun_from_node =", rerunFromNode, true],
        ]),
      );
    }
    if (target.action === "RELEASE" && target.cancelDetails !== null) {
      content.append(releaseContext(pageDocument, target.cancelDetails));
    }
    for (const caution of cautionText(target)) {
      content.append(node(pageDocument, "p", "ksql-flownet-warning", caution));
    }
    if (warning !== null) {
      content.append(node(pageDocument, "p", "ksql-flownet-warning", warning));
    }
    const error = node(pageDocument, "p", "ksql-flownet-error-detail");
    const send = node(
      pageDocument,
      "button",
      "ksql-flownet-action",
      "要求を作成",
    ) as HTMLButtonElement;
    send.type = "button";
    let sending = false;
    send.addEventListener("click", () => {
      if (sending) return;
      sending = true;
      send.disabled = true;
      error.textContent = "";
      void createRequest(
        {
          fetchRecords: options.fetchRecords,
          postRecord: options.postRecord,
          requestAppId: options.requestAppId,
        },
        {
          requestType: target.action,
          runId: target.runId,
          reason,
          rerunFromNode,
        },
      )
        .then((record) => {
          content.replaceChildren(
            node(
              pageDocument,
              "p",
              "ksql-flownet-success",
              `要求 #${record.id} を作成しました。最大5分ほどで処理を開始します。完了は要求レコードの状態(DONE/REJECTED)でご確認ください。`,
            ),
          );
          addRequestLink(
            pageDocument,
            content,
            options.requestAppId,
            record.id,
            `要求 #${record.id} を開く`,
          );
          options.onCreated(record);
          renderFooter();
        })
        .catch((caught: unknown) => {
          sending = false;
          send.disabled = false;
          error.textContent =
            caught instanceof Error
              ? caught.message
              : "操作要求の作成に失敗しました。自動再試行は行いません。";
        });
    });
    content.append(error);
    renderFooter(send);
    send.focus();
  };

  renderInput();
  return { close: () => overlay.remove() };
}
