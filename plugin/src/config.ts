export interface PluginConfig {
  readonly auditAppId: string;
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly value: string | null;
  readonly message: string | null;
}

export function validateAuditAppId(value: unknown): ConfigValidationResult {
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    return { valid: true, value, message: null };
  }
  return {
    valid: false,
    value: null,
    message: "監査履歴アプリIDを正の10進整数で設定してください。",
  };
}

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

declare const kintone: ConfigKintone | undefined;
declare const document: Document | undefined;
if (
  typeof kintone !== "undefined" &&
  typeof document !== "undefined" &&
  typeof kintone.$PLUGIN_ID === "string"
) {
  installConfigPage(kintone, kintone.$PLUGIN_ID, document);
}
