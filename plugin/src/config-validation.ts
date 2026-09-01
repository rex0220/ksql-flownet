/**
 * 設定値の検証(副作用なしの純モジュール)。
 * desktop.tsからも使うため、設定画面の設置副作用を持つconfig.tsから分離している。
 * config.tsをdesktopバンドルへ含めると、一覧画面で設定画面の設置が実行され
 * 要素不足エラーになる(2026-09-01実機)。
 */
export interface PluginConfig {
  readonly auditAppId: string;
  readonly requestAppId: string;
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
