import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const templatePath = resolve(
  "templates/console/migrations/add-request-lifecycle-v2.console.js",
);
const aclCodes = [
  "request_state",
  "claimed_at",
  "claimed_host",
  "claim_heartbeat_at",
  "result_code",
  "result_message",
  "cancel_requested",
];

function baseFields({ lifecycleV2 = false } = {}) {
  return {
    request_type: {
      type: "DROP_DOWN",
      code: "request_type",
      options: Object.fromEntries(
        [
          "RERUN",
          "STOP",
          "RELEASE",
          "START",
          ...(lifecycleV2 ? ["CLOSE"] : []),
        ].map((label, index) => [label, { label, index: String(index) }]),
      ),
    },
    request_state: {
      type: "DROP_DOWN",
      code: "request_state",
      defaultValue: "REQUESTED",
      options: Object.fromEntries(
        [
          "REQUESTED",
          "ACCEPTED",
          "DONE",
          "REJECTED",
          ...(lifecycleV2 ? ["CANCELLED"] : []),
        ].map((label, index) => [label, { label, index: String(index) }]),
      ),
    },
    reason: { type: "MULTI_LINE_TEXT", code: "reason" },
    ...(lifecycleV2
      ? {
          cancel_requested: {
            type: "CHECK_BOX",
            code: "cancel_requested",
            label: "取消",
            options: { 取消: { label: "取消", index: "0" } },
            required: false,
          },
        }
      : {}),
  };
}

function baseViews({ lifecycleV2 = false } = {}) {
  const pendingFields = [
    "レコード番号",
    "request_type",
    "reason",
    "request_state",
    ...(lifecycleV2 ? ["cancel_requested"] : []),
  ];
  return {
    "01_未処理要求": {
      id: "10",
      name: "01_未処理要求",
      type: "LIST",
      fields: pendingFields,
      filterCond: 'request_state in ("REQUESTED", "ACCEPTED")',
      sort: "作成日時 asc",
      index: "0",
    },
    "02_拒否された要求": {
      id: "11",
      name: "02_拒否された要求",
      type: "LIST",
      fields: ["レコード番号", "request_state", "result_code"],
      filterCond: 'request_state in ("REJECTED")',
      sort: "作成日時 desc",
      index: "7",
    },
    ...(lifecycleV2
      ? {
          "03_取消済み": {
            id: "12",
            name: "03_取消済み",
            type: "LIST",
            fields: [...pendingFields, "result_code"],
            filterCond: 'request_state in ("CANCELLED")',
            sort: "更新日時 desc",
            index: "8",
          },
        }
      : {}),
  };
}

async function evaluate({
  prompts = ["123"],
  confirms = [true, true],
  lifecycleV2 = false,
  rights = [],
} = {}) {
  const calls = [];
  const warnings = [];
  const promptValues = [...prompts];
  const confirmValues = [...confirms];
  const kintone = {
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url === "/k/v1/preview/app/form/fields.json" && method === "GET") {
        return { properties: baseFields({ lifecycleV2 }) };
      }
      if (url === "/k/v1/preview/app/form/layout.json" && method === "GET") {
        return {
          layout: [
            {
              type: "ROW",
              fields: [{ type: "MULTI_LINE_TEXT", code: "reason" }],
            },
            ...(lifecycleV2
              ? [
                  {
                    type: "ROW",
                    fields: [{ type: "CHECK_BOX", code: "cancel_requested" }],
                  },
                ]
              : []),
            { type: "ROW", fields: [{ type: "HR", elementId: "machine" }] },
          ],
        };
      }
      if (url === "/k/v1/preview/app/views.json" && method === "GET") {
        return { views: baseViews({ lifecycleV2 }), revision: "20" };
      }
      if (url === "/k/v1/preview/app/deploy.json" && method === "GET") {
        return { apps: [{ status: "SUCCESS" }] };
      }
      if (url === "/k/v1/preview/field/acl.json" && method === "GET") {
        return { rights, revision: "30" };
      }
      return { revision: "next" };
    },
  };
  kintone.api.url = (endpoint, detectGuestSpace) => {
    assert.equal(detectGuestSpace, true);
    return endpoint;
  };
  await vm.runInNewContext(readFileSync(templatePath, "utf8"), {
    confirm: () => confirmValues.shift() ?? false,
    console: {
      error() {},
      log() {},
      warn: (...values) => warnings.push(values.join(" ")),
    },
    kintone,
    prompt: () => promptValues.shift() ?? null,
    setTimeout: (callback) => callback(),
  });
  return { calls, warnings };
}

test("CLOSE/CANCELLED選択肢とcancel_requested定義・reason直後layoutを追加する", async () => {
  const { calls } = await evaluate();
  const fieldUpdate = calls.find(
    ({ url, method }) =>
      url.endsWith("/preview/app/form/fields.json") && method === "PUT",
  ).body.properties;
  assert.deepEqual(Object.keys(fieldUpdate.request_type.options), [
    "RERUN",
    "STOP",
    "RELEASE",
    "START",
    "CLOSE",
  ]);
  assert.deepEqual(Object.keys(fieldUpdate.request_state.options), [
    "REQUESTED",
    "ACCEPTED",
    "DONE",
    "REJECTED",
    "CANCELLED",
  ]);
  assert.equal(fieldUpdate.request_state.defaultValue, "REQUESTED");

  const added = calls.find(
    ({ url, method }) =>
      url.endsWith("/preview/app/form/fields.json") && method === "POST",
  ).body.properties.cancel_requested;
  assert.deepEqual(JSON.parse(JSON.stringify(added)), {
    type: "CHECK_BOX",
    code: "cancel_requested",
    label: "取消",
    options: { 取消: { label: "取消", index: "0" } },
    required: false,
  });
  assert.equal(Object.hasOwn(added, "defaultValue"), false);

  const layout = calls.find(
    ({ url, method }) =>
      url.endsWith("/preview/app/form/layout.json") && method === "PUT",
  ).body.layout;
  const reasonRow = layout.findIndex(({ fields }) =>
    fields?.some(({ code }) => code === "reason"),
  );
  assert.equal(layout[reasonRow + 1].fields[0].code, "cancel_requested");
});

test("未処理一覧のstate隣へ取消列、最大index+1の取消済み一覧を追加する", async () => {
  const { calls } = await evaluate();
  const views = calls.find(
    ({ url, method }) =>
      url.endsWith("/preview/app/views.json") && method === "PUT",
  ).body.views;
  const pending = views["01_未処理要求"];
  const stateIndex = pending.fields.indexOf("request_state");
  assert.equal(pending.fields[stateIndex + 1], "cancel_requested");
  assert.deepEqual(JSON.parse(JSON.stringify(views["03_取消済み"])), {
    name: "03_取消済み",
    type: "LIST",
    fields: [...pending.fields, "result_code"],
    filterCond: 'request_state in ("CANCELLED")',
    sort: "更新日時 desc",
    index: "8",
  });
});

test("ACLは対象7フィールドだけ差し替え、警告後の別confirmで適用する", async () => {
  const existing = {
    code: "reason",
    entities: [
      { accessibility: "WRITE", entity: { type: "GROUP", code: "everyone" } },
    ],
  };
  const { calls, warnings } = await evaluate({ rights: [existing] });
  const aclPut = calls.find(
    ({ url, method }) => url.endsWith("/field/acl.json") && method === "PUT",
  );
  assert.ok(aclPut);
  const normalizedRights = JSON.parse(JSON.stringify(aclPut.body.rights));
  assert.deepEqual(
    normalizedRights.map(({ code }) => code),
    ["reason", ...aclCodes],
  );
  assert.deepEqual(normalizedRights[0], existing);
  const targetRights = Object.fromEntries(
    normalizedRights.slice(1).map(({ code, entities }) => [code, entities]),
  );
  for (const code of aclCodes.slice(0, -1)) {
    assert.deepEqual(targetRights[code], [
      { accessibility: "READ", entity: { type: "GROUP", code: "everyone" } },
    ]);
  }
  assert.deepEqual(targetRights.cancel_requested, [
    {
      accessibility: "WRITE",
      entity: { type: "FIELD_ENTITY", code: "作成者" },
    },
    { accessibility: "READ", entity: { type: "GROUP", code: "everyone" } },
  ]);
  assert.match(warnings.join("\n"), /poll-requests --check/u);
  assert.match(readFileSync(templatePath, "utf8"), /READ.*権限削除/u);
});

test("revert-acl分岐は対象ACLだけを削除し他を保持する", async () => {
  const rights = [
    { code: "reason", entities: [] },
    ...aclCodes.map((code) => ({ code, entities: [] })),
  ];
  const { calls } = await evaluate({
    prompts: ["revert-acl", "123"],
    confirms: [true],
    rights,
  });
  assert.deepEqual(
    calls.map(({ url, method }) => `${method} ${url}`),
    [
      "GET /k/v1/preview/field/acl.json",
      "PUT /k/v1/preview/field/acl.json",
      "POST /k/v1/preview/app/deploy.json",
      "GET /k/v1/preview/app/deploy.json",
    ],
  );
  assert.deepEqual(calls[1].body.rights, [rights[0]]);
});

test("全差分適用済みならpreviewとACLへ書込せず冪等", async () => {
  const everyoneRead = {
    accessibility: "READ",
    entity: { type: "GROUP", code: "everyone" },
  };
  const rights = aclCodes.map((code) => ({
    code,
    entities:
      code === "cancel_requested"
        ? [
            {
              accessibility: "WRITE",
              entity: { type: "FIELD_ENTITY", code: "作成者" },
            },
            everyoneRead,
          ]
        : [everyoneRead],
  }));
  const { calls } = await evaluate({
    lifecycleV2: true,
    confirms: [true],
    rights,
  });
  assert.equal(
    calls.some(({ method }) => method === "POST"),
    false,
  );
  assert.equal(
    calls.some(({ method }) => method === "PUT"),
    false,
  );
});
