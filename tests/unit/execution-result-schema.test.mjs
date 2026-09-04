import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  );
}

const schema = readJson(
  "../../spikes/e-execution-contract/execution-result-v1.draft.schema.json",
);
const success = readJson("../fixtures/execution-result/success.json");
const failure = readJson("../fixtures/execution-result/failure.json");
const sqlError = readJson("../fixtures/execution-result/sql-error.json");
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function assertValid(value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

test("contract section 3.1 and 3.2 fixtures satisfy the draft schema", () => {
  assertValid(success);
  assertValid(failure);
  assertValid(sqlError);
});

test("additive unknown fields are accepted", () => {
  assertValid({ ...success, futureDiagnostic: { source: "fixture" } });
});

test("output_files receipt is additive but each item is strict and path-free", () => {
  const receipt = {
    name: "report",
    sha256: "a".repeat(64),
    bytes: 123,
    rows: 4,
    encoding: "utf8",
  };
  assertValid({ ...success, output_files: [receipt] });
  for (const output_files of [
    [{ ...receipt, sha256: "bad" }],
    [{ ...receipt, encoding: "utf-8" }],
    [{ ...receipt, path: "C:\\private\\report.csv" }],
  ]) {
    assert.equal(validate({ ...success, output_files }), false);
  }
});

test("unknown result codes with a consistent status and exit code are accepted", () => {
  assertValid({ ...failure, resultCode: "FUTURE_CODE" });
});

test("missing required fields are rejected", () => {
  const missingAttemptId = { ...success };
  delete missingAttemptId.attemptId;
  assert.equal(validate(missingAttemptId), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "required"));
});

test("literal mismatches are rejected", () => {
  for (const invalid of [
    { ...success, formatVersion: 2 },
    { ...success, kind: "OTHER_RESULT" },
    { ...success, contract: "ksql-flow.execution/v2" },
  ]) {
    assert.equal(validate(invalid), false);
  }
});

test("known result codes must agree with status, exit, and start boundary", () => {
  for (const invalid of [
    { ...success, status: "FAILED" },
    { ...failure, exitCode: 0 },
    {
      ...failure,
      resultCode: "LOCK_CONFLICT",
      exitCode: 5,
      executionStarted: true,
    },
    { ...failure, executionStarted: false, startedAt: failure.startedAt },
    { ...sqlError, exitCode: 3 },
  ]) {
    assert.equal(validate(invalid), false);
  }
});
