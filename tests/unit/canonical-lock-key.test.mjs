import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import {
  CANONICAL_LOCK_KEY_LENGTH,
  CanonicalLockKeyError,
  MAX_KINTONE_UNIQUE_KEY_LENGTH,
  jobLockKey,
  networkLockKey,
} from "../../dist/domain/canonical-lock-key.js";

const vectors = JSON.parse(
  await readFile(
    new URL("../fixtures/canonical-lock-key/vectors.json", import.meta.url),
    "utf8",
  ),
);

function generate(vector) {
  return vector.kind === "network"
    ? networkLockKey(vector.profile, vector.identifier)
    : jobLockKey(vector.profile, vector.identifier);
}

test("D-10 canonical lock keyの固定test vector全件に一致する", () => {
  assert.equal(vectors.metadata.hash, "SHA-256");
  assert.equal(vectors.metadata.normalization, "Unicode NFC");
  assert.equal(vectors.metadata.generated_key_length, 46);
  for (const vector of vectors.valid) {
    const actual = generate(vector);
    assert.equal(actual, vector.expected_key, vector.id);
    assert.equal(actual.length, CANONICAL_LOCK_KEY_LENGTH, vector.id);
    assert.ok(actual.length <= MAX_KINTONE_UNIQUE_KEY_LENGTH, vector.id);
    assert.match(actual, /^(?:N1|J1):[A-Za-z0-9_-]{43}$/);
  }
});

test("NFD入力はNFCと同じキーになり、大文字小文字違いは別キーになる", () => {
  const normalizationPair = vectors.valid.filter(
    ({ pair }) => pair === "nfc_normalization",
  );
  assert.equal(normalizationPair.length, 2);
  assert.equal(generate(normalizationPair[0]), generate(normalizationPair[1]));

  const casePair = vectors.valid.filter(
    ({ pair }) => pair === "case_sensitive",
  );
  assert.equal(casePair.length, 2);
  assert.notEqual(generate(casePair[0]), generate(casePair[1]));
});

test("禁止値と境界超過はvectorで固定した安定codeを返す", () => {
  for (const vector of vectors.rejected) {
    assert.throws(
      () => generate(vector),
      (error) => {
        assert.ok(error instanceof CanonicalLockKeyError, vector.id);
        assert.equal(error.code, vector.expected_error_code, vector.id);
        assert.equal(error.component, vector.expected_component, vector.id);
        return true;
      },
    );
  }
});
