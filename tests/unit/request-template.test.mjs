import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const templatePath = resolve("templates/create-flownet-request-app.console.js");

async function evaluateTemplate({ existing = [] } = {}) {
  const calls = [];
  const script = readFileSync(templatePath, "utf8");
  const kintone = {
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url === "/apps") return { apps: existing };
      if (url === "/space") return { defaultThread: "10" };
      if (url === "/preview/app" && method === "POST") return { app: "999" };
      if (url === "/preview/app/form/fields") return { revision: "2" };
      if (url === "/preview/app/form/layout" && method === "GET") {
        return {
          layout: [
            {
              type: "ROW",
              fields: [{ type: "RECORD_NUMBER", code: "レコード番号" }],
            },
          ],
        };
      }
      if (url === "/preview/app/form/layout") return { revision: "3" };
      if (url === "/preview/app/views") return { revision: "4" };
      throw new Error(`unexpected API call: ${method} ${url}`);
    },
  };
  kintone.api.url = (endpoint) => endpoint;
  await vm.runInNewContext(script, {
    confirm: () => false,
    console: { log() {}, warn() {}, error() {}, table() {} },
    kintone,
    location: { hash: "#/space/123" },
  });
  return calls;
}

test("操作要求テンプレートは仕様§3の全10フィールドと型・必須を生成する", async () => {
  const calls = await evaluateTemplate();
  const properties = calls.find(
    ({ url, method }) =>
      url === "/preview/app/form/fields" && method === "POST",
  ).body.properties;
  assert.deepEqual(Object.keys(properties), [
    "request_type",
    "run_id",
    "rerun_from_node",
    "reason",
    "request_state",
    "claimed_at",
    "claimed_host",
    "claim_heartbeat_at",
    "result_code",
    "result_message",
  ]);
  assert.equal(properties.request_type.type, "DROP_DOWN");
  assert.equal(properties.run_id.type, "SINGLE_LINE_TEXT");
  assert.equal(properties.reason.type, "MULTI_LINE_TEXT");
  assert.equal(properties.claimed_at.type, "DATETIME");
  assert.equal(properties.run_id.required, true);
  assert.equal(properties.reason.required, true);
});

test("dropdown値を固定しrequest_state初期値をREQUESTEDにする", async () => {
  const calls = await evaluateTemplate();
  const properties = calls.find(({ url }) => url === "/preview/app/form/fields")
    .body.properties;
  assert.deepEqual(Object.keys(properties.request_type.options), [
    "RERUN",
    "STOP",
    "RELEASE",
  ]);
  assert.deepEqual(Object.keys(properties.request_state.options), [
    "REQUESTED",
    "ACCEPTED",
    "DONE",
    "REJECTED",
  ]);
  assert.equal(properties.request_state.defaultValue, "REQUESTED");
});

test("一覧2件は重複しないindexと正しいfilter・安定sortを持つ", async () => {
  const calls = await evaluateTemplate();
  const views = calls.find(({ url }) => url === "/preview/app/views").body
    .views;
  assert.deepEqual(Object.keys(views), ["01_未処理要求", "02_拒否された要求"]);
  assert.deepEqual(
    Object.values(views).map(({ index }) => index),
    ["0", "1"],
  );
  assert.equal(
    views["01_未処理要求"].filterCond,
    'request_state in ("REQUESTED", "ACCEPTED")',
  );
  assert.equal(views["01_未処理要求"].sort, "作成日時 asc, $id asc");
  assert.equal(
    views["02_拒否された要求"].filterCond,
    'request_state in ("REJECTED")',
  );
});

test("同名アプリがあればpreview作成前に中止する", async () => {
  const calls = await evaluateTemplate({
    existing: [{ appId: "777", name: "kSQL-FlowNet 操作要求" }],
  });
  assert.deepEqual(
    calls.map(({ url }) => url),
    ["/apps"],
  );
});
