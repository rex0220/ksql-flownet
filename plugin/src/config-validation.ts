/**
 * 設定値の検証(副作用なしの純モジュール)。
 * desktop.tsからも使うため、設定画面の設置副作用を持つconfig.tsから分離している。
 * config.tsをdesktopバンドルへ含めると、一覧画面で設定画面の設置が実行され
 * 要素不足エラーになる(2026-09-01実機)。
 */
export interface PluginConfig {
  readonly auditAppId: string;
  readonly requestAppId: string;
  readonly logAppId: string;
  readonly startAllowedNetworks: string;
  readonly deployOnSave?: "false";
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly value: string | null;
  readonly message: string | null;
}

export const START_ALLOWED_NETWORK_LINE_LIMIT = 128;
export const START_ALLOWED_NETWORK_TOTAL_LIMIT = 4_000;

export interface StartAllowedNetwork {
  readonly label: string;
  readonly networkId: string;
}

/** 改行区切りのSTART候補を、network_idの入力順を保った一意な保存文字列へ正規化する。 */
export function validateStartAllowedNetworks(
  value: unknown,
): ConfigValidationResult {
  if (value === undefined || value === "") {
    return { valid: true, value: "", message: null };
  }
  if (typeof value !== "string") {
    return {
      valid: false,
      value: null,
      message: "START許可ネットワーク一覧を文字列で入力してください。",
    };
  }
  if (Array.from(value).length > START_ALLOWED_NETWORK_TOTAL_LIMIT) {
    return {
      valid: false,
      value: null,
      message: `START許可ネットワーク一覧は全体で${START_ALLOWED_NETWORK_TOTAL_LIMIT}文字以内にしてください。`,
    };
  }
  const networkIds = new Set<string>();
  const normalized: string[] = [];
  for (const sourceLine of value.split(/\r?\n|\r/u)) {
    const line = sourceLine.trim();
    if (line === "") continue;
    if (Array.from(line).length > START_ALLOWED_NETWORK_LINE_LIMIT) {
      return {
        valid: false,
        value: null,
        message: `START許可ネットワーク一覧は1行${START_ALLOWED_NETWORK_LINE_LIMIT}文字以内にしてください。`,
      };
    }
    const columns = line.split(",");
    if (columns.length > 2) {
      return {
        valid: false,
        value: null,
        message:
          "各行は「ネットワーク名, network_id」の2列で入力してください。",
      };
    }
    const label = columns[0]?.trim() ?? "";
    const networkId = (columns[1] ?? columns[0])?.trim() ?? "";
    if (label === "" || networkId === "") {
      return {
        valid: false,
        value: null,
        message: "ネットワーク名とnetwork_idは空にせず入力してください。",
      };
    }
    if (networkIds.has(networkId)) continue;
    networkIds.add(networkId);
    normalized.push(
      columns.length === 1 ? networkId : `${label}, ${networkId}`,
    );
  }
  return { valid: true, value: normalized.join("\n"), message: null };
}

export function parseStartAllowedNetworks(
  value: unknown,
): readonly StartAllowedNetwork[] {
  const result = validateStartAllowedNetworks(value);
  if (!result.valid || result.value === null || result.value === "") return [];
  return result.value.split("\n").map((line) => {
    const [first, second] = line.split(",");
    const label = first?.trim() ?? "";
    return { label, networkId: second?.trim() ?? label };
  });
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

export function validateAuditAppIdOverride(
  value: unknown,
): ConfigValidationResult {
  if (value === undefined || value === "") {
    return { valid: true, value: "", message: null };
  }
  return validateAuditAppId(value);
}

export function validateRequestAppId(value: unknown): ConfigValidationResult {
  if (value === undefined || value === "") {
    return { valid: true, value: "", message: null };
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    return { valid: true, value, message: null };
  }
  return {
    valid: false,
    value: null,
    message: "操作要求アプリIDは空欄または正の10進整数で設定してください。",
  };
}

export function validateLogAppId(value: unknown): ConfigValidationResult {
  if (value === undefined || value === "") {
    return { valid: true, value: "", message: null };
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    return { valid: true, value, message: null };
  }
  return {
    valid: false,
    value: null,
    message: "JOBログアプリIDは空欄または正の10進整数で設定してください。",
  };
}
