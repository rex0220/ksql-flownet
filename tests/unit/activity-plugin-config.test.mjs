import assert from "node:assert/strict";
import test from "node:test";

import {
  installConfigPage,
  validateAuditAppId,
} from "../../dist/plugin/config.js";

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

test("config page rejects invalid saves and preserves the valid decimal string", () => {
  const listeners = new Map();
  const input = { value: "" };
  const error = { textContent: "" };
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
    ["#ksql-flownet-config-form", form],
    ["#ksql-flownet-config-error", error],
    ["#ksql-flownet-config-cancel", cancel],
  ]);
  const saved = [];
  const originalHistory = globalThis.history;
  globalThis.history = { back: () => {} };
  try {
    installConfigPage(
      {
        $PLUGIN_ID: "plugin-id",
        plugin: {
          app: {
            getConfig: () => ({ auditAppId: "41" }),
            setConfig: (config, callback) => {
              saved.push(config);
              callback();
            },
          },
        },
      },
      "plugin-id",
      { querySelector: (selector) => elements.get(selector) ?? null },
    );
    assert.equal(input.value, "41");
    input.value = " 42 ";
    listeners.get("form:submit")({ preventDefault: () => {} });
    assert.equal(saved.length, 0);
    assert.match(error.textContent, /正の10進整数/u);
    input.value = "42";
    listeners.get("form:submit")({ preventDefault: () => {} });
    assert.deepEqual(saved, [{ auditAppId: "42" }]);
  } finally {
    globalThis.history = originalHistory;
  }
});

test("config.htmlはフラグメントのみ(html/head/body/doctype禁止 — kintone埋め込み実機回帰)", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(
    new URL("../../plugin/config.html", import.meta.url),
    "utf8",
  );
  for (const forbidden of ["<!doctype", "<html", "<head", "<body"]) {
    assert.ok(
      !html.toLowerCase().includes(forbidden),
      `config.htmlに${forbidden}を含めない(kintoneが中身を埋め込むため)`,
    );
  }
  for (const required of [
    "ksql-flownet-config-form",
    "ksql-flownet-audit-app-id",
    "ksql-flownet-config-error",
    "ksql-flownet-config-cancel",
  ]) {
    assert.ok(html.includes(required), `config.htmlに${required}が必要`);
  }
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
