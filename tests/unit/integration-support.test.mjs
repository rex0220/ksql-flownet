import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIntegrationKeyLengths,
  assertIntegrationKeySampleLengths,
  assertObserved,
  integrationKeySamples,
  makeScope,
  summarizeError,
} from "../integration/support.mjs";

test("M3 scopeは試験名を含まない19文字のIT識別子になる", () => {
  const scope = makeScope("m3-write-failure-recovery");

  assert.match(scope, /^IT\d{12}_[0-9a-f]{4}$/);
  assert.equal(scope.length, 19);
  assert.doesNotMatch(scope, /write|failure|recovery/);
});

test("M3の全派生キーは64文字以内になる", () => {
  const scope = "IT260830123456_abcd";
  const samples = assertIntegrationKeyLengths(scope);

  assert.deepEqual(samples, integrationKeySamples(scope));
  assert.ok(samples.length > 0);
  assert.deepEqual([...new Set(samples.map(({ kind }) => kind))].sort(), [
    "attempt_key",
    "business_key",
    "invocation_id",
    "job_id",
    "lock_key",
    "network_id",
    "node_attempt_id",
    "node_id",
    "node_state_id",
    "node_state_key",
    "owner_instance_id",
    "owner_invocation_id",
    "profile",
    "record_key.ATT",
    "record_key.INV",
    "record_key.LOCK",
    "record_key.LOCKDONE",
    "record_key.OP",
    "record_key.R1",
    "record_key.STATE",
    "run_id",
    "scope",
  ]);
  assert.equal(Math.max(...samples.map(({ length }) => length)), 52);
  for (const sample of samples) {
    assert.ok(sample.length <= 64, `${sample.kind}: ${sample.value}`);
  }
});

test("M3派生キーが64文字を超える場合は開始前エラーにする", () => {
  assert.throws(
    () =>
      assertIntegrationKeySampleLengths([
        { kind: "record_key.R1", value: "x".repeat(65), length: 65 },
      ]),
    /M3 integration key exceeds 64 characters: kind=record_key\.R1 actualLength=65/,
  );
});

test("M3 assertion失敗は期待値と観測値をmessageとJSON項目へ残す", () => {
  let caught;
  try {
    assertObserved(
      false,
      { code: "DUPLICATE_RECORD", status: 400 },
      {
        code: "REMOTE_ERROR",
        status: 503,
        apiCode: "GAIA_TM01",
        message: "temporary failure",
      },
      "競合裁定が不正です",
    );
  } catch (error) {
    caught = summarizeError(error);
  }

  assert.deepEqual(caught.expected, {
    code: "DUPLICATE_RECORD",
    status: 400,
  });
  assert.deepEqual(caught.actual, {
    code: "REMOTE_ERROR",
    status: 503,
    apiCode: "GAIA_TM01",
    message: "temporary failure",
  });
  assert.match(caught.message, /expected=.*DUPLICATE_RECORD/);
  assert.match(caught.message, /actual=.*REMOTE_ERROR/);
});
