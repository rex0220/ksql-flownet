import {
  validateAuditAppIdOverride,
  validateLogAppId,
  validateRequestAppId,
  type PluginConfig,
} from "./config-validation.js";
import {
  detectRelatedAppIds,
  type FormFieldsResponse,
  type RelatedAppIds,
} from "./related-app-detection.js";

export {
  validateAuditAppId,
  validateAuditAppIdOverride,
  validateLogAppId,
  validateRequestAppId,
  type ConfigValidationResult,
  type PluginConfig,
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
    url(path: string, guestSpace: boolean): string;
  };
}

interface ConfigFieldElements {
  readonly input: HTMLInputElement;
  readonly detection: HTMLElement;
  readonly preview: HTMLElement;
}

type AppNameLookup = (appId: string) => Promise<string | null>;

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const DETECTION_UNAVAILABLE = "自動検出できません(関連レコード一覧が未設定)";
const PREVIEW_UNAVAILABLE = "アプリを確認できません(IDまたは権限を確認)";

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
    }),
  );
}

export function installConfigPage(
  kintoneApi: ConfigKintone,
  pluginId: string,
  pageDocument: Document,
): void {
  const input = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-audit-app-id",
  );
  const requestInput = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-request-app-id",
  );
  const logInput = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-log-app-id",
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
  const cancel = pageDocument.querySelector<HTMLButtonElement>(
    "#ksql-flownet-config-cancel",
  );
  if (
    input === null ||
    requestInput === null ||
    logInput === null ||
    auditDetection === null ||
    auditPreview === null ||
    requestDetection === null ||
    requestPreview === null ||
    logDetection === null ||
    logPreview === null ||
    form === null ||
    error === null ||
    cancel === null
  ) {
    throw new Error(
      "プラグイン設定画面の要素が不足しています。引数を確認してください。",
    );
  }

  const savedConfig = kintoneApi.plugin.app.getConfig(pluginId);
  input.value = savedConfig.auditAppId ?? "";
  requestInput.value = savedConfig.requestAppId ?? "";
  logInput.value = savedConfig.logAppId ?? "";
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = validateAuditAppIdOverride(input.value);
    if (!result.valid || result.value === null) {
      error.textContent = result.message;
      return;
    }
    const requestResult = validateRequestAppId(requestInput.value);
    if (!requestResult.valid || requestResult.value === null) {
      error.textContent = requestResult.message;
      return;
    }
    const logResult = validateLogAppId(logInput.value);
    if (!logResult.valid || logResult.value === null) {
      error.textContent = logResult.message;
      return;
    }
    error.textContent = "";
    kintoneApi.plugin.app.setConfig(
      {
        auditAppId: result.value,
        requestAppId: requestResult.value,
        logAppId: logResult.value,
      },
      () => globalThis.history.back(),
    );
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
