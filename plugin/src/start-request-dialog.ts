import {
  REQUEST_VALUE_LIMITS,
  type RequestRecord,
} from "../../src/requests/request-model.js";
import type { FetchRecords } from "./kintone-reader.js";
import {
  createStartRequest,
  guardPendingStartRequest,
  loadStartCandidates,
  type PostRecord,
} from "./request-client.js";
import { addRequestLink, dialogNode, requestUrl } from "./request-dialog.js";
import {
  normalizeStartFormInput,
  START_INPUT_MODES,
  START_MODE_LABELS,
  startCandidateDisplay,
  startGuardKey,
  type StartCandidate,
  type StartInputMode,
} from "./start-request.js";

export interface StartRequestDialogOptions {
  readonly pageDocument: Document;
  readonly host: HTMLElement;
  readonly fetchRecords: FetchRecords;
  readonly postRecord: PostRecord;
  readonly stateAppId: number | string;
  readonly requestAppId: string;
  readonly onCreated: (record: RequestRecord) => void;
}

export interface StartRequestDialogHandle {
  close(): void;
}

function labeledInput(
  pageDocument: Document,
  labelText: string,
  name: string,
  type: string,
  maximum?: number,
): { readonly label: HTMLElement; readonly input: HTMLInputElement } {
  const label = dialogNode(pageDocument, "label", undefined, labelText);
  const input = pageDocument.createElement("input");
  input.name = name;
  input.type = type;
  if (maximum !== undefined) input.maxLength = maximum;
  label.append(input);
  return { label, input };
}

function candidateGroup(
  pageDocument: Document,
  label: string,
  candidates: readonly StartCandidate[],
  note: string | null,
  warning: string | null,
  onSelect: (candidate: StartCandidate) => void,
): HTMLElement {
  const section = dialogNode(
    pageDocument,
    "section",
    "ksql-flownet-start-candidates",
  );
  section.append(dialogNode(pageDocument, "h4", undefined, label));
  if (warning !== null) {
    section.append(
      dialogNode(pageDocument, "p", "ksql-flownet-warning", warning),
    );
  } else if (candidates.length === 0) {
    section.append(dialogNode(pageDocument, "p", undefined, "候補なし"));
  } else {
    const list = dialogNode(pageDocument, "div", "ksql-flownet-candidate-list");
    for (const candidate of candidates) {
      const button = dialogNode(
        pageDocument,
        "button",
        "ksql-flownet-candidate",
        startCandidateDisplay(candidate),
      ) as HTMLButtonElement;
      button.type = "button";
      button.addEventListener("click", () => onSelect(candidate));
      list.append(button);
    }
    section.append(list);
  }
  if (note !== null) {
    section.append(
      dialogNode(pageDocument, "p", "ksql-flownet-dialog-help", note),
    );
  }
  return section;
}

export function openStartRequestDialog(
  options: StartRequestDialogOptions,
): StartRequestDialogHandle {
  const { pageDocument } = options;
  pageDocument.getElementById("ksql-flownet-start-request-dialog")?.remove();
  const overlay = dialogNode(
    pageDocument,
    "div",
    "ksql-flownet-dialog-overlay",
  );
  overlay.id = "ksql-flownet-start-request-dialog";
  const dialog = dialogNode(pageDocument, "section", "ksql-flownet-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "ksql-flownet-start-dialog-title");
  const header = dialogNode(
    pageDocument,
    "header",
    "ksql-flownet-dialog-header",
  );
  const brand = dialogNode(pageDocument, "div", "ksql-flownet-dialog-brand");
  const heading = dialogNode(
    pageDocument,
    "div",
    "ksql-flownet-dialog-heading",
  );
  heading.append(
    dialogNode(
      pageDocument,
      "span",
      "ksql-flownet-dialog-product",
      "kSQL-FlowNet",
    ),
  );
  const title = dialogNode(
    pageDocument,
    "h2",
    "ksql-flownet-dialog-title",
    "新規実行",
  );
  title.id = "ksql-flownet-start-dialog-title";
  heading.append(title);
  header.append(brand, heading);
  const content = dialogNode(
    pageDocument,
    "div",
    "ksql-flownet-dialog-content",
  );
  const footer = dialogNode(
    pageDocument,
    "footer",
    "ksql-flownet-dialog-footer",
  );
  const close = dialogNode(
    pageDocument,
    "button",
    "ksql-flownet-dialog-close",
    "閉じる",
  ) as HTMLButtonElement;
  close.type = "button";
  close.addEventListener("click", () => overlay.remove());
  dialog.append(header, content, footer);
  overlay.append(dialog);
  options.host.append(overlay);

  const form = dialogNode(
    pageDocument,
    "form",
    "ksql-flownet-dialog-form ksql-flownet-start-form",
  ) as HTMLFormElement;
  form.id = "ksql-flownet-start-dialog-form";
  const modeLabel = dialogNode(pageDocument, "label", undefined, "入力モード");
  const mode = pageDocument.createElement("select");
  mode.name = "mode";
  for (const value of START_INPUT_MODES) {
    const option = pageDocument.createElement("option");
    option.setAttribute("value", value);
    option.textContent = START_MODE_LABELS[value];
    mode.append(option);
  }
  mode.value = "scheduled";
  modeLabel.append(mode);
  const network = labeledInput(
    pageDocument,
    "network_id(必須・自由入力)",
    "network_id",
    "text",
    REQUEST_VALUE_LIMITS.networkId,
  );
  const business = labeledInput(
    pageDocument,
    "business_key(補正/explicitで必須)",
    "business_key",
    "text",
    REQUEST_VALUE_LIMITS.businessKey,
  );
  const scheduled = labeledInput(
    pageDocument,
    "対象期間(定期キー/補正で必須・日本時間)",
    "scheduled_for",
    "datetime-local",
  );
  const reasonLabel = dialogNode(
    pageDocument,
    "label",
    undefined,
    "理由(必須)",
  );
  const reason = pageDocument.createElement("textarea");
  reason.name = "reason";
  reason.required = true;
  reason.maxLength = REQUEST_VALUE_LIMITS.reason;
  reasonLabel.append(reason);
  const candidates = dialogNode(
    pageDocument,
    "div",
    "ksql-flownet-start-candidate-groups",
  );
  candidates.append(
    dialogNode(pageDocument, "p", undefined, "参考候補(過去実績)を読込中…"),
  );
  const error = dialogNode(pageDocument, "p", "ksql-flownet-error-detail");
  form.append(
    modeLabel,
    network.label,
    business.label,
    scheduled.label,
    reasonLabel,
    dialogNode(
      pageDocument,
      "p",
      "ksql-flownet-warning",
      "実際に起動可能かはサーバー側設定で判定されます。",
    ),
    dialogNode(
      pageDocument,
      "p",
      "ksql-flownet-dialog-help",
      "ポーラーは5分間隔です。起票後、最大5分ほどで処理を開始します。",
    ),
    dialogNode(pageDocument, "h3", undefined, "参考候補(過去実績)"),
    candidates,
    error,
  );
  content.append(form);
  const send = dialogNode(
    pageDocument,
    "button",
    "ksql-flownet-action",
    "START要求を作成",
  ) as HTMLButtonElement;
  send.type = "submit";
  send.setAttribute("form", form.id);
  footer.append(close, send);

  const applyMode = (): void => {
    const selected = mode.value as StartInputMode;
    business.input.disabled = selected === "scheduled";
    scheduled.input.disabled = selected === "explicit";
    business.input.required = selected !== "scheduled";
    scheduled.input.required = selected !== "explicit";
  };
  mode.addEventListener("change", applyMode);
  applyMode();

  const chooseCandidate = (candidate: StartCandidate): void => {
    network.input.value = candidate.networkId;
    if (candidate.businessKey !== null)
      business.input.value = candidate.businessKey;
    if (candidate.scheduledFor !== null) {
      const milliseconds = Date.parse(candidate.scheduledFor);
      if (!Number.isNaN(milliseconds)) {
        const jst = new Date(milliseconds + 9 * 60 * 60 * 1_000)
          .toISOString()
          .slice(0, 16);
        scheduled.input.value = jst;
      }
    }
  };

  void loadStartCandidates(
    options.fetchRecords,
    options.requestAppId,
    options.stateAppId,
  ).then((loaded) => {
    candidates.replaceChildren(
      candidateGroup(
        pageDocument,
        loaded.requestHistory.label,
        loaded.requestHistory.items,
        loaded.requestHistory.note,
        loaded.requestHistory.warning,
        chooseCandidate,
      ),
      candidateGroup(
        pageDocument,
        loaded.runHistory.label,
        loaded.runHistory.items,
        loaded.runHistory.note,
        loaded.runHistory.warning,
        chooseCandidate,
      ),
    );
  });

  let sending = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (sending) return;
    error.textContent = "";
    let normalized;
    try {
      normalized = normalizeStartFormInput({
        mode: mode.value as StartInputMode,
        networkId: network.input.value,
        businessKey: business.input.value,
        scheduledForLocal: scheduled.input.value,
        reason: reason.value,
      });
    } catch (caught) {
      error.textContent =
        caught instanceof Error
          ? caught.message
          : "入力内容を確認してください。";
      return;
    }
    sending = true;
    send.disabled = true;
    close.disabled = true;
    void guardPendingStartRequest(
      options.fetchRecords,
      options.requestAppId,
      startGuardKey(normalized),
    )
      .then(async (guard) => {
        if (guard.state === "ready" && guard.matchingIds.length > 0) {
          content.replaceChildren(
            dialogNode(
              pageDocument,
              "p",
              "ksql-flownet-pending",
              "同じキーの処理待ちSTART要求が既にあります。",
            ),
          );
          addRequestLink(
            pageDocument,
            content,
            options.requestAppId,
            guard.matchingIds[0] ?? "",
            `START要求 #${guard.matchingIds[0] ?? ""}`,
          );
          footer.replaceChildren(close);
          close.disabled = false;
          return;
        }
        if (guard.state === "unavailable") {
          form.append(
            dialogNode(
              pageDocument,
              "p",
              "ksql-flownet-warning",
              guard.warning,
            ),
          );
        }
        const created = await createStartRequest(
          {
            fetchRecords: options.fetchRecords,
            postRecord: options.postRecord,
            requestAppId: options.requestAppId,
          },
          normalized,
        );
        content.replaceChildren(
          dialogNode(
            pageDocument,
            "p",
            "ksql-flownet-success",
            `START要求 #${created.id} を作成しました。最大5分ほどで処理を開始します。`,
          ),
          dialogNode(
            pageDocument,
            "p",
            "ksql-flownet-dialog-help",
            "Runが作成されるとボードに現れます。",
          ),
        );
        const link = pageDocument.createElement("a");
        link.textContent = `START要求 #${created.id} を開く`;
        link.setAttribute("href", requestUrl(options.requestAppId, created.id));
        content.append(link);
        footer.replaceChildren(close);
        close.disabled = false;
        options.onCreated(created);
      })
      .catch((caught) => {
        sending = false;
        send.disabled = false;
        close.disabled = false;
        error.textContent =
          caught instanceof Error
            ? caught.message
            : "START要求の作成に失敗しました。";
      });
  });
  network.input.focus();
  return { close: () => overlay.remove() };
}
