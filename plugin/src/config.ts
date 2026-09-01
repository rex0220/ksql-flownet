import { validateAuditAppId, type PluginConfig } from "./config-validation.js";

export {
  validateAuditAppId,
  type ConfigValidationResult,
  type PluginConfig,
} from "./config-validation.js";

interface ConfigKintone {
  readonly $PLUGIN_ID: string;
  readonly plugin: {
    readonly app: {
      getConfig(pluginId: string): Readonly<Record<string, string>>;
      setConfig(config: PluginConfig, callback: () => void): void;
    };
  };
}

export function installConfigPage(
  kintoneApi: ConfigKintone,
  pluginId: string,
  pageDocument: Document,
): void {
  const input = pageDocument.querySelector<HTMLInputElement>(
    "#ksql-flownet-audit-app-id",
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
  if (input === null || form === null || error === null || cancel === null) {
    throw new Error(
      "プラグイン設定画面の要素が不足しています。引数を確認してください。",
    );
  }

  input.value = kintoneApi.plugin.app.getConfig(pluginId).auditAppId ?? "";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = validateAuditAppId(input.value);
    if (!result.valid || result.value === null) {
      error.textContent = result.message;
      return;
    }
    error.textContent = "";
    kintoneApi.plugin.app.setConfig({ auditAppId: result.value }, () =>
      globalThis.history.back(),
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
