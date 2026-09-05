import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { buildCreateRequestBody } from "../../dist/plugin/request-client.js";
import { parseRequestRecord } from "../../dist/requests/request-model.js";

const templatePath = resolve(
  "templates/console/create-flownet-request-app.console.js",
);

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
  // 実機同様に /k/v1/...json 形式だけを受け付ける(2026-09-01実機不具合の回帰固定:
  // kintone.api.url へ生パス "/apps" を渡すと同名確認の最初の呼出しで失敗する)
  kintone.api.url = (endpoint, detectGuestSpace) => {
    assert.equal(detectGuestSpace, true, "kintone.api.urlは第2引数trueで呼ぶ");
    assert.match(
      endpoint,
      /^\/k\/v1\/[a-z/]+\.json$/u,
      `kintone.api.urlへは/k/v1プレフィックスと.json付きで渡す: ${endpoint}`,
    );
    return endpoint.replace(/^\/k\/v1/u, "").replace(/\.json$/u, "");
  };
  await vm.runInNewContext(script, {
    confirm: () => false,
    console: { log() {}, warn() {}, error() {}, table() {} },
    kintone,
    location: { hash: "#/space/123" },
  });
  return calls;
}

test("操作要求テンプレートは仕様§3の全13フィールドと型・必須を生成する", async () => {
  const calls = await evaluateTemplate();
  const properties = calls.find(
    ({ url, method }) =>
      url === "/preview/app/form/fields" && method === "POST",
  ).body.properties;
  assert.deepEqual(Object.keys(properties), [
    "request_type",
    "run_id",
    "network_id",
    "business_key",
    "scheduled_for",
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
  assert.equal(properties.network_id.type, "SINGLE_LINE_TEXT");
  assert.equal(properties.business_key.type, "SINGLE_LINE_TEXT");
  assert.equal(properties.scheduled_for.type, "DATETIME");
  assert.equal(properties.reason.type, "MULTI_LINE_TEXT");
  assert.equal(properties.claimed_at.type, "DATETIME");
  assert.equal(properties.run_id.required, false);
  assert.equal(properties.scheduled_for.required, false);
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
    "START",
  ]);
  assert.deepEqual(Object.keys(properties.request_state.options), [
    "REQUESTED",
    "ACCEPTED",
    "DONE",
    "REJECTED",
  ]);
  assert.equal(properties.request_state.defaultValue, "REQUESTED");
});

test("STARTの3欄をlayoutと処理待ち・拒否一覧へ追加する", async () => {
  const calls = await evaluateTemplate();
  const layout = calls.find(
    ({ url, method }) => url === "/preview/app/form/layout" && method === "PUT",
  ).body.layout;
  const layoutCodes = layout.flatMap(({ fields }) =>
    fields.map(({ code }) => code).filter(Boolean),
  );
  for (const code of ["network_id", "business_key", "scheduled_for"]) {
    assert.equal(
      layoutCodes.filter((value) => value === code).length,
      1,
      `${code}はlayoutへ1回だけ配置する`,
    );
  }

  const views = calls.find(({ url }) => url === "/preview/app/views").body
    .views;
  for (const view of Object.values(views)) {
    for (const code of ["network_id", "business_key", "scheduled_for"]) {
      assert.ok(view.fields.includes(code), `${view.name}へ${code}を表示する`);
    }
  }
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
  // 各viewはキーと同値のnameが必須(GAIA_VI03 — 2026-09-01実機の回帰固定)
  for (const [key, view] of Object.entries(views)) {
    assert.equal(view.name, key, `view nameはキーと同値必須: ${key}`);
  }
  // 一覧sortは$id・複数キー不可(2026-09-01実機で一覧設定PUTが失敗した回帰固定)
  for (const view of Object.values(views)) {
    assert.match(
      view.sort,
      /^[^,$]+ (asc|desc)$/u,
      `一覧sortは単一キーかつ$id以外: ${view.sort}`,
    );
  }
  assert.equal(views["01_未処理要求"].sort, "作成日時 asc");
  assert.equal(views["02_拒否された要求"].sort, "作成日時 desc");
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

test("plugin POST body plus template/system defaults passes parseRequestRecord", () => {
  for (const requestType of ["RERUN", "STOP", "RELEASE"]) {
    const body = buildCreateRequestBody(999, {
      requestType,
      runId: "run_contract",
      reason: "operator reason",
      ...(requestType === "RERUN" ? { rerunFromNode: "node_2" } : {}),
    });
    const record = {
      ...body.record,
      $id: { value: "1" },
      $revision: { value: "1" },
      作成者: { value: { code: "operator@example.test" } },
      作成日時: { value: "2026-09-01T01:00:00Z" },
      rerun_from_node: body.record.rerun_from_node ?? { value: "" },
      request_state: { value: "REQUESTED" },
      claimed_at: { value: "" },
      claimed_host: { value: "" },
      claim_heartbeat_at: { value: "" },
      result_code: { value: "" },
      result_message: { value: "" },
    };
    assert.equal(parseRequestRecord(record).requestType, requestType);
  }
  assert.throws(
    () =>
      buildCreateRequestBody(999, {
        requestType: "RELEASE",
        runId: "run_contract",
        reason: "operator reason",
        rerunFromNode: "node_2",
      }),
    /only allowed for RERUN/u,
  );
});
