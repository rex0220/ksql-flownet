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
  renderBoard,
  renderBoardLoading,
  renderDetail,
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

export function createKintoneFetchRecords(
  api: KintoneRecordsGetApi,
): FetchRecords {
  return (request) =>
    api.api(api.api.url("/k/v1/records.json", true), "GET", request);
}

function runtimeDependencies(
  api: RuntimeKintone,
  pluginId: string,
): ActivityLoadDependencies | null {
  const stateAppId = api.app.getId();
  if (stateAppId === null) return null;
  const auditAppId = api.plugin.app.getConfig(pluginId).auditAppId ?? "";
  const fetchRecords = createKintoneFetchRecords(api);
  return { fetchRecords, stateAppId, auditAppId };
}

function configError(): DetailViewModel {
  return {
    state: "error",
    error: "監査履歴アプリIDを正の10進整数で設定してください。",
  };
}

export function installDesktop(
  api: RuntimeKintone,
  pageDocument: Document,
  // kintone.$PLUGIN_IDはプラグインJSの同期実行中しか有効でないため、
  // 読み込み時に捕捉した値を受け取る(イベントハンドラ内でapi.$PLUGIN_IDを
  // 読むとgetConfigがUsageエラーになる — 2026-09-01実機)
  pluginId: string = api.$PLUGIN_ID,
): void {
  let activeBoard: { root: HTMLElement; controller: BoardController } | null =
    null;
  let detailGeneration = 0;

  api.events.on("app.record.index.show", ((event: IndexEvent) => {
    if (!isRunBoardEvent(event)) return event;
    const root = pageDocument.getElementById("ksql-flownet-run-board");
    if (root === null) return event;
    const dependencies = runtimeDependencies(api, pluginId);
    if (dependencies === null) return event;

    if (activeBoard !== null && activeBoard.root !== root) {
      activeBoard.controller.invalidate();
      activeBoard = null;
    }
    if (activeBoard === null) {
      const controller = new BoardController(() => loadBoard(dependencies), {
        loading: () => renderBoardLoading(root),
        render: (model, reload) => renderBoard(root, model, reload),
      });
      activeBoard = { root, controller };
    }
    activeBoard.controller.reload();
    return event;
  }) as (event: never) => unknown);

  api.events.on("app.record.detail.show", ((event: DetailEvent) => {
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

    const dependencies = runtimeDependencies(api, pluginId);
    if (
      dependencies === null ||
      !validateAuditAppId(dependencies.auditAppId).valid
    ) {
      renderDetail(root, configError());
      return event;
    }
    const record = event.record;
    void loadDetail(dependencies, record).then((model) => {
      if (generation === detailGeneration) renderDetail(root, model);
    });
    return event;
  }) as (event: never) => unknown);
}

declare const kintone: RuntimeKintone | undefined;
declare const document: Document | undefined;

if (typeof kintone !== "undefined" && typeof document !== "undefined") {
  // 版と$PLUGIN_ID捕捉可否の診断ログ(値そのものは出さない)
  console.info(
    `kSQL-FlowNet Run状況 plugin v4 loaded (plugin_id captured: ${typeof kintone.$PLUGIN_ID === "string" && kintone.$PLUGIN_ID !== ""})`,
  );
  installDesktop(kintone, document);
}
