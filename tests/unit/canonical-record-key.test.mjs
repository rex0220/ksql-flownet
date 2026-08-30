import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import {
  attemptKey,
  CANONICAL_RECORD_KEY_LENGTH,
  CanonicalRecordKeyError,
  nodeStateKey,
  runKey,
} from "../../dist/domain/canonical-record-key.js";

const vectors = JSON.parse(
  await readFile(
    new URL("../fixtures/canonical-record-key/vectors.json", import.meta.url),
    "utf8",
  ),
);
const generate = (vector) =>
  vector.kind === "run"
    ? runKey(vector.profile, vector.network_id, vector.business_key)
    : vector.kind === "state"
      ? nodeStateKey(vector.run_id, vector.node_id)
      : attemptKey(vector.run_id, vector.node_id, vector.attempt_no);

test("R1/S1/A1 canonical record key vector全件に一致する", () => {
  assert.equal(vectors.metadata.hash, "SHA-256");
  for (const vector of vectors.valid) {
    const actual = generate(vector);
    assert.equal(actual, vector.expected_key, vector.id);
    assert.equal(actual.length, CANONICAL_RECORD_KEY_LENGTH, vector.id);
    assert.match(actual, /^(?:R1|S1|A1):[A-Za-z0-9_-]{43}$/);
  }
});

test("NFC統一とcase-sensitiveを固定する", () => {
  for (const pair of ["nfc", "run_nfc"]) {
    const vectorsForPair = vectors.valid.filter(
      (vector) => vector.pair === pair,
    );
    assert.equal(generate(vectorsForPair[0]), generate(vectorsForPair[1]));
  }
  for (const pair of ["case", "run_case"]) {
    const vectorsForPair = vectors.valid.filter(
      (vector) => vector.pair === pair,
    );
    assert.notEqual(generate(vectorsForPair[0]), generate(vectorsForPair[1]));
  }
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
