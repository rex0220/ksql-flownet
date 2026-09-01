import assert from "node:assert/strict";
import test from "node:test";

import { openRequestDialog } from "../../dist/plugin/request-dialog.js";

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
      this.parent = null;
    }
  }
  trigger(name) {
    this.listeners.get(name)?.({ preventDefault() {} });
  }
}

class FakeDocument {
  constructor() {
    this.createdTags = [];
    this.body = new FakeElement("body", this);
  }
  createElement(tagName) {
    this.createdTags.push(tagName);
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
function readback(id = "88", reason = "operator reason") {
  return {
    $id: field(id),
    $revision: field("1"),
    作成者: field({ code: "operator@example.test" }),
    作成日時: field("2026-09-01T01:00:00Z"),
    request_type: field("STOP"),
    run_id: field("run_1"),
    rerun_from_node: field(""),
    reason: field(reason),
    request_state: field("REQUESTED"),
    claimed_at: field(""),
    claimed_host: field(""),
    claim_heartbeat_at: field(""),
    result_code: field(""),
    result_message: field(""),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function baseOptions(document, overrides = {}) {
  return {
    pageDocument: document,
    host: document.body,
    target: {
      action: "STOP",
      runId: "run_1",
      allowRerunFromNode: false,
      interrupted: false,
      cancelDetails: null,
    },
    fetchRecords: async (request) =>
      request.query.startsWith("$id =")
        ? { records: [readback()] }
        : { records: [] },
    postRecord: async () => ({ id: "88", revision: "1" }),
    requestAppId: "300",
    onCreated: () => {},
    ...overrides,
  };
}

test("dialog confirms operation, requires a reason, creates once, shows success, and calls board reload once", async () => {
  const document = new FakeDocument();
  let posts = 0;
  let reloads = 0;
  openRequestDialog(
    baseOptions(document, {
      postRecord: async () => {
        posts += 1;
        return { id: "88", revision: "1" };
      },
      onCreated: () => {
        reloads += 1;
      },
    }),
  );
  const form = allNodes(document.body).find((item) => item.tagName === "form");
  const reason = allNodes(document.body).find(
    (item) => item.tagName === "textarea",
  );
  assert.ok(form && reason);
  form.trigger("submit");
  assert.match(allText(document.body), /理由を入力してください/u);
  reason.value = "operator reason";
  form.trigger("submit");
  await tick();
  assert.match(allText(document.body), /操作内容の確認/u);
  assert.match(allText(document.body), /実行中SQLは完走/u);
  const send = findText(document.body, "要求を作成");
  send.trigger("click");
  send.trigger("click");
  await tick();
  await tick();
  assert.equal(posts, 1);
  assert.equal(reloads, 1);
  assert.match(allText(document.body), /最大5分ほどで処理を開始します/u);
  assert.match(allText(document.body), /DONE\/REJECTED/u);
  const link = allNodes(document.body).find((item) => item.tagName === "a");
  assert.equal(link.attributes.get("href"), "/k/300/show#record=88");
});

test("guard failure is fail-open with warning; duplicate is linked without POST", async () => {
  const document = new FakeDocument();
  let posts = 0;
  openRequestDialog(
    baseOptions(document, {
      fetchRecords: async () => {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      postRecord: async () => {
        posts += 1;
        throw new Error("stop after guard");
      },
    }),
  );
  const reason = allNodes(document.body).find(
    (item) => item.tagName === "textarea",
  );
  reason.value = "reason";
  allNodes(document.body)
    .find((item) => item.tagName === "form")
    .trigger("submit");
  await tick();
  assert.match(allText(document.body), /重複確認ができませんでした/u);
  assert.doesNotMatch(allText(document.body), /追加権限がありません/u);
  findText(document.body, "要求を作成").trigger("click");
  await tick();
  assert.equal(posts, 1);

  const duplicateDocument = new FakeDocument();
  let duplicatePosts = 0;
  openRequestDialog(
    baseOptions(duplicateDocument, {
      fetchRecords: async () => ({
        records: [
          {
            $id: field("9"),
            run_id: field("run_1"),
            request_state: field("ACCEPTED"),
          },
        ],
      }),
      postRecord: async () => {
        duplicatePosts += 1;
        return { id: "10", revision: "1" };
      },
    }),
  );
  const duplicateReason = allNodes(duplicateDocument.body).find(
    (item) => item.tagName === "textarea",
  );
  duplicateReason.value = "reason";
  allNodes(duplicateDocument.body)
    .find((item) => item.tagName === "form")
    .trigger("submit");
  await tick();
  assert.match(
    allText(duplicateDocument.body),
    /処理待ちの要求が既にあります/u,
  );
  assert.equal(duplicatePosts, 0);
});

test("generic POST/readback failures are shown as text and are never retried automatically", async () => {
  const document = new FakeDocument();
  const attack = '<img src=x onerror="globalThis.pwned=true">';
  let posts = 0;
  openRequestDialog(
    baseOptions(document, {
      fetchRecords: async (request) => {
        if (request.query.startsWith("$id =")) throw new Error(attack);
        return { records: [] };
      },
      postRecord: async () => {
        posts += 1;
        return { id: "88", revision: "1" };
      },
    }),
  );
  const reason = allNodes(document.body).find(
    (item) => item.tagName === "textarea",
  );
  reason.value = attack;
  allNodes(document.body)
    .find((item) => item.tagName === "form")
    .trigger("submit");
  await tick();
  assert.match(allText(document.body), /<img/u, "reason remains literal text");
  findText(document.body, "要求を作成").trigger("click");
  await tick();
  await tick();
  assert.equal(posts, 1);
  assert.match(
    allText(document.body),
    /<img/u,
    "API error remains literal text",
  );
  await tick();
  assert.equal(posts, 1, "no automatic retry");
  assert.equal(document.createdTags.includes("img"), false);
});

test("RELEASE shows requester/reason literally and fails closed when they are absent", () => {
  const document = new FakeDocument();
  const attack = "<script>alert(1)</script>";
  openRequestDialog(
    baseOptions(document, {
      target: {
        action: "RELEASE",
        runId: attack,
        allowRerunFromNode: false,
        interrupted: false,
        cancelDetails: {
          state: "ACCEPTED",
          requestedBy: attack,
          reason: attack,
        },
      },
    }),
  );
  assert.match(allText(document.body), /停止要求者: <script>/u);
  assert.match(allText(document.body), /停止理由: <script>/u);
  assert.equal(document.createdTags.includes("script"), false);

  openRequestDialog(
    baseOptions(document, {
      target: {
        action: "RELEASE",
        runId: "run_1",
        allowRerunFromNode: false,
        interrupted: false,
        cancelDetails: null,
      },
    }),
  );
  assert.match(allText(document.body), /解除要求を起票できません/u);
  assert.equal(
    allNodes(document.body).some((item) => item.tagName === "textarea"),
    false,
  );
  assert.equal(
    allNodes(document.body).filter(
      (item) => item.id === "ksql-flownet-request-dialog",
    ).length,
    1,
    "dialog DOM does not proliferate",
  );
});

test("detail RERUN sends the optional node and POST 403 uses the dedicated message", async () => {
  const document = new FakeDocument();
  const bodies = [];
  openRequestDialog(
    baseOptions(document, {
      target: {
        action: "RERUN",
        runId: "run_1",
        allowRerunFromNode: true,
        interrupted: true,
        cancelDetails: null,
      },
      postRecord: async (body) => {
        bodies.push(body);
        throw { status: 403 };
      },
    }),
  );
  const reason = allNodes(document.body).find(
    (item) => item.tagName === "textarea",
  );
  const rerunFrom = allNodes(document.body).find(
    (item) => item.tagName === "input" && item.name === "rerun_from_node",
  );
  reason.value = "retry reason";
  rerunFrom.value = "node_2";
  allNodes(document.body)
    .find((item) => item.tagName === "form")
    .trigger("submit");
  await tick();
  assert.match(allText(document.body), /中断分の結果はリラン時に裁定/u);
  findText(document.body, "要求を作成").trigger("click");
  await tick();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].record.rerun_from_node, field("node_2"));
  assert.match(
    allText(document.body),
    /追加権限がありません。管理者へ連絡してください/u,
  );
  await tick();
  assert.equal(bodies.length, 1);
});

test("RELEASE confirmation repeats stop context and both mandatory cautions", async () => {
  const document = new FakeDocument();
  openRequestDialog(
    baseOptions(document, {
      target: {
        action: "RELEASE",
        runId: "run_1",
        allowRerunFromNode: false,
        interrupted: false,
        cancelDetails: {
          state: "ACCEPTED",
          requestedBy: "operator-a",
          reason: "maintenance",
        },
      },
    }),
  );
  const reason = allNodes(document.body).find(
    (item) => item.tagName === "textarea",
  );
  reason.value = "release confirmed";
  allNodes(document.body)
    .find((item) => item.tagName === "form")
    .trigger("submit");
  await tick();
  const text = allText(document.body);
  assert.match(text, /停止要求者: operator-a/u);
  assert.match(text, /停止理由: maintenance/u);
  assert.match(text, /本人に確認しましたか/u);
  assert.match(text, /次の定期resumeが再開し得ます/u);
});
