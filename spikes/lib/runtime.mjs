import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_APP_IDS = new Set(["4246", "4247", "4249"]);
const SECRET_KEY_PATTERN = /(?:authorization|api[-_]?token|token)/i;

export function requireExecutionEnvironment(environment = process.env) {
  const names = [
    "KSQL_SPIKE_BASE_URL",
    "KSQL_SPIKE_APP_EXEC",
    "KSQL_SPIKE_TOKEN_EXEC",
  ];
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`必要な環境変数がありません: ${missing.join(", ")}`);
  }

  const app = environment.KSQL_SPIKE_APP_EXEC.trim();
  if (!/^\d+$/.test(app)) {
    throw new Error("KSQL_SPIKE_APP_EXEC は数字のアプリIDで指定してください。");
  }
  if (FORBIDDEN_APP_IDS.has(app)) {
    throw new Error(
      `既存アプリID ${app} への書込みは禁止されています。スパイク専用アプリを指定してください。`,
    );
  }

  let baseUrl;
  try {
    baseUrl = new URL(environment.KSQL_SPIKE_BASE_URL.trim());
  } catch {
    throw new Error("KSQL_SPIKE_BASE_URL が有効なURLではありません。");
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error("KSQL_SPIKE_BASE_URL は https URLで指定してください。");
  }

  return {
    app,
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    token: environment.KSQL_SPIKE_TOKEN_EXEC,
  };
}

export function parsePositiveIntegerOption(
  arguments_,
  name,
  defaultValue,
  { minimum = 1 } = {},
) {
  const index = arguments_.indexOf(name);
  if (index === -1) return defaultValue;
  const raw = arguments_[index + 1];
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} は ${minimum} 以上の整数で指定してください。`);
  }
  return value;
}

export function sanitize(value, secretValues = []) {
  const secrets = secretValues.filter(
    (secret) => typeof secret === "string" && secret.length > 0,
  );
  const visit = (current) => {
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current)
          .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
          .map(([key, nested]) => [key, visit(nested)]),
      );
    }
    if (typeof current === "string") {
      let redacted = current;
      for (const secret of secrets)
        redacted = redacted.replaceAll(secret, "[REDACTED]");
      return redacted;
    }
    return current;
  };
  return visit(value);
}

export async function writeResult(importMetaUrl, result, secretValues = []) {
  const safe = sanitize(result, secretValues);
  const serialized = `${JSON.stringify(safe, null, 2)}\n`;
  for (const secret of secretValues) {
    if (secret && serialized.includes(secret)) {
      throw new Error("結果JSONに秘密値が含まれるため保存を中止しました。");
    }
  }
  if (/"(?:authorization|[^"\n]*token[^"\n]*)"\s*:/i.test(serialized)) {
    throw new Error(
      "結果JSONに秘密フィールドが含まれるため保存を中止しました。",
    );
  }

  const scriptDirectory = dirname(fileURLToPath(importMetaUrl));
  const spikeDirectory = dirname(scriptDirectory);
  const resultDirectory = join(spikeDirectory, "results");
  await mkdir(resultDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const scriptName = fileURLToPath(importMetaUrl)
    .split(/[\\/]/)
    .at(-1)
    .replace(/\.mjs$/, "");
  const path = join(resultDirectory, `${stamp}-${scriptName}.json`);
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
  return path;
}

export function isMain(importMetaUrl, argument = process.argv[1]) {
  return Boolean(argument) && fileURLToPath(importMetaUrl) === argument;
}

export function makeRunMetadata(measurementIds) {
  return {
    measurementIds,
    observedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown",
  };
}
