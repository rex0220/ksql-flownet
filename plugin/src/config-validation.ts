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
  readonly mode?: "scheduled" | "correction" | "explicit";
  readonly businessKeyTemplate?: string;
}

export interface StartAllowedNetworkGroup {
  readonly label: string | null;
  readonly entries: readonly StartAllowedNetwork[];
}

export interface ParsedStartAllowedNetworks {
  readonly groups: readonly StartAllowedNetworkGroup[];
}

const START_MODE_BY_CSV_VALUE = {
  定期: "scheduled",
  補正: "correction",
  任意キー: "explicit",
} as const;

const BUSINESS_KEY_TEMPLATE_PLACEHOLDERS = new Set([
  "{ネットワークID}",
  "{年}",
  "{月}",
  "{日}",
]);

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
    if (Array.from(sourceLine).length > START_ALLOWED_NETWORK_LINE_LIMIT) {
      return {
        valid: false,
        value: null,
        message: `START許可ネットワーク一覧は1行${START_ALLOWED_NETWORK_LINE_LIMIT}文字以内にしてください。`,
      };
    }
    if (/^-{3,}/u.test(line)) {
      normalized.push(sourceLine);
      continue;
    }
    const columns = line.split(",");
    if (columns.length > 4) {
      return {
        valid: false,
        value: null,
        message:
          "各行は「ネットワーク名, network_id, 入力モード, business_keyテンプレート」の4列以内で入力してください。",
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
    const csvMode = columns[2]?.trim() ?? "";
    if (
      columns.length >= 3 &&
      csvMode !== "" &&
      !(csvMode in START_MODE_BY_CSV_VALUE)
    ) {
      return {
        valid: false,
        value: null,
        message: "入力モードは 定期/補正/任意キー のいずれかで指定してください",
      };
    }
    if (columns.length >= 4 && csvMode === "") {
      return {
        valid: false,
        value: null,
        message:
          "business_keyテンプレートを指定する場合は入力モードも指定してください。",
      };
    }
    const businessKeyTemplate = columns[3]?.trim() ?? "";
    if (columns.length >= 4 && csvMode === "定期") {
      return {
        valid: false,
        value: null,
        message: "定期モードにbusiness_keyテンプレートは指定できません",
      };
    }
    const placeholders = businessKeyTemplate.match(/\{[^{}]*\}/gu) ?? [];
    const templateRemainder = businessKeyTemplate.replace(/\{[^{}]*\}/gu, "");
    if (
      placeholders.some(
        (placeholder) => !BUSINESS_KEY_TEMPLATE_PLACEHOLDERS.has(placeholder),
      ) ||
      templateRemainder.includes("{") ||
      templateRemainder.includes("}")
    ) {
      return {
        valid: false,
        value: null,
        message:
          "business_keyテンプレートのプレースホルダは {ネットワークID}/{年}/{月}/{日} のみ使用できます。",
      };
    }
    if (networkIds.has(networkId)) continue;
    networkIds.add(networkId);
    const normalizedColumns = [label, networkId, csvMode, businessKeyTemplate];
    normalized.push(
      columns.length === 1
        ? networkId
        : normalizedColumns.slice(0, columns.length).join(", "),
    );
  }
  return { valid: true, value: normalized.join("\n"), message: null };
}

export function parseStartAllowedNetworks(
  value: unknown,
): ParsedStartAllowedNetworks {
  const result = validateStartAllowedNetworks(value);
  if (!result.valid || result.value === null || result.value === "") {
    return { groups: [] };
  }
  const groups: Array<{
    label: string | null;
    entries: StartAllowedNetwork[];
  }> = [];
  let currentGroup: { label: string | null; entries: StartAllowedNetwork[] } = {
    label: null,
    entries: [],
  };
  for (const line of result.value.split("\n")) {
    const separator = /^-{3,}(.*)$/u.exec(line.trim());
    if (separator !== null) {
      if (currentGroup.entries.length > 0) groups.push(currentGroup);
      currentGroup = { label: separator[1]?.trim() ?? "", entries: [] };
      continue;
    }
    const [first, second, third, fourth] = line.split(",");
    const label = first?.trim() ?? "";
    const csvMode = third?.trim() ?? "";
    currentGroup.entries.push({
      label,
      networkId: second?.trim() ?? label,
      ...(csvMode === ""
        ? {}
        : {
            mode: START_MODE_BY_CSV_VALUE[
              csvMode as keyof typeof START_MODE_BY_CSV_VALUE
            ],
          }),
      ...(fourth === undefined || fourth.trim() === ""
        ? {}
        : { businessKeyTemplate: fourth.trim() }),
    });
  }
  if (currentGroup.entries.length > 0) groups.push(currentGroup);
  return { groups };
}

export function flattenStartAllowedNetworks(
  parsed: ParsedStartAllowedNetworks,
): readonly StartAllowedNetwork[] {
  return parsed.groups.flatMap((group) => group.entries);
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
