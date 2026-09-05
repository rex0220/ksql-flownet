import assert from "node:assert/strict";
import test from "node:test";

import {
  cancellationResultMessage,
  openCancelRequestDialog,
} from "../../dist/plugin/request-dialog.js";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.id = "";
    this.disabled = false;
    this.listeners = new Map();
    this.attributes = new Map();
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
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
  trigger(name) {
    this.listeners.get(name)?.({ preventDefault() {} });
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
    return allNodes(this.body).find((item) => item.id === id) ?? null;
  }
}

function allNodes(root) {
  return [root, ...root.children.flatMap(allNodes)];
}

function allText(root) {
  return allNodes(root)
    .map((item) => item.textContent)
    .filter(Boolean)
    .join("\n");
}

function findText(root, text) {
  return allNodes(root).find((item) => item.textContent === text);
}

const field = (value) => ({ value });
const pending = {
  id: "41",
  revision: "7",
  requestType: "RERUN",
  requestState: "REQUESTED",
  creatorCode: "operator@example.test",
  reason: "retry after correction",
  target: { runId: "run_1" },
  cancelRequested: false,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function options(document, overrides = {}) {
  return {
    pageDocument: document,
    host: document.body,
    requestAppId: "300",
    request: pending,
    fetchRecords: async () => ({ records: [] }),
    putCancelRequested: async () => {},
    onCompleted: () => {},
    ...overrides,
  };
}

test("confirmation repeats type, target, reason and irreversible warning", () => {
  const document = new FakeDocument();
  openCancelRequestDialog(options(document));
  const text = allText(document.body);
  assert.match(text, /RERUN/u);
  assert.match(text, /Run ID: run_1/u);
  assert.match(text, /retry after correction/u);
  assert.match(
    text,
    /取消は元に戻せません。再度実行するには新規に起票してください/u,
  );
});

test("successful cancellation reports polling wait and reloads once", async () => {
  const document = new FakeDocument();
  let completed = 0;
  openCancelRequestDialog(
    options(document, { onCompleted: () => (completed += 1) }),
  );
  findText(document.body, "取消を確定").trigger("click");
  await tick();
  assert.match(
    allText(document.body),
    /取消を受け付けました。次のポーラー周期で CANCELLED になります/u,
  );
  assert.equal(completed, 1);
});

test("409 followed by ACCEPTED reports processing started", async () => {
  const document = new FakeDocument();
  openCancelRequestDialog(
    options(document, {
      putCancelRequested: async () => {
        throw Object.assign(new Error("conflict"), { status: 409 });
      },
      fetchRecords: async () => ({
        records: [
          {
            $id: field("41"),
            request_state: field("ACCEPTED"),
            cancel_requested: field([]),
          },
        ],
      }),
    }),
  );
  findText(document.body, "取消を確定").trigger("click");
  await tick();
  await tick();
  assert.match(allText(document.body), /処理開始済み・取消不可/u);
});

test("communication loss follows all four readback outcomes", async (t) => {
  const cases = [
    ["REQUESTED", ["取消"], /取消受付済み・終端化待ち/u],
    ["ACCEPTED", [], /処理開始済み・取消不可/u],
    ["REQUESTED", [], /取消できませんでした.*再試行/u],
  ];
  for (const [state, checked, expected] of cases) {
    await t.test(`${state}/${checked.length}`, async () => {
      const document = new FakeDocument();
      openCancelRequestDialog(
        options(document, {
          putCancelRequested: async () => {
            throw new TypeError("network disconnected");
          },
          fetchRecords: async () => ({
            records: [
              {
                $id: field("41"),
                request_state: field(state),
                cancel_requested: field(checked),
              },
            ],
          }),
        }),
      );
      findText(document.body, "取消を確定").trigger("click");
      await tick();
      await tick();
      assert.match(allText(document.body), expected);
    });
  }

  const document = new FakeDocument();
  openCancelRequestDialog(
    options(document, {
      putCancelRequested: async () => {
        throw new TypeError("network disconnected");
      },
      fetchRecords: async () => {
        throw new TypeError("readback disconnected");
      },
    }),
  );
  findText(document.body, "取消を確定").trigger("click");
  await tick();
  await tick();
  assert.match(
    allText(document.body),
    /取消結果を確認できません。処理開始済みの可能性があります。要求一覧で確認してください/u,
  );
});

test("result classifier only asserts failure after REQUESTED without a flag", () => {
  assert.doesNotMatch(
    cancellationResultMessage({
      requestState: "REQUESTED",
      cancelRequested: true,
    }),
    /取消できませんでした/u,
  );
  assert.match(
    cancellationResultMessage({
      requestState: "REQUESTED",
      cancelRequested: false,
    }),
    /取消できませんでした/u,
  );
});
