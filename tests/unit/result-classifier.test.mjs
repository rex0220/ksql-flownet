import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import {
  classifyResult,
  readAndClassifyResult,
} from "../../dist/executor/result-classifier.js";

const success = () =>
  JSON.parse(
    readFileSync(
      new URL("../fixtures/execution-result/success.json", import.meta.url),
      "utf8",
    ),
  );
const context = (value, exitCode = value.exitCode) => ({
  correlationId: value.correlationId,
  attemptId: value.attemptId,
  processExitCode: exitCode,
});
const error = (category = "INTERNAL") => ({
  category,
  code: "TEST_ERROR",
  message: "controlled failure",
  retryable: false,
  detailsTruncated: false,
});

function result(resultCode, status, exitCode, executionStarted, category) {
  const value = success();
  Object.assign(value, {
    status,
    resultCode,
    exitCode,
    executionStarted,
    error: status === "SUCCESS" ? null : error(category),
    startedAt: executionStarted ? value.startedAt : null,
  });
  return value;
}

test("contract正常系: SUCCESS/OK・SUCCESS/NO_DATAとID echoを受理する", () => {
  for (const code of ["OK", "NO_DATA"]) {
    const value = result(code, "SUCCESS", 0, true);
    if (code === "NO_DATA") {
      value.readCount = 0;
      value.writtenCount = 0;
      value.deletedCount = 0;
      value.apiCalls = 0;
      value.lastSuccessfulChunkNo = null;
      value.lastWrittenKey = null;
    }
    const classified = classifyResult(value, context(value));
    assert.equal(classified.kind, "VALID_RESULT");
    assert.equal(classified.attemptOutcome, "SUCCESS");
    assert.equal(classified.resultCode, code);
  }
});

test("controlled failure表をExit/status/resultCodeの組として分類する", () => {
  const cases = [
    ["VALIDATION_ERROR", "FAILED", 1, false, "FAILED"],
    ["SQL_ERROR", "FAILED", 1, true, "FAILED"],
    ["ASSERT_FAILED", "FAILED", 2, true, "FAILED"],
    ["API_ERROR", "FAILED", 3, true, "FAILED"],
    ["LOCK_UNAVAILABLE", "FAILED", 3, false, "FAILED"],
    ["CANCELLED", "CANCELLED", 3, true, "CANCELLED"],
    ["LOCK_CONFLICT", "FAILED", 5, false, "LOCK_CONFLICT"],
  ];
  for (const [code, status, exitCode, started, outcome] of cases) {
    const value = result(code, status, exitCode, started);
    assert.equal(
      classifyResult(value, context(value)).attemptOutcome,
      outcome,
      code,
    );
  }
});

test("JSONなし・途中切れはNO_RESULTとしてUNKNOWN候補にする", async () => {
  const missing = await readAndClassifyResult(
    "missing",
    context(success()),
    async () => {
      throw new Error("ENOENT");
    },
  );
  const truncated = await readAndClassifyResult(
    "partial",
    context(success()),
    async () => '{"formatVersion":',
  );
  assert.equal(missing.kind, "NO_RESULT");
  assert.equal(truncated.kind, "NO_RESULT");
  assert.equal(missing.attemptOutcome, "UNKNOWN");
});

test("契約literal・ID・process Exitの不一致をINVALID_RESULTにする", () => {
  const mutations = [
    ["formatVersion", 2],
    ["kind", "OTHER"],
    ["contract", "other/v1"],
    ["correlationId", "wrong"],
    ["attemptId", "wrong"],
  ];
  for (const [field, replacement] of mutations) {
    const value = success();
    value[field] = replacement;
    assert.equal(
      classifyResult(value, context(success())).kind,
      "INVALID_RESULT",
      field,
    );
  }
  const value = success();
  assert.equal(classifyResult(value, context(value, 3)).kind, "INVALID_RESULT");
});

test("status-resultCode・executionStarted矛盾を拒否する", () => {
  const contradictions = [
    result("OK", "FAILED", 1, true),
    result("VALIDATION_ERROR", "FAILED", 1, true),
    result("LOCK_CONFLICT", "FAILED", 5, true),
    result("NO_DATA", "SUCCESS", 0, false),
  ];
  for (const value of contradictions)
    assert.equal(classifyResult(value, context(value)).kind, "INVALID_RESULT");
});

test("count負数・非整数と必須field欠落を拒否する", () => {
  for (const [field, replacement] of [
    ["readCount", -1],
    ["writtenCount", 0.5],
    ["deletedCount", -1],
    ["apiCalls", 1.2],
    ["lastSuccessfulChunkNo", -1],
  ]) {
    const value = success();
    value[field] = replacement;
    assert.equal(
      classifyResult(value, context(value)).kind,
      "INVALID_RESULT",
      field,
    );
  }
  const value = success();
  delete value.executionId;
  assert.equal(classifyResult(value, context(value)).kind, "INVALID_RESULT");
});

test("未知resultCodeはstatus/Exit整合時に保存し、矛盾時はUNKNOWNにする", () => {
  const valid = result("NEW_ADDITIVE_CODE", "FAILED", 3, true);
  assert.deepEqual(
    {
      kind: classifyResult(valid, context(valid)).kind,
      code: classifyResult(valid, context(valid)).resultCode,
    },
    { kind: "VALID_RESULT", code: "NEW_ADDITIVE_CODE" },
  );
  const invalid = result("NEW_ADDITIVE_CODE", "FAILED", 0, true);
  assert.equal(
    classifyResult(invalid, context(invalid)).kind,
    "INVALID_RESULT",
  );
});

test("input_filesのrows/encoding付き安全receiptを受理し不正shapeを拒否する", () => {
  const value = success();
  value.input_files = [
    {
      name: "sales",
      sha256: "a".repeat(64),
      bytes: 123,
      rows: 7,
      encoding: "utf8",
    },
  ];
  assert.equal(classifyResult(value, context(value)).kind, "VALID_RESULT");
  for (const input_files of [
    [{ ...value.input_files[0], sha256: "bad" }],
    [{ ...value.input_files[0], rows: -1 }],
    [{ ...value.input_files[0], name: "C:\\secret\\sales.csv" }],
  ]) {
    assert.equal(
      classifyResult({ ...value, input_files }, context(value)).kind,
      "INVALID_RESULT",
    );
  }
});

test("output_filesの安全receiptを受理しpath・不正sha・未知encodingを拒否する", () => {
  const value = success();
  value.output_files = [
    {
      name: "report",
      sha256: "c".repeat(64),
      bytes: 456,
      rows: 8,
      encoding: "utf8",
    },
  ];
  assert.equal(classifyResult(value, context(value)).kind, "VALID_RESULT");
  for (const output_files of [
    [{ ...value.output_files[0], sha256: "bad" }],
    [{ ...value.output_files[0], encoding: "utf-8" }],
    [{ ...value.output_files[0], path: "C:\\private\\report.csv" }],
    [value.output_files[0], value.output_files[0]],
  ]) {
    assert.equal(
      classifyResult({ ...value, output_files }, context(value)).kind,
      "INVALID_RESULT",
    );
  }
});
