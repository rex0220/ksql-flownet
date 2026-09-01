import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPluginConfig,
  installConfigPage,
  saveConfigAndDeploy,
  validateAuditAppId,
  validateAuditAppIdOverride,
  validateLogAppId,
  validateRequestAppId,
} from "../../dist/plugin/config.js";

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function inputElement(value = "") {
  const listeners = new Map();
  const attributes = new Map();
  return {
    value,
    attributes,
    setAttribute: (name, attributeValue) =>
      attributes.set(name, String(attributeValue)),
    addEventListener: (name, listener) => listeners.set(name, listener),
    dispatch: (name) => listeners.get(name)?.(),
  };
}

function statusElement() {
  return { textContent: "", className: "" };
}

test("auditAppId accepts only a positive decimal string without normalization", () => {
  for (const invalid of [undefined, "", "0", "-1", "1.5", " 12", "12 ", "abc"])
    assert.equal(validateAuditAppId(invalid).valid, false, String(invalid));
  for (const valid of ["1", "12", "9007199254740993"]) {
    assert.deepEqual(validateAuditAppId(valid), {
      valid: true,
      value: valid,
      message: null,
    });
  }
});

test("auditAppId override accepts empty for automatic detection", () => {
  for (const valid of [undefined, "", "1", "9007199254740993"])
    assert.equal(validateAuditAppIdOverride(valid).valid, true, String(valid));
  for (const invalid of [null, "0", "-1", " 12", "12 ", "abc"])
    assert.equal(
      validateAuditAppIdOverride(invalid).valid,
      false,
      String(invalid),
    );
});

test("requestAppId accepts empty or a positive decimal string", () => {
  for (const valid of [undefined, "", "1", "9007199254740993"])
    assert.equal(validateRequestAppId(valid).valid, true, String(valid));
  for (const invalid of [null, "0", "-1", "1.5", " 12", "12 ", "abc"])
    assert.equal(validateRequestAppId(invalid).valid, false, String(invalid));
});

test("logAppId accepts empty or a positive decimal string", () => {
  for (const valid of [undefined, "", "1", "9007199254740993"])
    assert.equal(validateLogAppId(valid).valid, true, String(valid));
  for (const invalid of [null, "0", "-1", "1.5", " 12", "12 ", "abc"])
    assert.equal(validateLogAppId(invalid).valid, false, String(invalid));
});

test("config page rejects invalid saves and preserves the valid decimal string", async () => {
  const listeners = new Map();
  const input = inputElement();
  const requestInput = inputElement();
  const logInput = inputElement();
  const auditDetection = statusElement();
  const auditPreview = statusElement();
  const requestDetection = statusElement();
  const requestPreview = statusElement();
  const logDetection = statusElement();
  const logPreview = statusElement();
  const error = { textContent: "" };
  const deployOnSave = inputElement();
  const form = {
    addEventListener: (name, listener) =>
      listeners.set(`form:${name}`, listener),
  };
  const cancel = {
    addEventListener: (name, listener) =>
      listeners.set(`cancel:${name}`, listener),
  };
  const elements = new Map([
    ["#ksql-flownet-audit-app-id", input],
    ["#ksql-flownet-request-app-id", requestInput],
    ["#ksql-flownet-log-app-id", logInput],
    ["#ksql-flownet-audit-app-detection", auditDetection],
    ["#ksql-flownet-audit-app-preview", auditPreview],
    ["#ksql-flownet-request-app-detection", requestDetection],
    ["#ksql-flownet-request-app-preview", requestPreview],
    ["#ksql-flownet-log-app-detection", logDetection],
    ["#ksql-flownet-log-app-preview", logPreview],
    ["#ksql-flownet-config-form", form],
    ["#ksql-flownet-config-error", error],
    ["#ksql-flownet-deploy-on-save", deployOnSave],
    ["#ksql-flownet-config-cancel", cancel],
  ]);
  const saved = [];
  const originalHistory = globalThis.history;
  globalThis.history = { back: () => {} };
  const api = async () => ({ properties: {} });
  api.url = (path) => path;
  try {
    installConfigPage(
      {
        $PLUGIN_ID: "plugin-id",
        app: { getId: () => 101 },
        plugin: {
          app: {
            getConfig: () => ({
              auditAppId: "41",
              requestAppId: "51",
              logAppId: "61",
              deployOnSave: "false",
            }),
            setConfig: (config, callback) => {
              saved.push(config);
              callback();
            },
          },
        },
        api,
      },
      "plugin-id",
      { querySelector: (selector) => elements.get(selector) ?? null },
    );
    assert.equal(input.value, "41");
    assert.equal(requestInput.value, "51");
    assert.equal(logInput.value, "61");
    assert.equal(deployOnSave.checked, false, "前回OFFならOFFで復元する");
    input.value = " 42 ";
    listeners.get("form:submit")({ preventDefault: () => {} });
    assert.equal(saved.length, 0);
    assert.match(error.textContent, /正の10進整数/u);
    input.value = "42";
    requestInput.value = " 52 ";
    listeners.get("form:submit")({ preventDefault: () => {} });
    assert.equal(saved.length, 0);
    assert.match(error.textContent, /空欄または正の10進整数/u);
    requestInput.value = "52";
    logInput.value = " 62 ";
    listeners.get("form:submit")({ preventDefault: () => {} });
    assert.equal(saved.length, 0);
    assert.match(error.textContent, /JOBログアプリID/u);
    logInput.value = "62";
    listeners.get("form:submit")({ preventDefault: () => {} });
    await flushAsync();
    input.value = "";
    requestInput.value = "";
    logInput.value = "";
    listeners.get("form:submit")({ preventDefault: () => {} });
    await flushAsync();
    assert.deepEqual(saved, [
      {
        auditAppId: "42",
        requestAppId: "52",
        logAppId: "62",
        deployOnSave: "false",
      },
      {
        auditAppId: "",
        requestAppId: "",
        logAppId: "",
        deployOnSave: "false",
      },
    ]);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  } finally {
    globalThis.history = originalHistory;
  }
});

test("config GETは自アプリの関連先検出とアプリ名確認だけに使い、表示値を入力へ補完しない", async () => {
  const auditInput = inputElement();
  const requestInput = inputElement();
  const logInput = inputElement();
  const auditDetection = statusElement();
  const auditPreview = statusElement();
  const requestDetection = statusElement();
  const requestPreview = statusElement();
  const logDetection = statusElement();
  const logPreview = statusElement();
  const deployOnSave = inputElement();
  const elements = new Map([
    ["#ksql-flownet-audit-app-id", auditInput],
    ["#ksql-flownet-request-app-id", requestInput],
    ["#ksql-flownet-log-app-id", logInput],
    ["#ksql-flownet-audit-app-detection", auditDetection],
    ["#ksql-flownet-audit-app-preview", auditPreview],
    ["#ksql-flownet-request-app-detection", requestDetection],
    ["#ksql-flownet-request-app-preview", requestPreview],
    ["#ksql-flownet-log-app-detection", logDetection],
    ["#ksql-flownet-log-app-preview", logPreview],
    ["#ksql-flownet-config-form", { addEventListener: () => {} }],
    ["#ksql-flownet-config-error", statusElement()],
    ["#ksql-flownet-deploy-on-save", deployOnSave],
    ["#ksql-flownet-config-cancel", { addEventListener: () => {} }],
  ]);
  const calls = [];
  const api = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url === "/k/v1/app/form/fields.json") {
      return {
        properties: {
          related_audit_events: {
            type: "REFERENCE_TABLE",
            referenceTable: { relatedApp: { app: "201" } },
          },
          related_job_logs: {
            type: "REFERENCE_TABLE",
            referenceTable: { relatedApp: { app: "401" } },
          },
        },
      };
    }
    if (body.id === "201") return { name: "監査 <img src=x>" };
    throw new Error("Forbidden");
  };
  api.url = (path, guestSpace) => {
    assert.equal(guestSpace, true);
    return path;
  };

  installConfigPage(
    {
      $PLUGIN_ID: "plugin-id",
      app: { getId: () => 101 },
      plugin: {
        app: { getConfig: () => ({}), setConfig: () => {} },
      },
      api,
    },
    "plugin-id",
    { querySelector: (selector) => elements.get(selector) ?? null },
  );
  await flushAsync();

  assert.equal(deployOnSave.checked, true, "未保存時は既定ON");

  assert.equal(auditInput.value, "", "自動検出しても入力欄は空のまま");
  assert.equal(requestInput.value, "");
  assert.equal(logInput.value, "");
  assert.equal(
    auditDetection.textContent,
    "自動検出: 201 (監査 <img src=x>)",
    "外部アプリ名はtextContentへ設定する",
  );
  assert.equal(
    requestDetection.textContent,
    "自動検出できません(関連レコード一覧が未設定)",
  );
  assert.equal(logDetection.textContent, "自動検出: 401");
  assert.deepEqual(calls, [
    {
      url: "/k/v1/app/form/fields.json",
      method: "GET",
      body: { app: 101 },
    },
    { url: "/k/v1/app.json", method: "GET", body: { id: "201" } },
    { url: "/k/v1/app.json", method: "GET", body: { id: "401" } },
  ]);
  assert.ok(
    calls.every(
      ({ url, method }) =>
        method === "GET" &&
        ["/k/v1/app/form/fields.json", "/k/v1/app.json"].includes(url),
    ),
    "config用GET先を許可された2 endpointへ限定する",
  );

  auditInput.value = "201";
  auditInput.dispatch("blur");
  await flushAsync();
  assert.equal(auditPreview.textContent, "→ 監査 <img src=x>");
  assert.equal(
    calls.filter(
      ({ url, body }) => url === "/k/v1/app.json" && body.id === "201",
    ).length,
    1,
    "自動検出とpreviewで同じappIdを二重fetchしない",
  );

  requestInput.value = " 301 ";
  requestInput.dispatch("blur");
  assert.equal(
    requestPreview.textContent,
    "アプリを確認できません(IDまたは権限を確認)",
  );
  assert.match(requestPreview.className, /preview-error/u);

  logInput.value = "999";
  logInput.dispatch("blur");
  await flushAsync();
  assert.equal(
    logPreview.textContent,
    "アプリを確認できません(IDまたは権限を確認)",
  );
  assert.match(logPreview.className, /preview-error/u);

  requestInput.value = "";
  requestInput.dispatch("blur");
  assert.equal(
    requestPreview.textContent,
    "",
    "空欄は自動検出指定なので警告しない",
  );
});

test("config.htmlはフラグメントのみ(html/head/body/doctype禁止 — kintone埋め込み実機回帰)", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(
    new globalThis.URL("../../plugin/config.html", import.meta.url),
    "utf8",
  );
  for (const forbidden of ["<!doctype", "<html", "<head", "<body"]) {
    assert.ok(
      !new RegExp(`${forbidden}(?:\\s|>)`, "iu").test(html),
      `config.htmlに${forbidden}を含めない(kintoneが中身を埋め込むため)`,
    );
  }
  for (const required of [
    "ksql-flownet-config-header",
    "ksql-flownet-config-brand",
    "ksql-flownet-config-product",
    "ksql-flownet-config-title",
    "ksql-flownet-config-info",
    "ksql-flownet-config-form",
    "ksql-flownet-config-sections",
    "ksql-flownet-config-section",
    "ksql-flownet-audit-app-id",
    "ksql-flownet-request-app-id",
    "ksql-flownet-log-app-id",
    "ksql-flownet-audit-app-detection",
    "ksql-flownet-audit-app-preview",
    "ksql-flownet-request-app-detection",
    "ksql-flownet-request-app-preview",
    "ksql-flownet-log-app-detection",
    "ksql-flownet-log-app-preview",
    "ksql-flownet-config-error",
    "ksql-flownet-deploy-on-save",
    "ksql-flownet-config-cancel",
    "保存時に運用環境へ反映(アプリ更新)",
    "入力欄が空の場合は、下記の関連レコード一覧から自動検出したアプリを使用",
  ]) {
    assert.ok(html.includes(required), `config.htmlに${required}が必要`);
  }
  assert.equal(
    html.match(/class="ksql-flownet-config-section"/gu)?.length,
    3,
    "3つのアプリ項目を個別のセクションカードにする",
  );
  assert.ok(
    html.indexOf('id="ksql-flownet-config-cancel"') <
      html.indexOf('class="ksql-flownet-config-save"'),
    "フッターはキャンセル、保存の順にする",
  );
  assert.ok(
    html.indexOf('class="ksql-flownet-config-deploy"') <
      html.indexOf('class="ksql-flownet-config-actions"'),
    "運用環境への反映帯をフッター直前に置く",
  );
});

test("config.cssはrequest dialogと同じロゴ・ヘッダー・カード・フッター意匠を持つ", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(
    new globalThis.URL("../../plugin/css/config.css", import.meta.url),
    "utf8",
  );
  for (const required of [
    "--ksql-flownet-logo:",
    ".ksql-flownet-config-header",
    ".ksql-flownet-config-info",
    ".ksql-flownet-config-section",
    ".ksql-flownet-config-deploy",
    ".ksql-flownet-config-actions",
    ".ksql-flownet-config-callout-progress",
    ".ksql-flownet-config-callout-success",
    ".ksql-flownet-config-callout-error",
  ]) {
    assert.ok(css.includes(required), `config.cssに${required}が必要`);
  }
});

test("deployOnSaveはOFF時だけfalse文字列を保存し、ON時はキーを省略する", () => {
  const appIds = {
    auditAppId: "41",
    requestAppId: "51",
    logAppId: "61",
  };
  assert.deepEqual(buildPluginConfig(appIds, true), appIds);
  assert.deepEqual(buildPluginConfig(appIds, false), {
    ...appIds,
    deployOnSave: "false",
  });
});

function deployTestApi(statuses, options = {}) {
  const calls = [];
  const api = async (url, method, body) => {
    calls.push({ url, method, body });
    if (method === "POST") return {};
    return { apps: [{ status: statuses.shift() ?? "PROCESSING" }] };
  };
  api.url = (path, guestSpace) => {
    assert.equal(path, "/k/v1/preview/app/deploy.json");
    assert.equal(guestSpace, true);
    return path;
  };
  return {
    calls,
    kintoneApi: {
      app: { getId: () => 101 },
      plugin: {
        app: {
          getConfig: () => ({}),
          setConfig: (config, callback) => {
            calls.push({ setConfig: config });
            if (options.callSetConfigCallback !== false) callback();
          },
        },
      },
      api,
    },
  };
}

const savedConfig = {
  auditAppId: "41",
  requestAppId: "51",
  logAppId: "61",
};

test("setConfig完了後にdeploy POSTし、1秒間隔でSUCCESSまでポーリングする", async () => {
  const { calls, kintoneApi } = deployTestApi(["PROCESSING", "SUCCESS"]);
  const waits = [];
  const outcome = await saveConfigAndDeploy(kintoneApi, savedConfig, {
    deploy: true,
    appId: 101,
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(outcome, {
    ok: true,
    message: "保存し、運用環境へ反映しました",
  });
  assert.deepEqual(waits, [1_000, 1_000]);
  assert.deepEqual(calls, [
    { setConfig: savedConfig },
    {
      url: "/k/v1/preview/app/deploy.json",
      method: "POST",
      body: { apps: [{ app: 101 }] },
    },
    {
      url: "/k/v1/preview/app/deploy.json",
      method: "GET",
      body: { apps: [101] },
    },
    {
      url: "/k/v1/preview/app/deploy.json",
      method: "GET",
      body: { apps: [101] },
    },
  ]);
  assert.ok(
    calls
      .filter((call) => "url" in call)
      .every(
        ({ url, method }) =>
          url === "/k/v1/preview/app/deploy.json" &&
          (method === "GET" || method === "POST"),
      ),
    "設定保存で追加するGET/POSTはdeploy endpointだけ",
  );
});

test("deployポーリングがFAILなら赤表示用の手動更新案内を返す", async () => {
  const { kintoneApi } = deployTestApi(["FAIL"]);
  const outcome = await saveConfigAndDeploy(kintoneApi, savedConfig, {
    deploy: true,
    appId: 101,
    wait: async () => {},
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /FAIL/u);
  assert.match(outcome.message, /手動でアプリ更新/u);
});

test("deployポーリングは30秒相当でタイムアウトし、手動更新を案内する", async () => {
  const { calls, kintoneApi } = deployTestApi([]);
  const waits = [];
  const outcome = await saveConfigAndDeploy(kintoneApi, savedConfig, {
    deploy: true,
    appId: 101,
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /タイムアウト/u);
  assert.match(outcome.message, /手動でアプリ更新/u);
  assert.equal(waits.length, 30);
  assert.ok(waits.every((milliseconds) => milliseconds === 1_000));
  assert.equal(calls.filter((call) => call.method === "GET").length, 30);
});

test("deploy OFFならsetConfigだけを行い、deploy endpointを呼ばない", async () => {
  const { calls, kintoneApi } = deployTestApi([]);
  const outcome = await saveConfigAndDeploy(kintoneApi, savedConfig, {
    deploy: false,
    appId: 101,
  });
  assert.deepEqual(outcome, {
    ok: true,
    message: "保存しました。アプリ更新で反映されます",
  });
  assert.deepEqual(calls, [{ setConfig: savedConfig }]);
});

test("setConfigのコールバックが4秒内に来なければ保存失敗として留まる", async () => {
  const { calls, kintoneApi } = deployTestApi([], {
    callSetConfigCallback: false,
  });
  const outcome = await saveConfigAndDeploy(kintoneApi, savedConfig, {
    deploy: true,
    appId: 101,
    setConfigTimeoutMs: 1,
    wait: async () => {},
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /保存完了を確認できません/u);
  assert.deepEqual(calls, [{ setConfig: savedConfig }]);
});

test("bootstrapはdocument構築中ならDOMContentLoadedまで設置を遅延する(2026-09-01実機回帰)", async () => {
  const { bootstrapConfigPage } = await import("../../dist/plugin/config.js");
  const listeners = [];
  let queried = 0;
  const pageDocument = {
    readyState: "loading",
    addEventListener: (name, handler, options) => {
      listeners.push({ name, handler, options });
    },
    querySelector: () => {
      queried += 1;
      return null;
    },
  };
  const kintoneApi = {
    $PLUGIN_ID: "p",
    plugin: { app: { getConfig: () => ({}), setConfig: () => {} } },
  };
  bootstrapConfigPage(kintoneApi, pageDocument);
  assert.equal(queried, 0, "loading中はDOMへ触らない");
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].name, "DOMContentLoaded");
  assert.deepEqual(listeners[0].options, { once: true });
  // DOM構築後に発火 → 要素不足なら明示エラー(設置自体は試行される)
  assert.throws(() => listeners[0].handler(), /要素が不足/u);
  assert.ok(queried > 0, "DOMContentLoaded後に設置を試行する");
});
