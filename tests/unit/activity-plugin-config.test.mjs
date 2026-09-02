import assert from "node:assert/strict";
import test from "node:test";

import {
  applyImported,
  buildConfigBackup,
  buildPluginConfig,
  installConfigPage,
  parseStartAllowedNetworks,
  saveConfigAndDeploy,
  validateAuditAppId,
  validateAuditAppIdOverride,
  validateLogAppId,
  validateRequestAppId,
  validateStartAllowedNetworks,
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

test("START許可ネットワーク一覧はCSV4列までと旧1列を正規化しnetwork_idの先勝ちで重複除去する", () => {
  assert.deepEqual(
    validateStartAllowedNetworks(
      " 月次案件集計 , monthly , 定期 \r\n\nadhoc\r別名, monthly, 補正, ignored\n 随時 , adhoc, 任意キー, adhoc-fixed ",
    ),
    {
      valid: true,
      value: "月次案件集計, monthly, 定期\nadhoc",
      message: null,
    },
  );
  assert.deepEqual(
    parseStartAllowedNetworks(
      "月次案件集計, monthly, 定期\n月次案件集計(補正), correction, 補正, {ネットワークID}@{年}-{月}-correction-1\n随時, adhoc_explicit, 任意キー, adhoc-fixed\nadhoc",
    ),
    [
      {
        label: "月次案件集計",
        networkId: "monthly",
        mode: "scheduled",
      },
      {
        label: "月次案件集計(補正)",
        networkId: "correction",
        mode: "correction",
        businessKeyTemplate: "{ネットワークID}@{年}-{月}-correction-1",
      },
      {
        label: "随時",
        networkId: "adhoc_explicit",
        mode: "explicit",
        businessKeyTemplate: "adhoc-fixed",
      },
      { label: "adhoc", networkId: "adhoc" },
    ],
  );
  assert.deepEqual(parseStartAllowedNetworks("表示名, legacy_network"), [
    { label: "表示名", networkId: "legacy_network" },
  ]);
  assert.deepEqual(validateStartAllowedNetworks(""), {
    valid: true,
    value: "",
    message: null,
  });
  assert.match(
    validateStartAllowedNetworks("x".repeat(129)).message,
    /1行128文字以内/u,
  );
  assert.match(
    validateStartAllowedNetworks("x".repeat(4_001)).message,
    /全体で4000文字以内/u,
  );
  assert.equal(
    validateStartAllowedNetworks("表示名, network_id, 補正, key, extra")
      .message,
    "各行は「ネットワーク名, network_id, 入力モード, business_keyテンプレート」の4列以内で入力してください。",
  );
  assert.equal(
    validateStartAllowedNetworks("表示名, network_id, invalid").message,
    "入力モードは 定期/補正/任意キー のいずれかで指定してください",
  );
  assert.equal(
    validateStartAllowedNetworks("表示名, network_id, explicit").message,
    "入力モードは 定期/補正/任意キー のいずれかで指定してください",
  );
  assert.equal(
    validateStartAllowedNetworks("表示名, network_id, 定期, key").message,
    "定期モードにbusiness_keyテンプレートは指定できません",
  );
  assert.match(
    validateStartAllowedNetworks(
      "表示名, network_id, 補正, {ネットワークID}@{month}",
    ).message,
    /プレースホルダ/u,
  );
  for (const oldPlaceholder of [
    "{network_id}",
    "{yyyy}",
    "{MM}",
    "{dd}",
  ]) {
    assert.equal(
      validateStartAllowedNetworks(
        `表示名, network_id, 補正, ${oldPlaceholder}`,
      ).message,
      "business_keyテンプレートのプレースホルダは {ネットワークID}/{年}/{月}/{日} のみ使用できます。",
    );
  }
  assert.match(
    validateStartAllowedNetworks("表示名, network_id, , fixed").message,
    /入力モード/u,
  );
  for (const value of [", monthly", "月次案件集計,", ","]) {
    assert.match(
      validateStartAllowedNetworks(value).message,
      /ネットワーク名とnetwork_idは空にせず/u,
    );
  }
});

test("ダウンロードpayloadはメタ情報と検証・正規化済みのconfig全欄を持つ", () => {
  const config = applyImported({
    auditAppId: "41",
    requestAppId: "51",
    logAppId: "61",
    startAllowedNetworks:
      " 月次案件集計(補正) , monthly, 補正, {ネットワークID}@{年}-{月}-correction-1 \r\n月次案件集計(重複), monthly\n adhoc ",
    deployOnSave: false,
  });
  const backup = buildConfigBackup(
    config,
    {
      pluginId: "plugin-id",
      appId: 101,
      appName: "Run 状況 <script>",
    },
    new Date(2026, 8, 2, 14, 5, 6),
  );

  assert.deepEqual(backup, {
    filename: "flownet-activity-app101-20260902-140506.json",
    payload: {
      date: "2026-09-02 14:05:06",
      pluginName: "kSQL-FlowNet Run Activity",
      pluginId: "plugin-id",
      appId: 101,
      appName: "Run 状況 <script>",
      config: {
        auditAppId: "41",
        requestAppId: "51",
        logAppId: "61",
        startAllowedNetworks:
          "月次案件集計(補正), monthly, 補正, {ネットワークID}@{年}-{月}-correction-1\nadhoc",
        deployOnSave: false,
      },
    },
  });
  assert.deepEqual(applyImported(backup.payload), config);
});

test("インポートはメタ付き・素の設定を検証し、未知キーを無視する", () => {
  const expected = {
    auditAppId: "41",
    requestAppId: "51",
    logAppId: "61",
    startAllowedNetworks:
      "月次案件集計(補正), monthly, 補正, {ネットワークID}@{年}-{月}-correction-1\nadhoc",
    deployOnSave: false,
  };
  assert.deepEqual(
    applyImported({
      date: "2026-09-02 14:05:06",
      config: {
        ...expected,
        startAllowedNetworks:
          " 月次案件集計(補正) , monthly, 補正, {ネットワークID}@{年}-{月}-correction-1 \n別名, monthly\nadhoc ",
        futureSetting: "ignored",
      },
    }),
    expected,
  );
  assert.deepEqual(applyImported({ ...expected, unknown: true }), expected);
  assert.throws(
    () => applyImported({ ...expected, requestAppId: " 51 " }),
    /操作要求アプリID/u,
  );
  assert.throws(
    () => applyImported({ ...expected, deployOnSave: "yes" }),
    /アプリ更新設定/u,
  );
});

test("不正JSON・検証エラーのインポートはフォーム状態を変えずinputをリセットする", async () => {
  const auditInput = inputElement("11");
  const requestInput = inputElement("12");
  const logInput = inputElement("13");
  const startAllowedNetworks = inputElement("before");
  const deployOnSave = inputElement();
  deployOnSave.checked = true;
  const error = statusElement();
  const importFile = inputElement();
  const elements = new Map([
    ["#ksql-flownet-audit-app-id", auditInput],
    ["#ksql-flownet-request-app-id", requestInput],
    ["#ksql-flownet-log-app-id", logInput],
    ["#ksql-flownet-start-allowed-networks", startAllowedNetworks],
    ["#ksql-flownet-audit-app-detection", statusElement()],
    ["#ksql-flownet-audit-app-preview", statusElement()],
    ["#ksql-flownet-request-app-detection", statusElement()],
    ["#ksql-flownet-request-app-preview", statusElement()],
    ["#ksql-flownet-log-app-detection", statusElement()],
    ["#ksql-flownet-log-app-preview", statusElement()],
    ["#ksql-flownet-config-form", { addEventListener: () => {} }],
    ["#ksql-flownet-config-error", error],
    ["#ksql-flownet-deploy-on-save", deployOnSave],
    ["#ksql-flownet-config-cancel", inputElement()],
    ["#ksql-flownet-config-download", inputElement()],
    ["#ksql-flownet-config-upload", inputElement()],
    ["#ksql-flownet-config-import-file", importFile],
  ]);
  const originalFileReader = globalThis.FileReader;
  globalThis.FileReader = class {
    listeners = new Map();
    result = null;
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
    readAsText(file) {
      this.result = file.contents;
      this.listeners.get("load")();
    }
  };
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
              auditAppId: "11",
              requestAppId: "12",
              logAppId: "13",
              startAllowedNetworks: "before",
            }),
            setConfig: () => {},
          },
        },
        api,
      },
      "plugin-id",
      { querySelector: (selector) => elements.get(selector) ?? null },
    );

    const before = () => [
      auditInput.value,
      requestInput.value,
      logInput.value,
      startAllowedNetworks.value,
      deployOnSave.checked,
    ];
    const initial = before();
    for (const contents of [
      "{invalid",
      JSON.stringify({
        auditAppId: "21",
        requestAppId: " 22 ",
        logAppId: "23",
        startAllowedNetworks: "after",
        deployOnSave: false,
      }),
    ]) {
      importFile.files = [{ contents }];
      importFile.value = "selected.json";
      importFile.dispatch("change");
      assert.equal(importFile.value, "", "同じファイルを再選択できる");
      assert.deepEqual(before(), initial, "失敗時はフォーム状態を維持する");
      assert.match(error.textContent, /読み込みに失敗/u);
    }

    importFile.files = [
      {
        contents: JSON.stringify({
          config: {
            auditAppId: "21",
            requestAppId: "22",
            logAppId: "23",
            startAllowedNetworks:
              " 月次案件集計 , monthly \n重複名, monthly\n 随時実行, adhoc ",
            deployOnSave: false,
            futureSetting: "ignored",
          },
        }),
      },
    ];
    importFile.value = "selected.json";
    importFile.dispatch("change");
    assert.deepEqual(before(), [
      "21",
      "22",
      "23",
      "月次案件集計, monthly\n随時実行, adhoc",
      false,
    ]);
    assert.equal(importFile.value, "");
    assert.equal(
      error.textContent,
      "設定を読み込みました。内容を確認して保存してください。",
    );
  } finally {
    globalThis.FileReader = originalFileReader;
  }
  await flushAsync();
});

test("config page rejects invalid saves and preserves the valid decimal string", async () => {
  const listeners = new Map();
  const input = inputElement();
  const requestInput = inputElement();
  const logInput = inputElement();
  const startAllowedNetworks = inputElement();
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
    ["#ksql-flownet-start-allowed-networks", startAllowedNetworks],
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
    ["#ksql-flownet-config-download", inputElement()],
    ["#ksql-flownet-config-upload", inputElement()],
    ["#ksql-flownet-config-import-file", inputElement()],
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
              startAllowedNetworks: "monthly\nadhoc",
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
    assert.equal(startAllowedNetworks.value, "monthly\nadhoc");
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
    startAllowedNetworks.value = "x".repeat(129);
    listeners.get("form:submit")({ preventDefault: () => {} });
    assert.equal(saved.length, 0);
    assert.match(error.textContent, /1行128文字以内/u);
    startAllowedNetworks.value = " monthly \nmonthly\n adhoc ";
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
        startAllowedNetworks: "monthly\nadhoc",
        deployOnSave: "false",
      },
      {
        auditAppId: "",
        requestAppId: "",
        logAppId: "",
        startAllowedNetworks: "monthly\nadhoc",
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
  const startAllowedNetworks = inputElement();
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
    ["#ksql-flownet-start-allowed-networks", startAllowedNetworks],
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
    ["#ksql-flownet-config-download", inputElement()],
    ["#ksql-flownet-config-upload", inputElement()],
    ["#ksql-flownet-config-import-file", inputElement()],
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
    "ksql-flownet-start-allowed-networks",
    "ksql-flownet-audit-app-detection",
    "ksql-flownet-audit-app-preview",
    "ksql-flownet-request-app-detection",
    "ksql-flownet-request-app-preview",
    "ksql-flownet-log-app-detection",
    "ksql-flownet-log-app-preview",
    "ksql-flownet-config-error",
    "ksql-flownet-deploy-on-save",
    "ksql-flownet-config-backup",
    "ksql-flownet-config-download",
    "ksql-flownet-config-upload",
    "ksql-flownet-config-import-file",
    "ksql-flownet-config-cancel",
    "保存時に運用環境へ反映(アプリ更新)",
    "入力欄が空の場合は、下記の関連レコード一覧から自動検出したアプリを使用",
    "STARTを許可するネットワーク(CSV・任意)",
    "月次案件集計(当月分の起動), monthly_deal_summary, 定期",
    "月次案件集計(補正), monthly_deal_summary, 補正, {ネットワークID}@{年}-{月}-correction-1",
    "ネットワーク名,",
    "設定のバックアップ:",
    'title="設定をJSONでダウンロード"',
    'aria-label="設定をJSONでダウンロード"',
    'title="JSONを読み込み(反映するには保存)"',
    'aria-label="JSONを読み込み(反映するには保存)"',
  ]) {
    assert.ok(html.includes(required), `config.htmlに${required}が必要`);
  }
  assert.match(
    html,
    /<textarea[^>]*id="ksql-flownet-start-allowed-networks"[^>]*wrap="off"[^>]*>/su,
    "START許可ネットワークCSV欄は折り返さない",
  );
  assert.equal(
    html.match(/class="ksql-flownet-config-section"/gu)?.length,
    4,
    "3つのアプリ項目とSTART許可ネットワーク一覧を個別のセクションカードにする",
  );
  assert.ok(
    html.indexOf('id="ksql-flownet-config-cancel"') <
      html.indexOf('class="ksql-flownet-config-save"'),
    "フッターはキャンセル、保存の順にする",
  );
  const footer = html.match(
    /<footer class="ksql-flownet-config-actions">([\s\S]*?)<\/footer>/u,
  )?.[1];
  assert.ok(footer, "設定操作フッターが必要");
  for (const required of [
    'class="ksql-flownet-config-deploy"',
    'id="ksql-flownet-config-cancel"',
    'class="ksql-flownet-config-save"',
  ]) {
    assert.ok(footer.includes(required), `フッター内に${required}が必要`);
  }
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
    startAllowedNetworks: "monthly\nadhoc",
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

test("保存時反映ONは保存成功後に画面遷移せず、OFFは設定一覧へ戻る(2026-09-02実機フィードバック)", async () => {
  for (const [deployChecked, expectBack] of [
    [true, false],
    [false, true],
  ]) {
    const listeners = new Map();
    const input = inputElement("41");
    const requestInput = inputElement("51");
    const logInput = inputElement("61");
    const startAllowedNetworks = inputElement("");
    const error = { textContent: "" };
    const deployOnSave = inputElement();
    deployOnSave.checked = deployChecked;
    const form = {
      addEventListener: (name, listener) =>
        listeners.set(`form:${name}`, listener),
    };
    const cancel = { addEventListener: () => {} };
    const elements = new Map([
      ["#ksql-flownet-audit-app-id", input],
      ["#ksql-flownet-request-app-id", requestInput],
      ["#ksql-flownet-log-app-id", logInput],
      ["#ksql-flownet-start-allowed-networks", startAllowedNetworks],
      ["#ksql-flownet-audit-app-detection", statusElement()],
      ["#ksql-flownet-audit-app-preview", statusElement()],
      ["#ksql-flownet-request-app-detection", statusElement()],
      ["#ksql-flownet-request-app-preview", statusElement()],
      ["#ksql-flownet-log-app-detection", statusElement()],
      ["#ksql-flownet-log-app-preview", statusElement()],
      ["#ksql-flownet-config-form", form],
      ["#ksql-flownet-config-error", error],
      ["#ksql-flownet-deploy-on-save", deployOnSave],
      ["#ksql-flownet-config-cancel", cancel],
      ["#ksql-flownet-config-download", inputElement()],
      ["#ksql-flownet-config-upload", inputElement()],
      ["#ksql-flownet-config-import-file", inputElement()],
    ]);
    let backCalls = 0;
    const originalHistory = globalThis.history;
    globalThis.history = {
      back: () => {
        backCalls += 1;
      },
    };
    const api = async (url, method) => {
      if (url === "/k/v1/preview/app/deploy.json") {
        return method === "POST" ? {} : { apps: [{ status: "SUCCESS" }] };
      }
      return { properties: {} };
    };
    api.url = (path) => path;
    try {
      installConfigPage(
        {
          $PLUGIN_ID: "plugin-id",
          app: { getId: () => 101 },
          plugin: {
            app: {
              getConfig: () => ({
                deployOnSave: deployChecked ? undefined : "false",
              }),
              setConfig: (config, callback) => callback(),
            },
          },
          api,
        },
        "plugin-id",
        { querySelector: (selector) => elements.get(selector) ?? null },
      );
      deployOnSave.checked = deployChecked;
      listeners.get("form:submit")({ preventDefault: () => {} });
      // deployポーリング(1秒間隔)と遷移予約のsetTimeoutを消化する
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1200));
      if (deployChecked) {
        assert.match(error.textContent, /保存し、運用環境へ反映しました/u);
      } else {
        assert.match(error.textContent, /保存しました/u);
      }
      assert.equal(
        backCalls,
        expectBack ? 1 : 0,
        `deployOnSave=${deployChecked}の遷移挙動`,
      );
    } finally {
      globalThis.history = originalHistory;
    }
  }
});
