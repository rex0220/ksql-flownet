const FORBIDDEN_APP_IDS = new Set(["4246", "4247", "4249"]);

function requireValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`必要な環境変数がありません: ${name}`);
  return value;
}

function appId(environment, name) {
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

export function requireSpikeAEnvironment(environment = process.env) {
  const baseUrlValue = requireValue(environment, "KSQL_SPIKE_BASE_URL");
  let baseUrl;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new Error("KSQL_SPIKE_BASE_URL が有効なURLではありません。");
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error("KSQL_SPIKE_BASE_URL は https URLで指定してください。");
  }

  return {
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    oneApp: {
      integrated: {
        app: appId(environment, "KSQL_SPIKE_APP_INTEGRATED"),
        token: requireValue(environment, "KSQL_SPIKE_TOKEN_INTEGRATED"),
      },
    },
    twoApp: {
      execution: {
        app: appId(environment, "KSQL_SPIKE_APP_EXEC"),
        token: requireValue(environment, "KSQL_SPIKE_TOKEN_EXEC"),
      },
      audit: {
        app: appId(environment, "KSQL_SPIKE_APP_AUDIT"),
        token: requireValue(environment, "KSQL_SPIKE_TOKEN_AUDIT"),
      },
    },
  };
}

export function secretValues(config) {
  return [
    config.oneApp.integrated.token,
    config.twoApp.execution.token,
    config.twoApp.audit.token,
  ];
}
