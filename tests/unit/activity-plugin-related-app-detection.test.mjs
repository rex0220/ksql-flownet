import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeDependencies } from "../../dist/plugin/desktop.js";
import {
  detectRelatedAppIds,
  resolveRelatedAppIds,
} from "../../dist/plugin/related-app-detection.js";

const reference = (app) => ({
  type: "REFERENCE_TABLE",
  referenceTable: { relatedApp: { app } },
});

test("3種のREFERENCE_TABLEから監査・要求・ログのアプリIDを検出する", () => {
  assert.deepEqual(
    detectRelatedAppIds({
      properties: {
        related_audit_events: reference("201"),
        related_requests: reference(301),
        related_job_logs: reference("401"),
      },
    }),
    { auditAppId: "201", requestAppId: "301", logAppId: "401" },
  );
});

test("関連フィールドの一部欠落はその項目だけ未検出にする", () => {
  assert.deepEqual(
    detectRelatedAppIds({
      properties: {
        related_audit_events: reference("201"),
        related_requests: { type: "SINGLE_LINE_TEXT" },
      },
    }),
    { auditAppId: "201", requestAppId: "", logAppId: "" },
  );
});

test("保存済み設定は項目単位で自動検出より優先する", () => {
  assert.deepEqual(
    resolveRelatedAppIds(
      { auditAppId: "211", requestAppId: "", logAppId: "411" },
      { auditAppId: "201", requestAppId: "301", logAppId: "401" },
    ),
    { auditAppId: "211", requestAppId: "301", logAppId: "411" },
  );
});

test("form fields GETが403でもfail-openで保存済み設定だけを使う", async () => {
  const calls = [];
  const apiFunction = async (url, method, body) => {
    calls.push({ url, method, body });
    const error = new Error("Forbidden");
    error.code = "CB_NO02";
    throw error;
  };
  apiFunction.url = (path, guestSpace) => {
    assert.equal(guestSpace, true);
    return path;
  };
  const dependencies = await loadRuntimeDependencies(
    {
      $PLUGIN_ID: "plugin-id",
      app: {
        getId: () => 101,
        record: { getHeaderMenuSpaceElement: () => null },
      },
      plugin: {
        app: {
          getConfig: () => ({
            auditAppId: "211",
            requestAppId: "311",
            logAppId: "411",
          }),
        },
      },
      api: apiFunction,
    },
    "plugin-id",
  );
  assert.deepEqual(calls, [
    {
      url: "/k/v1/app/form/fields.json",
      method: "GET",
      body: { app: 101 },
    },
  ]);
  assert.equal(dependencies.load.auditAppId, "211");
  assert.equal(dependencies.load.requestAppId, "311");
  assert.equal(dependencies.load.logAppId, "411");
});

test("設定も検出も無い項目は空欄のまま従来のfail-closedへ渡す", () => {
  assert.deepEqual(
    resolveRelatedAppIds(
      {},
      { auditAppId: "", requestAppId: "", logAppId: "" },
    ),
    { auditAppId: "", requestAppId: "", logAppId: "" },
  );
});
