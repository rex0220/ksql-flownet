import {
  BoardController,
  loadBoard,
  type ActivityLoadDependencies,
} from "./board-controller.js";
import { validateAuditAppId } from "./config-validation.js";
import { loadDetail } from "./detail-controller.js";
import type {
  FetchRecords,
  RecordsRequest,
  RecordsResponse,
} from "./kintone-reader.js";
import type { KintoneRecord } from "./kintone-record.js";
import {
  openRequestDialog,
  type RequestDialogTarget,
} from "./request-dialog.js";
import type {
  CreateRecordResponse,
  CreateRequestBody,
  PostRecord,
} from "./request-client.js";
import {
  detectRelatedAppIds,
  resolveRelatedAppIds,
  type FormFieldsResponse,
} from "./related-app-detection.js";
import {
  renderBoard,
  renderBoardLoading,
  renderDetail,
  type ActionTarget,
  type DetailViewModel,
} from "./render.js";

export interface IndexEvent {
  readonly viewType?: string;
  readonly viewName?: string;
}

export interface DetailEvent {
  readonly record?: KintoneRecord;
}

export function isRunBoardEvent(event: IndexEvent): boolean {
  return event.viewType === "custom" && event.viewName === "00_Run状況";
}

export function isNetworkRunDetail(event: DetailEvent): boolean {
  return event.record?.record_type?.value === "NETWORK_RUN";
}

interface RuntimeKintone {
  readonly $PLUGIN_ID: string;
  readonly events: {
    on(
      names: string | readonly string[],
      handler: (event: never) => unknown,
    ): void;
  };
  readonly app: {
    getId(): number | null;
    readonly record: {
      getHeaderMenuSpaceElement(): HTMLElement | null;
    };
  };
  readonly plugin: {
    readonly app: {
      getConfig(pluginId: string): Readonly<Record<string, string>>;
    };
  };
  readonly api: {
    (
      url: string,
      method: "GET",
      body: RecordsRequest,
    ): Promise<RecordsResponse>;
    (
      url: string,
      method: "GET",
      body: { readonly app: number | string },
    ): Promise<FormFieldsResponse>;
    (
      url: string,
      method: "POST",
      body: CreateRequestBody,
    ): Promise<CreateRecordResponse>;
    url(path: string, guestSpace: boolean): string;
  };
}

export interface KintoneRecordsGetApi {
  readonly api: {
    (
      url: string,
      method: "GET",
      body: RecordsRequest,
    ): Promise<RecordsResponse>;
    url(path: string, guestSpace: boolean): string;
  };
}

export interface KintoneRecordPostApi {
  readonly api: {
    (
      url: string,
      method: "POST",
      body: CreateRequestBody,
    ): Promise<CreateRecordResponse>;
    url(path: string, guestSpace: boolean): string;
  };
}

export function createKintoneFetchRecords(
  api: KintoneRecordsGetApi,
): FetchRecords {
  return (request) =>
    api.api(api.api.url("/k/v1/records.json", true), "GET", request);
}

export function createKintonePostRecord(api: KintoneRecordPostApi): PostRecord {
  return (request) =>
    api.api(api.api.url("/k/v1/record.json", true), "POST", request);
}

interface RuntimeDependencies {
  readonly load: ActivityLoadDependencies;
  readonly postRecord: PostRecord;
}

export async function loadRuntimeDependencies(
  api: RuntimeKintone,
  pluginId: string,
): Promise<RuntimeDependencies | null> {
  const stateAppId = api.app.getId();
  if (stateAppId === null) return null;
  const config = api.plugin.app.getConfig(pluginId);
  let detected = { auditAppId: "", requestAppId: "", logAppId: "" };
  try {
    const fields = await api.api(
      api.api.url("/k/v1/app/form/fields.json", true),
      "GET",
      { app: stateAppId },
    );
    detected = detectRelatedAppIds(fields);
  } catch {
    // 自動検出の権限/API失敗はfail-open。保存済み設定だけで従来どおり動作する。
  }
  const appIds = resolveRelatedAppIds(config, detected);
  return {
    load: {
      fetchRecords: createKintoneFetchRecords(api),
      stateAppId,
      auditAppId: appIds.auditAppId,
      requestAppId: appIds.requestAppId,
      logAppId: appIds.logAppId,
    },
    postRecord: createKintonePostRecord(api),
  };
}

function configError(): DetailViewModel {
  return {
    state: "error",
    error: "監査履歴アプリIDを正の10進整数で設定してください。",
  };
}

function dialogTarget(target: ActionTarget): RequestDialogTarget {
  return {
    action: target.action,
    runId: target.runId,
    allowRerunFromNode: target.allowRerunFromNode,
    interrupted: target.interrupted,
    cancelDetails: target.cancelDetails,
  };
}

function pendingDetail(
  model: DetailViewModel,
  requestId: string,
): DetailViewModel {
  if (model.state !== "ready") return model;
  return {
    ...model,
    row: {
      ...model.row,
      action: {
        kind: "pending",
        pending: {
          oldestId: requestId,
          count: 1,
          label: `要求処理待ち #${requestId}`,
        },
        secondaryNotice:
          model.row.status === "UNKNOWN"
            ? "二次対応者へ連絡してください。"
            : null,
        copyRunId: model.row.status === "UNKNOWN",
      },
    },
  };
}

export function installDesktop(
  api: RuntimeKintone,
  pageDocument: Document,
  pluginId: string = api.$PLUGIN_ID,
): void {
  let activeBoard: { root: HTMLElement; controller: BoardController } | null =
    null;
  let detailGeneration = 0;
  const dependenciesPromise = loadRuntimeDependencies(api, pluginId);

  api.events.on("app.record.index.show", (async (event: IndexEvent) => {
    if (!isRunBoardEvent(event)) return event;
    const root = pageDocument.getElementById("ksql-flownet-run-board");
    if (root === null) return event;
    const dependencies = await dependenciesPromise;
    if (dependencies === null) return event;

    if (activeBoard !== null && activeBoard.root !== root) {
      activeBoard.controller.invalidate();
      activeBoard = null;
    }
    if (activeBoard === null) {
      const controller = new BoardController(
        () => loadBoard(dependencies.load),
        {
          loading: () => renderBoardLoading(root),
          render: (model, reload) =>
            renderBoard(root, model, {
              onReload: reload,
              onAction: (target) => {
                if (model.requestAppId === null) return;
                openRequestDialog({
                  pageDocument,
                  host: pageDocument.body,
                  target: dialogTarget(target),
                  fetchRecords: dependencies.load.fetchRecords,
                  postRecord: dependencies.postRecord,
                  requestAppId: model.requestAppId,
                  onCreated: () => reload(),
                });
              },
            }),
        },
      );
      activeBoard = { root, controller };
    }
    activeBoard.controller.reload();
    return event;
  }) as (event: never) => unknown);

  api.events.on("app.record.detail.show", (async (event: DetailEvent) => {
    const generation = ++detailGeneration;
    if (!isNetworkRunDetail(event) || event.record === undefined) return event;
    const header = api.app.record.getHeaderMenuSpaceElement();
    if (header === null) return event;
    let root = pageDocument.getElementById("ksql-flownet-run-detail");
    if (root === null) {
      root = pageDocument.createElement("div");
      root.id = "ksql-flownet-run-detail";
      header.append(root);
    }

    const dependencies = await dependenciesPromise;
    if (
      dependencies === null ||
      !validateAuditAppId(dependencies.load.auditAppId).valid
    ) {
      renderDetail(root, configError());
      return event;
    }
    const record = event.record;
    void loadDetail(dependencies.load, record).then((loadedModel) => {
      if (generation !== detailGeneration) return;
      let currentModel = loadedModel;
      const render = (): void =>
        renderDetail(root, currentModel, {
          onAction: (target) => {
            if (
              currentModel.state !== "ready" ||
              currentModel.requestAppId === null
            )
              return;
            openRequestDialog({
              pageDocument,
              host: pageDocument.body,
              target: dialogTarget(target),
              fetchRecords: dependencies.load.fetchRecords,
              postRecord: dependencies.postRecord,
              requestAppId: currentModel.requestAppId,
              onCreated: (created) => {
                currentModel = pendingDetail(currentModel, created.id);
                render();
              },
            });
          },
        });
      render();
    });
    return event;
  }) as (event: never) => unknown);
}

declare const kintone: RuntimeKintone | undefined;
declare const document: Document | undefined;

if (typeof kintone !== "undefined" && typeof document !== "undefined") {
  console.info(
    `kSQL-FlowNet Run状況 plugin v17 loaded (plugin_id captured: ${typeof kintone.$PLUGIN_ID === "string" && kintone.$PLUGIN_ID !== ""})`,
  );
  installDesktop(kintone, document);
}
