import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_TEXT,
  limitDisplayValue,
  renderBoard,
  renderDetail,
} from "../../dist/plugin/render.js";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.listeners = new Map();
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  set innerHTML(_value) {
    throw new Error("innerHTML must not be used");
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
}

class FakeDocument {
  constructor() {
    this.createdTags = [];
  }

  createElement(tagName) {
    this.createdTags.push(tagName);
    return new FakeElement(tagName, this);
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

function row(activity, index) {
  return {
    runId: `run_${index}`,
    recordId: `${100 + index}`,
    recordUrl: `/k/1/show#record=${100 + index}`,
    businessKey: `business_${index}`,
    status: "RUNNING",
    startedAt: index === 2 ? null : "2026-09-01T00:00:00.000Z",
    activity,
    evidence: `evidence_${index}`,
    actionText: ACTION_TEXT[activity],
    judgedAt: Date.parse("2026-09-01T00:00:00Z"),
    error: null,
  };
}

test("board view model renders four badges, fixed actions, evidence, and judged time", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  renderBoard(
    root,
    {
      state: "ready",
      rows: ["LIVE", "IDLE", "STOPPED", "INTERRUPTED"].map(row),
      judgedAt: Date.parse("2026-09-01T00:00:00Z"),
      error: null,
    },
    () => {},
  );
  const text = allText(root);
  for (const activity of ["LIVE", "IDLE", "STOPPED", "INTERRUPTED"]) {
    assert.match(text, new RegExp(activity, "u"));
    assert.ok(text.includes(ACTION_TEXT[activity]));
  }
  assert.match(text, /evidence_0/u);
  assert.match(text, /判定時刻:/u);
  assert.equal(
    allNodes(root).filter((node) =>
      node.className.startsWith("ksql-flownet-badge "),
    ).length,
    4,
  );
  assert.equal(
    allNodes(root).filter((node) => node.textContent === "再読込").length,
    1,
  );
  // レコード番号列は詳細画面への相対リンク(2026-09-01ユーザー要望)
  const links = allNodes(root).filter((node) => node.tagName === "a");
  assert.equal(links.length, 4);
  assert.equal(links[0].textContent, "100");
  assert.equal(links[0].attributes.get("href"), "/k/1/show#record=100");
  assert.match(allText(root), /レコード/u);
});

test("empty and fail-closed models render without an activity badge", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  renderBoard(
    root,
    { state: "ready", rows: [], judgedAt: 1, error: null },
    () => {},
  );
  assert.match(allText(root), /未終端Runはありません/u);
  renderBoard(
    root,
    { state: "error", rows: [], judgedAt: null, error: "権限エラー" },
    () => {},
  );
  assert.match(allText(root), /判定不能/u);
  assert.match(allText(root), /判定時刻: 未判定/u);
  assert.equal(
    allNodes(root).some((node) => node.className.includes("badge--")),
    false,
  );
});

test("record values remain text, are length-limited, and never create injected elements", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  const attack = `<img src=x onerror=alert(1)>${"x".repeat(300)}`;
  renderBoard(
    root,
    {
      state: "ready",
      rows: [
        {
          ...row("LIVE", 1),
          runId: attack,
          businessKey: "<script>alert(1)</script>",
          evidence: attack,
        },
      ],
      judgedAt: 1,
      error: null,
    },
    () => {},
  );
  assert.match(allText(root), /<script>alert\(1\)<\/script>/u);
  assert.equal(document.createdTags.includes("script"), false);
  assert.equal(document.createdTags.includes("img"), false);
  assert.ok(limitDisplayValue(attack).endsWith("…"));
  assert.equal([...limitDisplayValue(attack)].length, 161);
});

test("detail renders terminal text and a ready badge without duplication", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  renderDetail(root, { state: "terminal" });
  assert.equal(allText(root), "終端(activityなし)");
  renderDetail(root, { state: "ready", row: row("INTERRUPTED", 1) });
  assert.equal(
    allNodes(root).filter((node) => node.textContent === "INTERRUPTED").length,
    1,
  );
  assert.match(allText(root), /二次対応者へ連絡/u);
});
