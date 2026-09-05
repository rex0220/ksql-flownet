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
  constructor(sessionStorage) {
    this.createdTags = [];
    this.defaultView =
      sessionStorage === undefined ? undefined : { sessionStorage };
  }

  createElement(tagName) {
    this.createdTags.push(tagName);
    return new FakeElement(tagName, this);
  }
}

class FakeSessionStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
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
  assert.equal(toolbar.children[0].className, "ksql-flownet-toolbar-title");
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

test("configured board header renders START button and pending link; unset board renders neither", () => {
  const document = new FakeDocument();
  const base = {
    activeSection: { state: "ready", rows: [], error: null },
    attentionSection: { state: "ready", rows: [], error: null },
    attentionRemainingCount: 0,
    pendingWarning: null,
    judgedAt: Date.parse("2026-09-02T00:00:00Z"),
    state: "ready",
    rows: [],
    error: null,
  };
  const root = new FakeElement("div", document);
  let starts = 0;
  renderBoard(
    root,
    {
      ...base,
      requestEnabled: true,
      requestAppId: "300",
      pendingStartCount: 2,
      pendingStartRequests: [],
    },
    { onReload: () => {}, onStart: () => (starts += 1) },
  );
  const button = findText(root, "新規実行");
  assert.ok(button);
  button.listeners.get("click")();
  assert.equal(starts, 1);
  const pending = findText(root, "処理待ちのSTART要求 2件");
  assert.equal(pending.tagName, "a");
  assert.match(pending.attributes.get("href"), /^\/k\/300\/\?query=/u);

  renderBoard(
    root,
    {
      ...base,
      requestEnabled: false,
      requestAppId: null,
      pendingStartCount: null,
      pendingStartRequests: null,
    },
    { onReload: () => {}, onStart: () => (starts += 1) },
  );
  assert.equal(findText(root, "新規実行"), undefined);
  assert.equal(
    allNodes(root).some((node) =>
      node.textContent.startsWith("処理待ちのSTART要求"),
    ),
    false,
  );
});

test("pending START section hides when empty and renders multiple safe linked detail rows in JST", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  const base = {
    activeSection: { state: "ready", rows: [], error: null },
    attentionSection: { state: "ready", rows: [], error: null },
    attentionRemainingCount: 0,
    pendingWarning: null,
    pendingStartCount: 0,
    requestEnabled: true,
    requestAppId: "300",
    loginUserCode: "operator@example.test",
    judgedAt: Date.parse("2026-09-02T00:00:00Z"),
    state: "ready",
    rows: [],
    error: null,
  };
  renderBoard(
    root,
    { ...base, pendingStartRequests: [] },
    { onReload: () => {} },
  );
  assert.equal(
    allNodes(root).some(
      (node) => node.className === "ksql-flownet-start-request-section",
    ),
    false,
  );

  const attack = '<img src=x onerror="alert(1)">';
  renderBoard(
    root,
    {
      ...base,
      pendingStartCount: 2,
      pendingStartRequests: [
        {
          id: "41",
          revision: "2",
          requestType: "START",
          requestState: "REQUESTED",
          target: {
            networkId: "monthly",
            businessKey: "monthly@2026-09",
            scheduledFor: "2026-09-01T01:23:00Z",
          },
          reason: `長い理由 ${"理由".repeat(100)}`,
          creatorCode: "operator@example.test",
          cancelRequested: false,
        },
        {
          id: "42",
          revision: "3",
          requestType: "START",
          requestState: "ACCEPTED",
          target: { networkId: attack, businessKey: null, scheduledFor: null },
          reason: attack,
          creatorCode: attack,
          cancelRequested: false,
        },
      ],
    },
    { onReload: () => {}, onCancelRequest: () => {} },
  );
  const text = allText(root);
  assert.match(text, /START要求/u);
  assert.match(text, /REQUESTED/u);
  assert.match(text, /ACCEPTED/u);
  assert.match(text, /業務キー: monthly@2026-09/u);
  assert.match(text, /対象日時: 2026\/09\/01 10:23/u);
  assert.match(text, /operator@example\.test/u);
  assert.equal(
    allNodes(root).filter((node) => node.textContent === "取消").length,
    1,
  );
  const recordLinks = allNodes(root).filter(
    (node) =>
      node.tagName === "a" &&
      /^\/k\/300\/show#record=/u.test(node.attributes.get("href") ?? ""),
  );
  assert.deepEqual(
    recordLinks.map((node) => [node.textContent, node.attributes.get("href")]),
    [
      ["#41 START", "/k/300/show#record=41"],
      ["#42 START", "/k/300/show#record=42"],
    ],
  );
  assert.equal(
    allNodes(root).filter((node) => node.tagName === "img").length,
    0,
    "untrusted values must only reach textContent",
  );
  assert.ok(
    allNodes(root).some(
      (node) => node.className === "ksql-flownet-start-request-reason",
    ),
  );
});

test("section headings share the bold title class and START content toggles accessibly", async () => {
  const sessionStorage = new FakeSessionStorage();
  const document = new FakeDocument(sessionStorage);
  const root = new FakeElement("div", document);
  renderBoard(
    root,
    {
      activeSection: { state: "ready", rows: [], error: null },
      attentionSection: { state: "ready", rows: [], error: null },
      attentionRemainingCount: 0,
      pendingWarning: null,
      pendingStartCount: 1,
      pendingStartRequests: [
        {
          id: "41",
          requestState: "REQUESTED",
          networkId: "monthly",
          businessKey: null,
          scheduledFor: null,
          reason: "確認",
          creatorName: "運用担当",
          createdAt: "2026-09-01T00:00:00Z",
        },
      ],
      terminalStartRequests: [],
      recentTerminalRuns: [
        {
          recordId: "70",
          status: "SUCCESS",
          networkId: "monthly",
          businessKey: "monthly@2026-09",
          asOf: "2026-09-01T01:23:00Z",
          updatedAt: "2026-09-01T02:34:00Z",
        },
      ],
      stateAppId: "100",
      requestEnabled: true,
      requestAppId: "300",
      judgedAt: 1,
      state: "ready",
      rows: [],
      error: null,
    },
    { onReload: () => {} },
  );

  const headings = allNodes(root).filter((node) => node.tagName === "h3");
  assert.equal(headings.length, 4);
  assert.ok(
    headings.every(
      (heading) => heading.className === "ksql-flownet-section-title",
    ),
  );

  const toggle = allNodes(root).find(
    (node) => node.className === "ksql-flownet-section-toggle",
  );
  const content = allNodes(root).find(
    (node) => node.id === "ksql-flownet-start-request-content",
  );
  const chevron = toggle.children[0];
  assert.equal(toggle.tagName, "button");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.attributes.get("aria-controls"), content.id);
  assert.equal(toggle.attributes.get("aria-expanded"), "true");
  assert.equal(content.hidden, false, "START要求は初期展開する");
  assert.equal(chevron.textContent, "▼");
  assert.equal(findText(toggle, "1件").textContent, "1件");

  toggle.listeners.get("click")();
  assert.equal(content.hidden, true);
  assert.equal(toggle.attributes.get("aria-expanded"), "false");
  assert.equal(chevron.textContent, "▶");
  assert.equal(findText(toggle, "1件").textContent, "1件");
  assert.equal(
    sessionStorage.getItem("ksql-flownet-start-section-collapsed"),
    "1",
  );

  renderBoard(
    root,
    {
      activeSection: { state: "ready", rows: [], error: null },
      attentionSection: { state: "ready", rows: [], error: null },
      attentionRemainingCount: 0,
      pendingWarning: null,
      pendingStartCount: 1,
      pendingStartRequests: [
        {
          id: "42",
          requestState: "REQUESTED",
          networkId: "monthly",
          businessKey: null,
          scheduledFor: null,
          reason: "再描画確認",
          creatorName: "運用担当",
          createdAt: "2026-09-01T00:00:00Z",
        },
      ],
      terminalStartRequests: [],
      recentTerminalRuns: [],
      stateAppId: "100",
      requestEnabled: true,
      requestAppId: "300",
      judgedAt: 1,
      state: "ready",
      rows: [],
      error: null,
    },
    { onReload: () => {} },
  );
  const restoredToggle = allNodes(root).find(
    (node) => node.className === "ksql-flownet-section-toggle",
  );
  const restoredContent = allNodes(root).find(
    (node) => node.id === "ksql-flownet-start-request-content",
  );
  assert.equal(restoredContent.hidden, true);
  assert.equal(restoredToggle.attributes.get("aria-expanded"), "false");
  assert.equal(restoredToggle.children[0].textContent, "▶");

  restoredToggle.listeners.get("click")();
  assert.equal(restoredContent.hidden, false);
  assert.equal(restoredToggle.attributes.get("aria-expanded"), "true");
  assert.equal(restoredToggle.children[0].textContent, "▼");
  assert.equal(
    sessionStorage.getItem("ksql-flownet-start-section-collapsed"),
    "0",
  );

  const { readFileSync } = await import("node:fs");
  const css = readFileSync(
    new globalThis.URL("../../plugin/css/desktop.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.ksql-flownet-section-title\s*\{[^}]*color:\s*#24353d;[^}]*font-weight:\s*700;/su,
  );
});

test("START section stays expanded when sessionStorage throws", () => {
  const throwingStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
  const document = new FakeDocument(throwingStorage);
  const root = new FakeElement("div", document);
  renderBoard(
    root,
    {
      activeSection: { state: "ready", rows: [], error: null },
      attentionSection: { state: "ready", rows: [], error: null },
      attentionRemainingCount: 0,
      pendingWarning: null,
      pendingStartCount: 1,
      pendingStartRequests: [
        {
          id: "43",
          requestState: "REQUESTED",
          networkId: "monthly",
          businessKey: null,
          scheduledFor: null,
          reason: "例外確認",
          creatorName: "運用担当",
          createdAt: "2026-09-01T00:00:00Z",
        },
      ],
      terminalStartRequests: [],
      recentTerminalRuns: [],
      stateAppId: "100",
      requestEnabled: true,
      requestAppId: "300",
      judgedAt: 1,
      state: "ready",
      rows: [],
      error: null,
    },
    { onReload: () => {} },
  );
  const toggle = allNodes(root).find(
    (node) => node.className === "ksql-flownet-section-toggle",
  );
  const content = allNodes(root).find(
    (node) => node.id === "ksql-flownet-start-request-content",
  );
  assert.equal(content.hidden, false);
  assert.equal(toggle.attributes.get("aria-expanded"), "true");
  assert.doesNotThrow(() => toggle.listeners.get("click")());
  assert.equal(content.hidden, true);
});

test("START request history renders terminal results and tones below pending rows", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  renderBoard(
    root,
    {
      activeSection: { state: "ready", rows: [], error: null },
      attentionSection: { state: "ready", rows: [], error: null },
      attentionRemainingCount: 0,
      pendingWarning: null,
      pendingStartCount: 1,
      pendingStartRequests: [
        {
          id: "60",
          requestState: "REQUESTED",
          networkId: "monthly",
          businessKey: null,
          scheduledFor: null,
          reason: "pending",
          creatorName: "担当",
          createdAt: "2026-09-01T00:00:00Z",
        },
      ],
      terminalStartRequests: [
        {
          id: "59",
          requestState: "DONE",
          networkId: "monthly",
          businessKey: "monthly@2026-09",
          scheduledFor: null,
          reason: "done",
          creatorName: "担当",
          createdAt: "2026-09-01T00:00:00Z",
          resultCode: "OK",
          resultMessage: null,
        },
        {
          id: "58",
          requestState: "REJECTED",
          networkId: "blocked",
          businessKey: null,
          scheduledFor: null,
          reason: "rejected",
          creatorName: "担当",
          createdAt: "2026-09-01T00:00:00Z",
          resultCode: "NETWORK_NOT_ALLOWED",
          resultMessage: "許可対象外です",
        },
      ],
      recentTerminalRuns: [],
      stateAppId: "100",
      requestEnabled: true,
      requestAppId: "300",
      judgedAt: 1,
      state: "ready",
      rows: [],
      error: null,
    },
    { onReload: () => {} },
  );
  const text = allText(root);
  assert.match(text, /START要求/u);
  assert.match(text, /03_取消済み/u);
  assert.match(text, /OK/u);
  assert.match(text, /NETWORK_NOT_ALLOWED \/ 許可対象外です/u);
  const statuses = allNodes(root).filter((node) =>
    node.className.startsWith("ksql-flownet-status "),
  );
  assert.deepEqual(
    statuses.map(({ textContent, className }) => [textContent, className]),
    [
      ["DONE", "ksql-flownet-status ksql-flownet-status--done"],
      ["REJECTED", "ksql-flownet-status ksql-flownet-status--rejected"],
    ],
  );
});

test("recent terminal Run section renders links, JST and SUCCESS tone, and hides at zero", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  const base = {
    activeSection: { state: "ready", rows: [], error: null },
    attentionSection: { state: "ready", rows: [], error: null },
    attentionRemainingCount: 0,
    pendingWarning: null,
    pendingStartCount: null,
    pendingStartRequests: null,
    terminalStartRequests: null,
    stateAppId: "100",
    requestEnabled: false,
    requestAppId: null,
    judgedAt: 1,
    state: "ready",
    rows: [],
    error: null,
  };
  renderBoard(
    root,
    { ...base, recentTerminalRuns: [] },
    { onReload: () => {} },
  );
  assert.equal(findText(root, "最近の終了Run（直近10件）"), undefined);

  renderBoard(
    root,
    {
      ...base,
      recentTerminalRuns: [
        {
          recordId: "70",
          status: "SUCCESS",
          networkId: "monthly",
          businessKey: "monthly@2026-09",
          asOf: "2026-09-01T01:23:00Z",
          updatedAt: "2026-09-01T02:34:00Z",
        },
      ],
    },
    { onReload: () => {} },
  );
  assert.ok(findText(root, "最近の終了Run（直近10件）"));
  assert.match(allText(root), /2026\/09\/01 10:23/u);
  assert.match(allText(root), /2026\/09\/01 11:34/u);
  const link = findText(root, "#70");
  assert.equal(link.attributes.get("href"), "/k/100/show#record=70");
  assert.equal(link.attributes.get("target"), "_blank");
  assert.equal(
    findText(root, "SUCCESS").className,
    "ksql-flownet-status ksql-flownet-status--success",
  );
});

test("empty and fail-closed models render without an activity badge", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  renderBoard(
    root,
    { state: "ready", rows: [], judgedAt: 1, error: null },
    () => {},
  );
  assert.match(allText(root), /進行中のRunはありません/u);
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

test("terminal detail renders at most three error nodes as text without XSS", () => {
  const document = new FakeDocument();
  const root = new FakeElement("div", document);
  const attack = '<img src=x onerror="pwned=true">';
  const longAttack = `${attack}${"x".repeat(300)}`;
  renderDetail(root, {
    state: "ready",
    terminal: true,
    requestEnabled: false,
    requestAppId: null,
    allowRerunFromNode: true,
    row: {
      runId: "run_1",
      recordId: "1",
      recordUrl: "/k/100/show#record=1",
      businessKey: "business_1",
      status: "FAILED",
      updatedAt: "2026-09-01T00:00:00.000Z",
      activity: null,
      resumeAllowed: true,
      lifecycleStatus: "ACTIVE",
      action: { kind: "none" },
      actionError: null,
      cancelDetails: null,
      errorSummary: {
        state: "ready",
        items: [1, 2, 3, 4].map((id) => ({
          nodeId: `${attack}_${id}`,
          resultCode: "SQL_ERROR",
          statusReason: id === 1 ? attack : null,
          attemptRecordId: String(10 - id),
          errorMessage: id === 1 ? longAttack : null,
        })),
      },
    },
  });
  assert.equal(
    allNodes(root).filter((node) => node.tagName === "li").length,
    3,
  );
  assert.match(allText(root), /<img src=x/u);
  assert.ok(
    allNodes(root).some(
      (node) => node.textContent === limitDisplayValue(longAttack),
    ),
    "error_messageはtextContentで最大表示長へ制限する",
  );
  assert.equal(document.createdTags.includes("img"), false);
  assert.equal(document.createdTags.includes("script"), false);
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
    enrich(row("LIVE", 1), { kind: "actions", actions: ["STOP"] }),
    enrich(
      row("STOPPED", 2),
      { kind: "actions", actions: ["RELEASE"] },
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
      pending: [
        {
          id: "9",
          revision: "2",
          requestType: "RERUN",
          requestState: "REQUESTED",
          creatorCode: "me",
          reason: "first reason",
          target: { runId: "run_4" },
          cancelRequested: false,
        },
        {
          id: "10",
          revision: "3",
          requestType: "CLOSE",
          requestState: "ACCEPTED",
          creatorCode: "me",
          reason: "second reason",
          target: { runId: "run_4" },
          cancelRequested: false,
        },
        {
          id: "11",
          revision: "4",
          requestType: "STOP",
          requestState: "REQUESTED",
          creatorCode: "other",
          reason: "third reason",
          target: { runId: "run_4" },
          cancelRequested: false,
        },
      ],
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
        terminalBase(1, "FAILED", {
          kind: "actions",
          actions: ["RERUN", "CLOSE"],
        }),
        terminalBase(2, "CANCELLED", {
          kind: "disabled",
          message: "再開が無効化されています。",
        }),
        terminalBase(3, "UNKNOWN", {
          kind: "unknown",
          message: "二次対応者へ連絡してください。",
          holdNotice: null,
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
    loginUserCode: "me",
    judgedAt: Date.parse("2026-09-01T00:00:00Z"),
    state: "ready",
    rows: activeRows,
    error: null,
  };
  const actions = [];
  const copies = [];
  const cancellations = [];
  const callbacks = {
    onReload: () => {},
    onAction: (target) => actions.push(target),
    onCancelRequest: (request) => cancellations.push(request.id),
    onCopyRunId: (runId) => copies.push(runId),
  };
  renderBoard(root, model, callbacks);
  renderBoard(root, model, callbacks);
  const text = allText(root);
  for (const expected of [
    "進行中のRun",
    "終了済み・対応が必要なRun",
    "停止要求",
    "解除要求",
    "リラン要求",
    "#9 RERUN / REQUESTED",
    "#10 CLOSE / ACCEPTED",
    "#11 STOP / REQUESTED",
    "クローズ要求",
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
  findText(root, "取消").listeners.get("click")();
  findText(root, "Run IDをコピー").listeners.get("click")();
  assert.equal(actions[0].action, "STOP");
  assert.deepEqual(cancellations, ["9"]);
  assert.equal(
    allNodes(root).filter((item) => item.textContent === "取消").length,
    1,
  );
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
  assert.match(allText(root), /進行中のRunはありません/u);
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

test("列名は日本語統一・日時はローカル表示・状態/時刻セルは改行禁止class(2026-09-01実機フィードバック)", async () => {
  const { formatLocalDateTime } = await import("../../dist/plugin/render.js");
  const formatted = formatLocalDateTime("2026-09-01T10:49:00Z");
  assert.match(formatted, /2026\/09\/01/u);
  assert.doesNotMatch(formatted, /Z|T10:49/u);
  assert.equal(formatLocalDateTime("not-a-date"), "not-a-date");
  const source = (await import("node:fs")).readFileSync(
    new globalThis.URL("../../plugin/src/render.ts", import.meta.url),
    "utf8",
  );
  for (const label of [
    '"業務キー"',
    '"状態"',
    '"アクティビティ"',
    '"開始時刻"',
    '"更新時刻"',
  ]) {
    assert.ok(source.includes(label), `列名 ${label} が必要`);
  }
  for (const forbidden of [
    '"Business Key"',
    '"Status"',
    '"Activity"',
    '"Started At"',
  ]) {
    assert.ok(!source.includes(forbidden), `英語列名 ${forbidden} を残さない`);
  }
  assert.ok(source.includes("ksql-flownet-cell-nowrap"));
});

test("レコード/要求リンクは別タブで開き、エラー概要の同値重複を省く(2026-09-01要望)", async () => {
  const source = (await import("node:fs")).readFileSync(
    new globalThis.URL("../../plugin/src/render.ts", import.meta.url),
    "utf8",
  );
  const targetCount = (
    source.match(/setAttribute\("target", "_blank"\)/gu) ?? []
  ).length;
  assert.equal(targetCount, 3, "Run・要求・最近の終了Runリンクに_blank");
  assert.equal(
    (source.match(/noopener noreferrer/gu) ?? []).length,
    3,
    "rel=noopener noreferrer必須",
  );
  const { formatErrorSummaryLine } =
    await import("../../dist/plugin/render.js");
  assert.equal(
    formatErrorSummaryLine({
      state: "ready",
      items: [
        {
          nodeId: "n1",
          resultCode: "API_ERROR",
          statusReason: "API_ERROR",
          attemptRecordId: "1",
        },
      ],
    }),
    "n1: API_ERROR",
  );
  assert.match(
    formatErrorSummaryLine({
      state: "ready",
      items: [
        {
          nodeId: "n1",
          resultCode: "API_ERROR",
          statusReason: "詳細理由",
          attemptRecordId: "1",
        },
      ],
    }),
    /n1: API_ERROR \/ 詳細理由/u,
  );
});

test("エラー本文はサブ行(colspan・折り返し)で表示し、概要セルは分類のみ(2026-09-01実機)", async () => {
  const { formatErrorSummaryLine, errorSummaryMessage } =
    await import("../../dist/plugin/render.js");
  const summary = {
    state: "ready",
    items: [
      {
        nodeId: "n1",
        resultCode: "API_ERROR",
        statusReason: null,
        attemptRecordId: "1",
        errorMessage: "long message ".repeat(30),
      },
    ],
  };
  assert.equal(formatErrorSummaryLine(summary), "n1: API_ERROR");
  const message = errorSummaryMessage(summary);
  assert.ok(message.startsWith("n1: long message"));
  assert.ok([...message].length <= 161, "本文はlimitDisplayValueで制限");
  assert.equal(errorSummaryMessage({ state: "unavailable" }), null);
  assert.equal(errorSummaryMessage({ state: "ready", items: [] }), null);
  const source = (await import("node:fs")).readFileSync(
    new globalThis.URL("../../plugin/src/render.ts", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('setAttribute("colspan", "7")'));
  assert.ok(source.includes("ksql-flownet-error-message-row"));
});
