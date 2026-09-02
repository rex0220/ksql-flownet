import assert from "node:assert/strict";
import test from "node:test";

import { openStartRequestDialog } from "../../dist/plugin/start-request-dialog.js";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.id = "";
    this.value = "";
    this.disabled = false;
    this.required = false;
    this.listeners = new Map();
    this.attributes = new Map();
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  set innerHTML(_value) {
    throw new Error("innerHTML must not be used");
  }
  append(...children) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children) {
    for (const child of children) child.parent = this;
    this.children = [...children];
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  focus() {}
  remove() {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    }
  }
  trigger(name, event = { preventDefault() {} }) {
    this.listeners.get(name)?.(event);
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body", this);
  }
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
  getElementById(id) {
    return allNodes(this.body).find((node) => node.id === id) ?? null;
  }
}

function allNodes(root) {
  return [root, ...root.children.flatMap(allNodes)];
}
function allText(root) {
  return allNodes(root)
    .map((node) => node.textContent)
    .filter(Boolean)
    .join("\n");
}
function named(root, name) {
  return allNodes(root).find((node) => node.name === name);
}
const field = (value) => ({ value });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function readback(id = "88") {
  return {
    $id: field(id),
    $revision: field("1"),
    作成者: field({ code: "operator@example.test" }),
    作成日時: field("2026-09-02T01:00:00Z"),
    request_type: field("START"),
    run_id: field(""),
    network_id: field("monthly"),
    business_key: field(""),
    scheduled_for: field("2026-08-31T15:00:00Z"),
    rerun_from_node: field(""),
    reason: field("monthly start"),
    request_state: field("REQUESTED"),
    claimed_at: field(""),
    claimed_host: field(""),
    claim_heartbeat_at: field(""),
    result_code: field(""),
    result_message: field(""),
  };
}

function options(document, overrides = {}) {
  return {
    pageDocument: document,
    host: document.body,
    stateAppId: 100,
    requestAppId: "300",
    fetchRecords: async (request) => {
      if (request.query.startsWith("$id =")) return { records: [readback()] };
      return { records: [] };
    },
    postRecord: async () => ({ id: "88", revision: "1" }),
    onCreated: () => {},
    ...overrides,
  };
}

test("dialog switches 3 modes, keeps free inputs, cautions, and candidate text XSS-safe", async () => {
  const document = new FakeDocument();
  openStartRequestDialog(
    options(document, {
      fetchRecords: async (request) => {
        if (request.app === "300" && request.query.includes('"DONE"')) {
          return {
            records: [
              {
                $id: field("1"),
                request_type: field("START"),
                request_state: field("DONE"),
                network_id: field('<img src=x onerror="attack">'),
                business_key: field("key"),
                scheduled_for: field(""),
              },
            ],
          };
        }
        return { records: [] };
      },
    }),
  );
  await tick();
  const text = allText(document.body);
  for (const expected of [
    "新規実行",
    "参考候補(過去実績)",
    "START要求実績(DONE)",
    "Run実績",
    "実際に起動可能かはサーバー側設定で判定されます。",
    "最大5分ほどで処理を開始します",
    "network_id(必須 — サーバー側で許可されたもののみ起動します)",
    "同じ名前は再実行できません。完了済みと同名はスキップ、未完了と同名は拒否されます(リランはボードのリラン要求で)。",
    '<img src=x onerror="attack"> / key',
  ]) {
    assert.match(text, new RegExp(expected.replace(/[()]/gu, "\\$&"), "u"));
  }
  assert.equal(
    allNodes(document.body).some((node) => node.tagName === "img"),
    false,
  );
  const mode = named(document.body, "mode");
  const business = named(document.body, "business_key");
  const scheduled = named(document.body, "scheduled_for");
  const modeDescription = allNodes(document.body).find((node) =>
    node.className.split(" ").includes("ksql-flownet-start-mode-description"),
  );
  const dialog = allNodes(document.body).find((node) =>
    node.className.split(" ").includes("ksql-flownet-start-dialog"),
  );
  const scroll = allNodes(document.body).find((node) =>
    node.className.split(" ").includes("ksql-flownet-start-dialog-scroll"),
  );
  const footer = allNodes(document.body).find((node) =>
    node.className.split(" ").includes("ksql-flownet-start-dialog-footer"),
  );
  assert.ok(dialog);
  assert.ok(scroll);
  assert.ok(footer);
  assert.equal(named(document.body, "network_id").tagName, "input");
  assert.equal(named(document.body, "network_id_other"), undefined);
  assert.equal(
    modeDescription.textContent,
    "まだ実行していない月(期間)の分を起動します。業務キーは対象期間から自動で決まります。",
  );
  assert.equal(
    named(document.body, "business_key").className,
    "ksql-flownet-start-business-key",
  );
  assert.equal(business.disabled, true);
  assert.equal(scheduled.required, true);
  mode.value = "correction";
  mode.trigger("change");
  assert.equal(
    modeDescription.textContent,
    "完了済みの期間をやり直します。同じ名前は二度実行できないため、新しい補正キーと集計の対象期間の両方を指定します。",
  );
  assert.equal(
    business.placeholder,
    "例: monthly_deal_summary@2026-08-correction-1(2回目は-2)",
  );
  assert.equal(business.required, true);
  assert.equal(scheduled.required, true);
  mode.value = "explicit";
  mode.trigger("change");
  assert.equal(
    modeDescription.textContent,
    "定期でないネットワーク用。業務キーは意味のある一意な名前を付けます。",
  );
  assert.equal(business.placeholder, "例: adhoc-ticket-123");
  assert.equal(business.required, true);
  assert.equal(scheduled.disabled, true);
});

test("設定一覧があればnetwork_id selectとその他入力を切替え、選択値をPOSTする", async () => {
  const document = new FakeDocument();
  let postedNetworkId = null;
  openStartRequestDialog(
    options(document, {
      allowedNetworkIds: ["monthly", "adhoc", '<img src=x onerror="attack">'],
      postRecord: async (body) => {
        postedNetworkId = body.record.network_id.value;
        return { id: "88", revision: "1" };
      },
    }),
  );
  await tick();
  const networkSelect = named(document.body, "network_id");
  const otherInput = named(document.body, "network_id_other");
  assert.equal(networkSelect.tagName, "select");
  assert.deepEqual(
    networkSelect.children.map((option) => option.textContent),
    [
      "選択してください",
      "monthly",
      "adhoc",
      '<img src=x onerror="attack">',
      "その他(自由入力)",
    ],
  );
  assert.equal(
    allNodes(document.body).some((node) => node.tagName === "img"),
    false,
  );
  assert.equal(otherInput.hidden, true);
  assert.equal(otherInput.disabled, true);

  const otherValue = networkSelect.children.at(-1).attributes.get("value");
  networkSelect.value = otherValue;
  networkSelect.trigger("change");
  assert.equal(otherInput.hidden, false);
  assert.equal(otherInput.disabled, false);
  assert.equal(otherInput.required, true);

  networkSelect.value = "monthly";
  networkSelect.trigger("change");
  assert.equal(otherInput.hidden, true);
  named(document.body, "scheduled_for").value = "2026-09-01T00:00";
  named(document.body, "reason").value = "monthly start";
  allNodes(document.body)
    .find((node) => node.tagName === "form")
    .trigger("submit");
  await tick();
  await tick();
  assert.equal(postedNetworkId, "monthly");
});

test("datetime-local paste sets a parsed JST minute and leaves invalid paste alone", async () => {
  const document = new FakeDocument();
  openStartRequestDialog(options(document));
  const scheduled = named(document.body, "scheduled_for");
  let prevented = false;
  scheduled.trigger("paste", {
    clipboardData: { getData: () => "2026-08-15T00:30:59Z" },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(scheduled.value, "2026-08-15T09:30");
  assert.equal(prevented, true);

  prevented = false;
  scheduled.trigger("paste", {
    clipboardData: { getData: () => "invalid" },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(scheduled.value, "2026-08-15T09:30");
  assert.equal(prevented, false);
});

test("submit locks double click, posts once, and shows success link then reloads once", async () => {
  const document = new FakeDocument();
  let posts = 0;
  let reloads = 0;
  openStartRequestDialog(
    options(document, {
      postRecord: async (body) => {
        posts += 1;
        assert.deepEqual(Object.keys(body.record), [
          "request_type",
          "network_id",
          "business_key",
          "scheduled_for",
          "reason",
        ]);
        return { id: "88", revision: "1" };
      },
      onCreated: () => {
        reloads += 1;
      },
    }),
  );
  await tick();
  named(document.body, "network_id").value = "monthly";
  named(document.body, "scheduled_for").value = "2026-09-01T00:00";
  named(document.body, "reason").value = "monthly start";
  const form = allNodes(document.body).find((node) => node.tagName === "form");
  form.trigger("submit");
  form.trigger("submit");
  await tick();
  await tick();
  assert.equal(posts, 1);
  assert.equal(reloads, 1);
  assert.match(allText(document.body), /START要求 #88 を作成しました/u);
  assert.match(allText(document.body), /Runが作成されるとボードに現れます/u);
  const link = allNodes(document.body).find((node) => node.tagName === "a");
  assert.equal(link.attributes.get("href"), "/k/300/show#record=88");
});

test("guard GET failure is fail-open and POST 403 keeps its dedicated message", async () => {
  const document = new FakeDocument();
  let posts = 0;
  openStartRequestDialog(
    options(document, {
      fetchRecords: async (request) => {
        if (request.query.includes('"REQUESTED"')) throw { status: 403 };
        return { records: [] };
      },
      postRecord: async () => {
        posts += 1;
        throw { response: { status: 403 } };
      },
    }),
  );
  await tick();
  named(document.body, "network_id").value = "monthly";
  named(document.body, "scheduled_for").value = "2026-09-01T00:00";
  named(document.body, "reason").value = "monthly start";
  allNodes(document.body)
    .find((node) => node.tagName === "form")
    .trigger("submit");
  await tick();
  await tick();
  assert.equal(posts, 1);
  assert.match(allText(document.body), /重複確認ができませんでした/u);
  assert.match(allText(document.body), /追加権限がありません/u);
});
