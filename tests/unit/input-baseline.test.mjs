import assert from "node:assert/strict";
import test from "node:test";

import {
  INPUT_AUDIT_SUMMARY_MAX_LENGTH,
  inputBaselinesEqual,
  parseInputBaseline,
  serializeInputAuditSummary,
  serializeInputBaseline,
} from "../../dist/io/input-baseline.js";

test("baselineはversion付き厳密形式でsource順にcanonical化する", () => {
  const summary = serializeInputBaseline([
    { name: "zeta", sha256: "b".repeat(64), bytes: 20 },
    { name: "売上-source", sha256: "a".repeat(64), bytes: 10 },
  ]);
  assert.deepEqual(parseInputBaseline(summary), [
    { source: "zeta", sha256: "b".repeat(64), bytes: 20 },
    { source: "売上-source", sha256: "a".repeat(64), bytes: 10 },
  ]);
  assert.equal(
    inputBaselinesEqual(parseInputBaseline(summary), [
      { name: "zeta", sha256: "b".repeat(64), bytes: 20 },
      { name: "売上-source", sha256: "a".repeat(64), bytes: 10 },
    ]),
    true,
  );
  assert.ok(summary.length <= INPUT_AUDIT_SUMMARY_MAX_LENGTH);
});

test("baseline parserは未知field・非canonical順・不正hashをfail-closedにする", () => {
  for (const value of [
    { version: 2, kind: "KSQL_FLOWNET_INPUT_BASELINE", inputs: [] },
    {
      version: 1,
      kind: "KSQL_FLOWNET_INPUT_BASELINE",
      inputs: [{ source: "sales", sha256: "x".repeat(64), bytes: 1 }],
    },
    {
      version: 1,
      kind: "KSQL_FLOWNET_INPUT_BASELINE",
      inputs: [],
      path: "C:\\secret\\sales.csv",
    },
  ]) {
    assert.throws(() => parseInputBaseline(JSON.stringify(value)));
  }
  assert.equal(parseInputBaseline("ordinary safe error"), null);
});

test("input_files要約はrows/encodingを含みpathやセル値を含めない", () => {
  const summary = serializeInputAuditSummary(
    [{ name: "sales", sha256: "a".repeat(64), bytes: 123 }],
    [
      {
        source: "sales",
        sha256: "a".repeat(64),
        bytes: 123,
        rows: 7,
        encoding: "utf8",
      },
    ],
  );
  const value = JSON.parse(summary);
  assert.deepEqual(value.input_files, [
    {
      source: "sales",
      type: "IMPORT",
      sha256: "aaaaaaaaaaaa",
      bytes: 123,
      rows: 7,
      encoding: "utf8",
    },
  ]);
  assert.equal(summary.includes("secret"), false);
  assert.equal(summary.includes("cell-value"), false);
  assert.deepEqual(parseInputBaseline(summary), [
    { source: "sales", sha256: "a".repeat(64), bytes: 123 },
  ]);
});

test("安全要約は最大長を超える入力を拒否する", () => {
  const inputs = Array.from({ length: 200 }, (_, index) => ({
    name: `source_${String(index).padStart(3, "0")}_${"x".repeat(40)}`,
    sha256: "a".repeat(64),
    bytes: index,
  }));
  assert.throws(() => serializeInputBaseline(inputs), /exceeds/);
});
