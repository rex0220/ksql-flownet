import {
  REQUEST_VALUE_LIMITS,
  type RequestRecord,
} from "../../src/requests/request-model.js";
import type { CancelActionDetails } from "./activity-input.js";
import type { BoardRequestAction } from "./board-action.js";
import type { FetchRecords } from "./kintone-reader.js";
import {
  createRequest,
  guardPendingRequest,
  type PostRecord,
} from "./request-client.js";

export interface RequestDialogTarget {
  readonly action: BoardRequestAction;
  readonly runId: string;
  readonly allowRerunFromNode: boolean;
  readonly interrupted: boolean;
  readonly cancelDetails: CancelActionDetails | null;
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

const ACTION_NAME: Readonly<Record<BoardRequestAction, string>> = {
  RERUN: "リラン要求",
  STOP: "停止要求",
  RELEASE: "解除要求",
};

function node(
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

function requestUrl(appId: string, id: string): string {
  return `/k/${appId}/show#record=${id}`;
}

function addRequestLink(
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

function cautionText(target: RequestDialogTarget): readonly string[] {
  if (target.action === "STOP") {
    return ["停止は次のノード境界まで効きません(実行中SQLは完走します)。"];
  }
  if (target.action === "RELEASE") {
    return ["本人に確認しましたか?", "解除後、次の定期resumeが再開し得ます。"];
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
  const title = node(
    pageDocument,
    "h2",
    "ksql-flownet-dialog-title",
    ACTION_NAME[target.action],
  );
  title.id = "ksql-flownet-dialog-title";
  const content = node(pageDocument, "div", "ksql-flownet-dialog-content");
  const close = node(
    pageDocument,
    "button",
    "ksql-flownet-dialog-close",
    "閉じる",
  ) as HTMLButtonElement;
  close.type = "button";
  close.addEventListener("click", () => overlay.remove());
  dialog.append(title, content, close);
  overlay.append(dialog);
  options.host.append(overlay);

  const renderInput = (): void => {
    content.replaceChildren();
    const form = node(
      pageDocument,
      "form",
      "ksql-flownet-dialog-form",
    ) as HTMLFormElement;
    form.append(
      node(pageDocument, "p", undefined, `操作: ${ACTION_NAME[target.action]}`),
      node(pageDocument, "p", undefined, `Run ID: ${target.runId}`),
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
        return;
      }
      form.append(
        node(
          pageDocument,
          "p",
          undefined,
          `停止要求者: ${target.cancelDetails.requestedBy}`,
        ),
        node(
          pageDocument,
          "p",
          undefined,
          `停止理由: ${target.cancelDetails.reason}`,
        ),
      );
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
    form.append(error, proceed);
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
          if (existing !== undefined) {
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
              existing.oldestId,
              existing.label,
            );
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
    reason.focus();
  };

  const renderConfirmation = (
    reason: string,
    rerunFromNode: string | null,
    warning: string | null,
  ): void => {
    content.replaceChildren();
    content.append(
      node(pageDocument, "h3", undefined, "操作内容の確認"),
      node(pageDocument, "p", undefined, `操作: ${ACTION_NAME[target.action]}`),
      node(pageDocument, "p", undefined, `Run ID: ${target.runId}`),
      node(pageDocument, "p", undefined, `理由: ${reason}`),
    );
    if (rerunFromNode !== null) {
      content.append(
        node(
          pageDocument,
          "p",
          undefined,
          `rerun_from_node = ${rerunFromNode}`,
        ),
      );
    }
    if (target.action === "RELEASE" && target.cancelDetails !== null) {
      content.append(
        node(
          pageDocument,
          "p",
          undefined,
          `停止要求者: ${target.cancelDetails.requestedBy}`,
        ),
        node(
          pageDocument,
          "p",
          undefined,
          `停止理由: ${target.cancelDetails.reason}`,
        ),
      );
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
    content.append(error, send);
    send.focus();
  };

  renderInput();
  return { close: () => overlay.remove() };
}
