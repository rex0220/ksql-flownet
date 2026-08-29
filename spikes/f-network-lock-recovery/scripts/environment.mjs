const FORBIDDEN_APP_IDS = new Set(["4246", "4247", "4249"]);

function requireValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`必要な環境変数がありません: ${name}`);
  return value;
}

function requireAppId(environment, name) {
  const value = requireValue(environment, name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} は数字のアプリIDで指定してください。`);
  }
  if (FORBIDDEN_APP_IDS.has(value)) {
    throw new Error(
      `既存アプリID ${value} への書込みは禁止されています。スパイク専用アプリを指定してください。`,
    );
  }
  return value;
}

export function requireSpikeFEnvironment(environment = process.env) {
  const rawBaseUrl = requireValue(environment, "KSQL_SPIKE_BASE_URL");
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("KSQL_SPIKE_BASE_URL が有効なURLではありません。");
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error("KSQL_SPIKE_BASE_URL は https URLで指定してください。");
  }
  const executionApp = requireAppId(environment, "KSQL_SPIKE_APP_EXEC");
  const auditApp = requireAppId(environment, "KSQL_SPIKE_APP_AUDIT");
  if (executionApp === auditApp) {
    throw new Error("Spike Fは異なる実行管理appと監査appを必要とします。");
  }
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    execution: {
      app: executionApp,
      token: requireValue(environment, "KSQL_SPIKE_TOKEN_EXEC"),
    },
    audit: {
      app: auditApp,
      token: requireValue(environment, "KSQL_SPIKE_TOKEN_AUDIT"),
    },
  };
}

export function spikeFSecrets(config) {
  return [config.execution.token, config.audit.token];
}
