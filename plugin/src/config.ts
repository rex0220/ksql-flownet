import {
  validateAuditAppIdOverride,
  validateLogAppId,
  validateRequestAppId,
  validateStartAllowedNetworks,
  type PluginConfig,
} from "./config-validation.js";
import {
  detectRelatedAppIds,
  type FormFieldsResponse,
  type RelatedAppIds,
} from "./related-app-detection.js";

export {
  parseStartAllowedNetworks,
  validateAuditAppId,
  validateAuditAppIdOverride,
  validateLogAppId,
  validateRequestAppId,
  validateStartAllowedNetworks,
  type ConfigValidationResult,
  type PluginConfig,
  type StartAllowedNetwork,
} from "./config-validation.js";

interface ConfigKintone {
  readonly $PLUGIN_ID: string;
  readonly app: {
    getId(): number | null;
  };
  readonly plugin: {
    readonly app: {
      getConfig(pluginId: string): Readonly<Record<string, string>>;
      setConfig(config: PluginConfig, callback: () => void): void;
    };
  };
  readonly api: {
    (
      url: string,
      method: "GET",
      body: { readonly app: number },
    ): Promise<FormFieldsResponse>;
    (
      url: string,
      method: "GET",
      body: { readonly id: string },
    ): Promise<{ readonly name?: unknown }>;
    (
      url: string,
      method: "POST",
      body: { readonly apps: readonly { readonly app: number }[] },
    ): Promise<unknown>;
    (
      url: string,
      method: "GET",
      body: { readonly apps: readonly number[] },
    ): Promise<{
      readonly apps?: readonly { readonly status?: unknown }[];
    }>;
    url(path: string, guestSpace: boolean): string;
  };
}

interface ConfigFieldElements {
  readonly input: HTMLInputElement;
  readonly detection: HTMLElement;
  readonly preview: HTMLElement;
}

type AppNameLookup = (appId: string) => Promise<string | null>;
type Wait = (milliseconds: number) => Promise<void>;

export interface SaveConfigOptions {
  readonly deploy: boolean;
  readonly appId: number | null;
  readonly wait?: Wait;
  readonly setConfigTimeoutMs?: number;
}

export interface SaveConfigOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export interface EditablePluginConfig {
  readonly auditAppId: string;
  readonly requestAppId: string;
  readonly logAppId: string;
  readonly startAllowedNetworks: string;
  readonly deployOnSave: boolean;
}

export interface ConfigBackupPayload {
  readonly date: string;
  readonly pluginName: "kSQL-FlowNet Run Activity";
  readonly pluginId: string;
  readonly appId: number | null;
  readonly appName: string;
  readonly config: EditablePluginConfig;
}

type EditableConfigField =
  | "auditAppId"
  | "requestAppId"
  | "logAppId"
  | "startAllowedNetworks"
  | "deployOnSave";

type ConfigTab = "basic" | "advanced";

class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly field: EditableConfigField,
  ) {
    super(message);
  }
}

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const DETECTION_UNAVAILABLE = "自動検出できません(関連レコード一覧が未設定)";
const PREVIEW_UNAVAILABLE = "アプリを確認できません(IDまたは権限を確認)";
const DEPLOY_ENDPOINT = "/k/v1/preview/app/deploy.json";
const SET_CONFIG_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 30;
const SAVE_ONLY_MESSAGE = "保存しました。アプリ更新で反映されます";
const DEPLOY_SUCCESS_MESSAGE = "保存し、運用環境へ反映しました";
const MANUAL_DEPLOY_MESSAGE =
  "設定は保存済みです。アプリ設定から手動でアプリ更新してください。";
const IMPORT_SUCCESS_MESSAGE =
  "設定を読み込みました。内容を確認して保存してください。";

const wait: Wait = (milliseconds) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

export function buildPluginConfig(
  values: Pick<
    PluginConfig,
    "auditAppId" | "requestAppId" | "logAppId" | "startAllowedNetworks"
  >,
  deployOnSave: boolean,
): PluginConfig {
  return deployOnSave ? { ...values } : { ...values, deployOnSave: "false" };
}

function validationError(
  field: EditableConfigField,
  message: string | null,
): ConfigValidationError {
  return new ConfigValidationError(message ?? "設定値が不正です。", field);
}

function validateEditableConfig(
  values: Readonly<Record<string, unknown>>,
  deployOnSave: unknown,
): EditablePluginConfig {
  const audit = validateAuditAppIdOverride(values.auditAppId);
  if (!audit.valid || audit.value === null)
    throw validationError("auditAppId", audit.message);
  const request = validateRequestAppId(values.requestAppId);
  if (!request.valid || request.value === null)
    throw validationError("requestAppId", request.message);
  const log = validateLogAppId(values.logAppId);
  if (!log.valid || log.value === null)
    throw validationError("logAppId", log.message);
  const networks = validateStartAllowedNetworks(values.startAllowedNetworks);
  if (!networks.valid || networks.value === null)
    throw validationError("startAllowedNetworks", networks.message);

  let shouldDeploy: boolean;
  if (deployOnSave === undefined || deployOnSave === true) {
    shouldDeploy = true;
  } else if (deployOnSave === false || deployOnSave === "false") {
    shouldDeploy = false;
  } else {
    throw validationError("deployOnSave", "保存時のアプリ更新設定が不正です。");
  }
  return {
    auditAppId: audit.value,
    requestAppId: request.value,
    logAppId: log.value,
    startAllowedNetworks: networks.value,
    deployOnSave: shouldDeploy,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** メタ情報付き・素のどちらも受理し、既知の全設定だけを検証して返す。 */
export function applyImported(raw: unknown): EditablePluginConfig {
  if (!isRecord(raw)) throw new Error("設定データが見つかりません。");
  const body = isRecord(raw.config) ? raw.config : raw;
  return validateEditableConfig(body, body.deployOnSave);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dateText(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

export function buildConfigBackup(
  config: EditablePluginConfig,
  metadata: {
    readonly pluginId: string;
    readonly appId: number | null;
    readonly appName: string;
  },
  date = new Date(),
): { readonly payload: ConfigBackupPayload; readonly filename: string } {
  return {
    payload: {
      date: dateText(date),
      pluginName: "kSQL-FlowNet Run Activity",
      pluginId: metadata.pluginId,
      appId: metadata.appId,
      appName: metadata.appName,
      config,
    },
    filename: `flownet-activity-app${metadata.appId ?? "x"}-${dateStamp(date)}.json`,
  };
}

function setConfigAsync(
  kintoneApi: ConfigKintone,
  config: PluginConfig,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      kintoneApi.plugin.app.setConfig(config, () => {
        done = true;
        if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
        resolve();
      });
    } catch (cause) {
      reject(cause);
      return;
    }
    if (!done) {
      timeoutId = globalThis.setTimeout(
        () => reject(new Error("setConfig callback timeout")),
        timeoutMs,
      );
    }
  });
}

async function deployAndWait(
  kintoneApi: ConfigKintone,
  appId: number,
  waitFor: Wait,
): Promise<SaveConfigOutcome> {
  const endpoint = kintoneApi.api.url(DEPLOY_ENDPOINT, true);
  await kintoneApi.api(endpoint, "POST", { apps: [{ app: appId }] });
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await waitFor(POLL_INTERVAL_MS);
    const response = await kintoneApi.api(endpoint, "GET", { apps: [appId] });
    const status = response.apps?.[0]?.status;
    if (status === "SUCCESS") {
      return { ok: true, message: DEPLOY_SUCCESS_MESSAGE };
    }
    if (status === "FAIL" || status === "CANCEL") {
      return {
        ok: false,
        message: `アプリ更新に失敗しました(${status})。${MANUAL_DEPLOY_MESSAGE}`,
      };
    }
  }
  return {
    ok: false,
    message: `運用環境への反映がタイムアウトしました。${MANUAL_DEPLOY_MESSAGE}`,
  };
}

export async function saveConfigAndDeploy(
  kintoneApi: ConfigKintone,
  config: PluginConfig,
  options: SaveConfigOptions,
): Promise<SaveConfigOutcome> {
  try {
    await setConfigAsync(
      kintoneApi,
      config,
      options.setConfigTimeoutMs ?? SET_CONFIG_TIMEOUT_MS,
    );
  } catch {
    return {
      ok: false,
      message:
        "設定の保存完了を確認できませんでした。画面を閉じず、もう一度保存してください。",
    };
  }
  if (!options.deploy) return { ok: true, message: SAVE_ONLY_MESSAGE };
  if (options.appId === null) {
    return {
      ok: false,
      message: `アプリIDを取得できませんでした。${MANUAL_DEPLOY_MESSAGE}`,
    };
  }
  try {
    return await deployAndWait(kintoneApi, options.appId, options.wait ?? wait);
  } catch {
    return {
      ok: false,
      message: `運用環境への反映に失敗しました。${MANUAL_DEPLOY_MESSAGE}`,
    };
  }
}

function showCallout(
  element: HTMLElement,
  kind: "progress" | "success" | "error",
  message: string,
): void {
  element.textContent = message;
  element.className = `ksql-flownet-config-callout ksql-flownet-config-callout-${kind}`;
}

function createAppNameLookup(kintoneApi: ConfigKintone): AppNameLookup {
  const cache = new Map<string, Promise<string | null>>();
  return (appId) => {
    const cached = cache.get(appId);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<string | null> => {
      try {
        const response = await kintoneApi.api(
          kintoneApi.api.url("/k/v1/app.json", true),
          "GET",
          { id: appId },
        );
        return typeof response.name === "string" && response.name !== ""
          ? response.name
          : null;
      } catch {
        return null;
      }
    })();
    cache.set(appId, pending);
    return pending;
  };
}

function bindAppPreview(
  field: ConfigFieldElements,
  lookupAppName: AppNameLookup,
): void {
  let requestSequence = 0;
  field.input.addEventListener("blur", () => {
    const sequence = ++requestSequence;
    const appId = field.input.value;
    if (appId === "") {
      field.preview.textContent = "";
      field.preview.className = "ksql-flownet-config-preview";
      return;
    }
    if (!POSITIVE_DECIMAL.test(appId)) {
      field.preview.textContent = PREVIEW_UNAVAILABLE;
      field.preview.className =
        "ksql-flownet-config-preview ksql-flownet-config-preview-error";
      return;
    }
    field.preview.textContent = "";
    field.preview.className = "ksql-flownet-config-preview";
    void lookupAppName(appId).then((name) => {
      if (sequence !== requestSequence) return;
      if (name === null) {
        field.preview.textContent = PREVIEW_UNAVAILABLE;
        field.preview.className =
          "ksql-flownet-config-preview ksql-flownet-config-preview-error";
        return;
      }
      field.preview.textContent = `→ ${name}`;
      field.preview.className = "ksql-flownet-config-preview";
    });
  });
}

async function renderAutoDetection(
  kintoneApi: ConfigKintone,
  fields: Readonly<Record<keyof RelatedAppIds, ConfigFieldElements>>,
  lookupAppName: AppNameLookup,
): Promise<void> {
  const stateAppId = kintoneApi.app.getId();
  let detected: RelatedAppIds = {
    auditAppId: "",
    requestAppId: "",
    logAppId: "",
  };
  if (stateAppId !== null) {
    try {
      const response = await kintoneApi.api(
        kintoneApi.api.url("/k/v1/app/form/fields.json", true),
        "GET",
        { app: stateAppId },
      );
      detected = detectRelatedAppIds(response);
    } catch {
      // 表示補助だけのため、設定画面の保存操作は止めない。
    }
  }

  await Promise.all(
    (Object.keys(fields) as (keyof RelatedAppIds)[]).map(async (key) => {
      const appId = detected[key];
      if (appId === "") {
        fields[key].detection.textContent = DETECTION_UNAVAILABLE;
        return;
      }
      const name = await lookupAppName(appId);
      fields[key].detection.textContent =
        name === null ? `自動検出: ${appId}` : `自動検出: ${appId} (${name})`;
      // 入力欄にも「空欄=自動検出」であることを薄字で示す(2026-09-01要望)
      fields[key].input.setAttribute(
        "placeholder",
        `空欄で自動検出 (${appId})`,
      );
    }),
  );
}

export function installConfigPage(
  kintoneApi: ConfigKintone,
  pluginId: string,
  pageDocument: Document,
): void {
  const basicTab = pageDocument.querySelector<HTMLButtonElement>(
    "#ksql-flownet-config-tab-basic",
  );
  const advancedTab = pageDocument.querySelector<HTMLButtonElement>(
    "#ksql-flownet-config-tab-advanced",
  );
  const basicPanel = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-config-panel-basic",
  );
  const advancedPanel = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-config-panel-advanced",
  );
  const input = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-audit-app-id",
  );
  const requestInput = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-request-app-id",
  );
  const logInput = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-log-app-id",
  );
  const startAllowedNetworks = pageDocument.querySelector<HTMLTextAreaElement>(
    "#ksql-flownet-start-allowed-networks",
  );
  const auditDetection = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-audit-app-detection",
  );
  const auditPreview = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-audit-app-preview",
  );
  const requestDetection = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-request-app-detection",
  );
  const requestPreview = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-request-app-preview",
  );
  const logDetection = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-log-app-detection",
  );
  const logPreview = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-log-app-preview",
  );
  const form = pageDocument.querySelector<HTMLFormElement>(
    "#ksql-flownet-config-form",
  );
  const error = pageDocument.querySelector<HTMLElement>(
    "#ksql-flownet-config-error",
  );
  const deployOnSave = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-deploy-on-save",
  );
  const cancel = pageDocument.querySelector<HTMLButtonElement>(
    "#ksql-flownet-config-cancel",
  );
  const download = pageDocument.querySelector<HTMLButtonElement>(
    "#ksql-flownet-config-download",
  );
  const upload = pageDocument.querySelector<HTMLButtonElement>(
    "#ksql-flownet-config-upload",
  );
  const importFile = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-config-import-file",
  );
  if (
    basicTab === null ||
    advancedTab === null ||
    basicPanel === null ||
    advancedPanel === null ||
    input === null ||
    requestInput === null ||
    logInput === null ||
    startAllowedNetworks === null ||
    auditDetection === null ||
    auditPreview === null ||
    requestDetection === null ||
    requestPreview === null ||
    logDetection === null ||
    logPreview === null ||
    form === null ||
    error === null ||
    deployOnSave === null ||
    cancel === null ||
    download === null ||
    upload === null ||
    importFile === null
  ) {
    throw new Error(
      "プラグイン設定画面の要素が不足しています。引数を確認してください。",
    );
  }

  const selectTab = (selected: ConfigTab): void => {
    const basicSelected = selected === "basic";
    basicTab.setAttribute("aria-selected", String(basicSelected));
    advancedTab.setAttribute("aria-selected", String(!basicSelected));
    basicPanel.hidden = !basicSelected;
    advancedPanel.hidden = basicSelected;
  };
  const tabByField: Readonly<Record<EditableConfigField, ConfigTab>> = {
    auditAppId: "advanced",
    requestAppId: "advanced",
    logAppId: "advanced",
    startAllowedNetworks: "basic",
    deployOnSave: "basic",
  };
  basicTab.addEventListener("click", () => selectTab("basic"));
  advancedTab.addEventListener("click", () => selectTab("advanced"));
  selectTab("basic");

  const savedConfig = kintoneApi.plugin.app.getConfig(pluginId);
  input.value = savedConfig.auditAppId ?? "";
  requestInput.value = savedConfig.requestAppId ?? "";
  logInput.value = savedConfig.logAppId ?? "";
  startAllowedNetworks.value = savedConfig.startAllowedNetworks ?? "";
  deployOnSave.checked = savedConfig.deployOnSave !== "false";
  const fields = {
    auditAppId: {
      input,
      detection: auditDetection,
      preview: auditPreview,
    },
    requestAppId: {
      input: requestInput,
      detection: requestDetection,
      preview: requestPreview,
    },
    logAppId: {
      input: logInput,
      detection: logDetection,
      preview: logPreview,
    },
  } satisfies Record<keyof RelatedAppIds, ConfigFieldElements>;
  const lookupAppName = createAppNameLookup(kintoneApi);
  for (const field of Object.values(fields)) {
    bindAppPreview(field, lookupAppName);
  }
  void renderAutoDetection(kintoneApi, fields, lookupAppName);

  const readFormConfig = (): EditablePluginConfig =>
    validateEditableConfig(
      {
        auditAppId: input.value,
        requestAppId: requestInput.value,
        logAppId: logInput.value,
        startAllowedNetworks: startAllowedNetworks.value,
      },
      deployOnSave.checked,
    );

  download.addEventListener("click", () => {
    let config: EditablePluginConfig;
    try {
      config = readFormConfig();
    } catch (cause) {
      showCallout(
        error,
        "error",
        cause instanceof Error ? cause.message : "設定値が不正です。",
      );
      return;
    }
    const appId = kintoneApi.app.getId();
    void (async () => {
      const appName =
        appId === null ? "" : ((await lookupAppName(String(appId))) ?? "");
      const backup = buildConfigBackup(
        config,
        { pluginId, appId, appName },
        new Date(),
      );
      const blob = new Blob([JSON.stringify(backup.payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = pageDocument.createElement("a");
      anchor.href = url;
      anchor.download = backup.filename;
      pageDocument.body.appendChild(anchor);
      anchor.click();
      pageDocument.body.removeChild(anchor);
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      showCallout(
        error,
        "success",
        `設定をダウンロードしました: ${backup.filename}`,
      );
    })();
  });

  upload.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (file === undefined) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      try {
        const config = applyImported(JSON.parse(String(reader.result)));
        input.value = config.auditAppId;
        requestInput.value = config.requestAppId;
        logInput.value = config.logAppId;
        startAllowedNetworks.value = config.startAllowedNetworks;
        deployOnSave.checked = config.deployOnSave;
        for (const field of Object.values(fields)) {
          field.preview.textContent = "";
          field.preview.className = "ksql-flownet-config-preview";
        }
        showCallout(error, "success", IMPORT_SUCCESS_MESSAGE);
      } catch (cause) {
        showCallout(
          error,
          "error",
          `読み込みに失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });
    reader.addEventListener("error", () =>
      showCallout(error, "error", "ファイルの読み込みに失敗しました。"),
    );
    reader.readAsText(file);
  });

  let saving = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (saving) return;
    let editableConfig: EditablePluginConfig;
    try {
      editableConfig = readFormConfig();
    } catch (cause) {
      if (cause instanceof ConfigValidationError) {
        selectTab(tabByField[cause.field]);
      }
      showCallout(
        error,
        "error",
        cause instanceof Error ? cause.message : "設定値が不正です。",
      );
      return;
    }
    const shouldDeploy = editableConfig.deployOnSave;
    const config = buildPluginConfig(
      {
        auditAppId: editableConfig.auditAppId,
        requestAppId: editableConfig.requestAppId,
        logAppId: editableConfig.logAppId,
        startAllowedNetworks: editableConfig.startAllowedNetworks,
      },
      shouldDeploy,
    );
    saving = true;
    showCallout(
      error,
      "progress",
      shouldDeploy ? "保存し、運用環境へ反映しています…" : "保存しています…",
    );
    void saveConfigAndDeploy(kintoneApi, config, {
      deploy: shouldDeploy,
      appId: kintoneApi.app.getId(),
    }).then((outcome) => {
      saving = false;
      showCallout(error, outcome.ok ? "success" : "error", outcome.message);
      // 「保存時に運用環境へ反映」チェック時は画面に留まる(2026-09-02実機
      // フィードバック: 別タブで動作確認しながら設定変更を繰り返せるように)。
      // 未チェック時は従来どおり設定一覧へ戻る。
      if (outcome.ok && !shouldDeploy) {
        // calloutの描画機会を設けてから設定一覧へ戻る。
        globalThis.setTimeout(() => globalThis.history.back(), 0);
      }
    });
  });
  cancel.addEventListener("click", () => globalThis.history.back());
}

/**
 * kintone設定ページはconfig.htmlの中身を挿入する前にJSを実行することがあるため、
 * DOM未構築(loading)ならDOMContentLoadedまで待つ(2026-09-01実機: 即時実行だと
 * 要素不足エラーになった)。
 */
export function bootstrapConfigPage(
  kintoneApi: ConfigKintone,
  pageDocument: Document,
): void {
  const install = () =>
    installConfigPage(kintoneApi, kintoneApi.$PLUGIN_ID, pageDocument);
  if (pageDocument.readyState === "loading") {
    pageDocument.addEventListener("DOMContentLoaded", install, { once: true });
    return;
  }
  install();
}

declare const kintone: ConfigKintone | undefined;
declare const document: Document | undefined;
if (
  typeof kintone !== "undefined" &&
  typeof document !== "undefined" &&
  typeof kintone.$PLUGIN_ID === "string"
) {
  bootstrapConfigPage(kintone, document);
}
