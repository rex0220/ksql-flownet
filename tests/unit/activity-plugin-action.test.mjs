import assert from "node:assert/strict";
import test from "node:test";

import {
  decideBoardAction,
  matrixAction,
} from "../../dist/plugin/board-action.js";

const statuses = [
  "CREATED",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
];
const activities = [null, "IDLE", "LIVE", "STOPPED", "INTERRUPTED"];
const expected = {
  CREATED: ["INVALID", "NONE", "STOP", "RELEASE", "RERUN"],
  RUNNING: ["INVALID", "NONE", "STOP", "RELEASE", "RERUN"],
  SUCCESS: ["NONE", "INVALID", "INVALID", "INVALID", "INVALID"],
  FAILED: ["RERUN", "INVALID", "INVALID", "INVALID", "INVALID"],
  CANCELLED: ["RERUN", "INVALID", "INVALID", "INVALID", "INVALID"],
  UNKNOWN: ["UNKNOWN", "INVALID", "INVALID", "INVALID", "INVALID"],
};

test("all 30 status x activity cells match the reviewed matrix", () => {
  let cells = 0;
  for (const status of statuses) {
    for (const [index, activity] of activities.entries()) {
      assert.equal(
        matrixAction(status, activity),
        expected[status][index],
        `${status} x ${String(activity)}`,
      );
      cells += 1;
    }
  }
  assert.equal(cells, 30);
});

test("RERUN alone uses resume_allowed and ACTIVE two-condition gate", () => {
  for (const overrides of [
    { resumeAllowed: false, lifecycleStatus: "ACTIVE" },
    { resumeAllowed: true, lifecycleStatus: "ARCHIVED" },
  ]) {
    assert.deepEqual(
      decideBoardAction({
        status: "FAILED",
        activity: null,
        pending: null,
        ...overrides,
      }),
      { kind: "disabled", message: "再開が無効化されています。" },
    );
  }
  assert.deepEqual(
    decideBoardAction({
      status: "RUNNING",
      activity: "LIVE",
      resumeAllowed: false,
      lifecycleStatus: "ARCHIVED",
    }),
    { kind: "action", action: "STOP" },
  );
});

test("priority is invalid > pending > RERUN disabled > matrix", () => {
  const pending = {
    oldestId: "9",
    count: 2,
    label: "要求処理待ち 2件(最古 #9)",
  };
  assert.equal(
    decideBoardAction({
      status: "SUCCESS",
      activity: "LIVE",
      resumeAllowed: true,
      lifecycleStatus: "ACTIVE",
      pending,
    }).kind,
    "invalid",
  );
  assert.equal(
    decideBoardAction({
      status: "FAILED",
      activity: null,
      resumeAllowed: false,
      lifecycleStatus: "ARCHIVED",
      pending,
    }).kind,
    "pending",
  );
  assert.equal(
    decideBoardAction({
      status: "FAILED",
      activity: null,
      resumeAllowed: false,
      lifecycleStatus: "ACTIVE",
    }).kind,
    "disabled",
  );
  assert.equal(
    decideBoardAction({
      status: "FAILED",
      activity: null,
      resumeAllowed: true,
      lifecycleStatus: "ACTIVE",
    }).kind,
    "action",
  );
});

test("UNKNOWN keeps contact/copy guidance alongside pending and matrix text is XSS-safe", () => {
  const attack = '<img src=x onerror="globalThis.pwned=true">';
  const model = decideBoardAction({
    status: "UNKNOWN",
    activity: null,
    resumeAllowed: true,
    lifecycleStatus: "ACTIVE",
    pending: { oldestId: "1", count: 1, label: attack },
  });
  assert.equal(model.kind, "pending");
  assert.equal(model.secondaryNotice, "二次対応者へ連絡してください。");
  assert.equal(model.copyRunId, true);
  assert.equal(
    model.pending.label,
    attack,
    "値はDOM生成せずplain textのまま渡す",
  );
  assert.equal(Object.hasOwn(model, "html"), false);

  const invalid = decideBoardAction({
    status: "FAILED",
    activity: null,
    resumeAllowed: true,
    lifecycleStatus: "ACTIVE",
    judgementError: true,
  });
  assert.equal(invalid.kind, "invalid");
  assert.doesNotMatch(invalid.message, /<img/u);
});
