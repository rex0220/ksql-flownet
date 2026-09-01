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
