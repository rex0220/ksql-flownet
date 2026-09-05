import assert from "node:assert/strict";
import test from "node:test";

import { classifyArchiveRun } from "../../dist/requests/request-result.js";

const processResult = (overrides = {}) => ({
  exitCode: 1,
  stdout: "{}",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const base = {
  run_id: "run-42",
  event_id: "archive-event-42",
  run_revision: 9,
  lock_released: true,
};

test("archive-run closed unionの全variantを要求結果へ分類する", () => {
  const cases = [
    [
      { ...base, outcome: "ARCHIVED", audit: "RECORDED" },
      0,
      "DONE",
      "RUN_ARCHIVED",
    ],
    [
      {
        ...base,
        outcome: "ARCHIVED",
        audit: "PENDING",
        code: "ARCHIVE_AUDIT_FAILED",
      },
      1,
      "DONE",
      "RUN_ARCHIVED_AUDIT_PENDING",
    ],
    [
      {
        ...base,
        outcome: "ARCHIVED",
        audit: "PENDING",
        code: "AUDIT_CONFLICT",
        lock_released: false,
      },
      1,
      "DONE",
      "RUN_ARCHIVED_AUDIT_PENDING",
    ],
    [
      {
        ...base,
        outcome: "ARCHIVED",
        audit: "RECORDED",
        lock_released: false,
      },
      1,
      "DONE",
      "RUN_ARCHIVED_LOCK_UNRELEASED",
    ],
    [
      { ...base, outcome: "ALREADY_ARCHIVED" },
      0,
      "DONE",
      "RUN_ALREADY_ARCHIVED",
    ],
    [
      { ...base, outcome: "ALREADY_ARCHIVED", lock_released: false },
      1,
      "DONE",
      "RUN_ARCHIVED_LOCK_UNRELEASED",
    ],
    [
      {
        ...base,
        outcome: "UNCONFIRMED",
        run_revision: null,
        code: "ARCHIVE_UNCONFIRMED",
      },
      1,
      "REJECTED",
      "ARCHIVE_UNCONFIRMED",
    ],
    [
      {
        ...base,
        outcome: "UNCONFIRMED",
        run_revision: null,
        code: "ARCHIVE_UNCONFIRMED",
        lock_released: false,
      },
      1,
      "REJECTED",
      "ARCHIVE_UNCONFIRMED",
    ],
    [
      { ...base, outcome: "REJECTED", code: "LOCK_CONFLICT" },
      1,
      "REJECTED",
      "LOCK_CONFLICT",
    ],
    [
      {
        ...base,
        outcome: "REJECTED",
        code: "ARCHIVE_WRITE_FAILED",
        lock_released: false,
      },
      1,
      "REJECTED",
      "ARCHIVE_WRITE_FAILED",
    ],
  ];
  for (const [output, exitCode, state, code] of cases) {
    const actual = classifyArchiveRun({
      output,
      process: processResult({ exitCode }),
    });
    assert.equal(actual.state, state);
    assert.equal(actual.code, code);
    assert.match(actual.message, /event_id=archive-event-42/u);
    if (output.lock_released === false)
      assert.match(actual.message, /lock_release_failed=true/u);
  }
});

test("archive-runの表外JSON・exit不一致・打ち切り・spawn失敗をfail-closedにする", () => {
  const valid = { ...base, outcome: "ARCHIVED", audit: "RECORDED" };
  const invalidCases = [
    { output: null, process: processResult() },
    { output: { ...valid, outcome: "OTHER" }, process: processResult() },
    { output: { ...valid, event_id: undefined }, process: processResult() },
    {
      output: { ...base, outcome: "REJECTED", code: "NOT_IN_CLOSED_SET" },
      process: processResult(),
    },
    { output: valid, process: processResult({ exitCode: 1 }) },
    {
      output: { ...base, outcome: "ALREADY_ARCHIVED" },
      process: processResult({ exitCode: 1 }),
    },
    {
      output: valid,
      process: processResult({ exitCode: 0, stdoutTruncated: true }),
    },
    {
      output: valid,
      process: processResult({ exitCode: 0, stderrTruncated: true }),
    },
    {
      output: valid,
      process: processResult({ exitCode: 0, spawnError: "ENOENT" }),
    },
  ];
  for (const input of invalidCases) {
    const actual = classifyArchiveRun(input);
    assert.equal(actual.state, "REJECTED");
    assert.equal(actual.code, "CHILD_RESULT_INVALID");
    assert.match(actual.message, /status --json/u);
    assert.match(actual.message, /already be ARCHIVED/u);
  }
});

test("archive-runのclosed code集合をすべて受理する", () => {
  for (const code of [
    "ARCHIVE_AUDIT_FAILED",
    "AUDIT_CONFLICT",
    "LEASE_INTERRUPTED_AFTER_ARCHIVE",
  ]) {
    assert.equal(
      classifyArchiveRun({
        output: { ...base, outcome: "ARCHIVED", audit: "PENDING", code },
        process: processResult(),
      }).code,
      "RUN_ARCHIVED_AUDIT_PENDING",
    );
  }
  for (const code of [
    "LOCK_CONFLICT",
    "LOCK_UNAVAILABLE",
    "LEASE_INTERRUPTED",
    "RUN_READ_FAILED",
    "RUN_STATUS_NOT_CLOSABLE",
    "RUN_UNKNOWN_NOT_CLOSABLE",
    "RUN_NOT_TERMINAL",
    "RUN_ON_HOLD",
    "RUN_LIVE",
    "ARCHIVE_WRITE_FAILED",
  ]) {
    assert.equal(
      classifyArchiveRun({
        output: { ...base, outcome: "REJECTED", code },
        process: processResult(),
      }).code,
      code,
    );
  }
});
