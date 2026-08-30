import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import {
  attemptKey,
  CANONICAL_RECORD_KEY_LENGTH,
  CanonicalRecordKeyError,
  nodeStateKey,
} from "../../dist/domain/canonical-record-key.js";

const vectors = JSON.parse(
  await readFile(
    new URL("../fixtures/canonical-record-key/vectors.json", import.meta.url),
    "utf8",
  ),
);
const generate = (vector) =>
  vector.kind === "state"
    ? nodeStateKey(vector.run_id, vector.node_id)
    : attemptKey(vector.run_id, vector.node_id, vector.attempt_no);

test("D-24 canonical record key vector全件に一致する", () => {
  assert.equal(vectors.metadata.hash, "SHA-256");
  for (const vector of vectors.valid) {
    const actual = generate(vector);
    assert.equal(actual, vector.expected_key, vector.id);
    assert.equal(actual.length, CANONICAL_RECORD_KEY_LENGTH, vector.id);
    assert.match(actual, /^(?:S1|A1):[A-Za-z0-9_-]{43}$/);
  }
});

test("NFC統一とcase-sensitiveを固定する", () => {
  const nfc = vectors.valid.filter(({ pair }) => pair === "nfc");
  const casing = vectors.valid.filter(({ pair }) => pair === "case");
  assert.equal(generate(nfc[0]), generate(nfc[1]));
  assert.notEqual(generate(casing[0]), generate(casing[1]));
});

test("拒否vectorは安定codeとcomponentを返す", () => {
  for (const vector of vectors.rejected) {
    assert.throws(
      () => generate(vector),
      (error) => {
        assert.ok(error instanceof CanonicalRecordKeyError, vector.id);
        assert.equal(error.code, vector.expected_error_code, vector.id);
        assert.equal(error.component, vector.expected_component, vector.id);
        return true;
      },
    );
  }
});
