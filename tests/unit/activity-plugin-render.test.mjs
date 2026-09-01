import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_TEXT,
  copyRunId,
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

function findText(root, text) {
  return allNodes(root).find((node) => node.textContent === text);
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
  const board = root.children[0];
  const toolbar = board.children[0];
  assert.equal(toolbar.className, "ksql-flownet-toolbar");
  assert.equal(toolbar.children[0].tagName, "h2");
  assert.equal(toolbar.children[0].textContent, "Run状況");
  assert.equal(findText(toolbar, "再読込").className, "ksql-flownet-reload");
  assert.equal(
    board.children.at(-1).className,
    "ksql-flownet-section",
    "reload must not be rendered in a board footer",
  );
  const sectionHeaders = allNodes(root).filter(
    (node) => node.className === "ksql-flownet-section-header",
  );
  assert.equal(sectionHeaders.length, 2);
  assert.deepEqual(
    sectionHeaders.map((header) => header.children[1].textContent),
    ["4件", "0件"],
  );
  assert.ok(
    sectionHeaders.every(
      (header) => header.children[1].className === "ksql-flownet-count-badge",
    ),
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

test("two sections render every action kind, remaining count, copy callback, and do not proliferate DOM", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  const attack = '<img src=x onerror="pwned=true">';
  const enrich = (base, action, overrides = {}) => ({
    ...base,
    updatedAt: "2026-09-01T00:00:00.000Z",
    resumeAllowed: true,
    lifecycleStatus: "ACTIVE",
    action,
    actionError: null,
    cancelDetails: null,
    ...overrides,
  });
  const activeRows = [
    enrich(row("LIVE", 1), { kind: "action", action: "STOP" }),
    enrich(
      row("STOPPED", 2),
      { kind: "action", action: "RELEASE" },
      {
        cancelDetails: {
          state: "ACCEPTED",
          requestedBy: attack,
          reason: attack,
        },
      },
    ),
    enrich(row("IDLE", 3), { kind: "none" }),
    enrich(row("INTERRUPTED", 4), {
      kind: "pending",
      pending: {
        oldestId: "9",
        count: 2,
        label: "要求処理待ち 2件(最古 #9)",
      },
      secondaryNotice: null,
      copyRunId: false,
    }),
  ];
  const terminalBase = (id, status, action) => ({
    runId: id === 3 ? attack : `terminal_${id}`,
    recordId: String(200 + id),
    recordUrl: `/k/1/show#record=${200 + id}`,
    businessKey: `terminal_business_${id}`,
    status,
    updatedAt: "2026-09-01T00:00:00.000Z",
    activity: null,
    resumeAllowed: true,
    lifecycleStatus: "ACTIVE",
    action,
    actionError: null,
    cancelDetails: null,
  });
  const model = {
    activeSection: { state: "ready", rows: activeRows, error: null },
    attentionSection: {
      state: "ready",
      rows: [
        terminalBase(1, "FAILED", { kind: "action", action: "RERUN" }),
        terminalBase(2, "CANCELLED", {
          kind: "disabled",
          message: "再開が無効化されています。",
        }),
        terminalBase(3, "UNKNOWN", {
          kind: "unknown",
          message: "二次対応者へ連絡してください。",
          copyRunId: true,
        }),
        terminalBase(4, "FAILED", {
          kind: "invalid",
          message: "状態を安全に判定できません。",
        }),
      ],
      error: null,
    },
    attentionRemainingCount: 7,
    pendingWarning: "重複確認ができませんでした",
    requestEnabled: true,
    requestAppId: "300",
    judgedAt: Date.parse("2026-09-01T00:00:00Z"),
    state: "ready",
    rows: activeRows,
    error: null,
  };
  const actions = [];
  const copies = [];
  const callbacks = {
    onReload: () => {},
    onAction: (target) => actions.push(target),
    onCopyRunId: (runId) => copies.push(runId),
  };
  renderBoard(root, model, callbacks);
  renderBoard(root, model, callbacks);
  const text = allText(root);
  for (const expected of [
    "未終端Run",
    "要対応(終端)",
    "停止要求",
    "解除要求",
    "リラン要求",
    "要求処理待ち 2件(最古 #9)",
    "再開が無効化されています。",
    "二次対応者へ連絡してください。",
    "判定不能",
    "他7件(決着済みを含む)",
  ])
    assert.ok(text.includes(expected), expected);
  assert.equal(
    allNodes(root).filter((item) => item.tagName === "table").length,
    2,
  );
  assert.deepEqual(
    allNodes(root)
      .filter((item) => item.className === "ksql-flownet-count-badge")
      .map((item) => item.textContent),
    ["4件", "4件"],
  );
  assert.equal(
    allNodes(root).filter(
      (item) => item.className === "ksql-flownet-operation-cell",
    ).length,
    10,
  );
  assert.equal(root.children.length, 1, "replaceChildren keeps one board root");
  findText(root, "停止要求").listeners.get("click")();
  findText(root, "Run IDをコピー").listeners.get("click")();
  assert.equal(actions[0].action, "STOP");
  assert.deepEqual(copies, [attack]);
  assert.equal(document.createdTags.includes("img"), false);
});

test("section failures are isolated in the DOM", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  renderBoard(
    root,
    {
      activeSection: { state: "ready", rows: [], error: null },
      attentionSection: { state: "error", rows: [], error: "terminal failure" },
      attentionRemainingCount: 0,
      pendingWarning: null,
      requestEnabled: false,
      requestAppId: null,
      judgedAt: 1,
      state: "ready",
      rows: [],
      error: null,
    },
    () => {},
  );
  assert.match(allText(root), /未終端Runはありません/u);
  assert.match(allText(root), /terminal failure/u);
});

test("Run ID copy reports clipboard success and failure", async () => {
  const document = new FakeDocument();
  const copied = [];
  document.defaultView = {
    navigator: {
      clipboard: { writeText: async (value) => copied.push(value) },
    },
  };
  assert.equal(await copyRunId(document, "run_<unsafe>"), true);
  assert.deepEqual(copied, ["run_<unsafe>"]);
  document.defaultView.navigator.clipboard.writeText = async () => {
    throw new Error("denied");
  };
  assert.equal(await copyRunId(document, "run_2"), false);
});
