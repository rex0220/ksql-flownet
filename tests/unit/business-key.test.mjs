import assert from "node:assert/strict";
import test from "node:test";

import { resolveBusinessKey } from "../../dist/domain/business-key.js";
import { MAX_BUSINESS_KEY_LENGTH } from "../../dist/domain/network-definition.js";

function scheduledPolicy(period, timezone, format) {
  return { type: "scheduled_period", period, timezone, format };
}

function resolveScheduled(scheduledFor, policy) {
  return resolveBusinessKey({
    networkId: "close",
    policy,
    scheduledFor,
  });
}

test("scheduled day keys use the policy IANA timezone for the same UTC instant", () => {
  const tokyo = scheduledPolicy(
    "day",
    "Asia/Tokyo",
    "{network_id}@{yyyy}-{MM}-{dd}",
  );
  assert.equal(
    resolveScheduled("2026-08-31T15:00:00Z", tokyo).businessKey,
    "close@2026-09-01",
  );
  assert.equal(
    resolveScheduled("2026-09-01T00:00:00+09:00", tokyo).businessKey,
    "close@2026-09-01",
  );

  const utc = scheduledPolicy("day", "UTC", "{yyyy}-{MM}-{dd}");
  assert.equal(
    resolveScheduled("2026-12-31T23:59:59Z", utc).businessKey,
    "2026-12-31",
  );

  const losAngeles = scheduledPolicy(
    "day",
    "America/Los_Angeles",
    "{yyyy}-{MM}-{dd}",
  );
  assert.equal(
    resolveScheduled("2027-01-01T07:59:59Z", losAngeles).businessKey,
    "2026-12-31",
  );
  assert.equal(
    resolveScheduled("2027-01-01T08:00:00Z", losAngeles).businessKey,
    "2027-01-01",
  );
});

test("IANA conversion stays correct immediately across a DST transition", () => {
  const newYork = scheduledPolicy(
    "day",
    "America/New_York",
    "{yyyy}-{MM}-{dd}",
  );
  assert.equal(
    resolveScheduled("2026-03-08T06:59:59Z", newYork).businessKey,
    "2026-03-08",
  );
  assert.equal(
    resolveScheduled("2026-03-08T07:00:00Z", newYork).businessKey,
    "2026-03-08",
  );
  assert.equal(
    resolveScheduled("2026-11-01T05:59:59Z", newYork).businessKey,
    "2026-11-01",
  );
  assert.equal(
    resolveScheduled("2026-11-01T06:00:00Z", newYork).businessKey,
    "2026-11-01",
  );
});

test("month keys normalize month-end and year rollover deterministically", () => {
  const policy = scheduledPolicy(
    "month",
    "Asia/Tokyo",
    "{network_id}@{yyyy}-{MM}",
  );
  const vectors = [
    ["2026-08-31T15:00:00Z", "close@2026-09"],
    ["2026-12-31T23:59:59+09:00", "close@2026-12"],
    ["2027-01-01T00:00:00+09:00", "close@2027-01"],
    ["2026-12-31T15:00:00Z", "close@2027-01"],
  ];
  for (const [scheduledFor, expected] of vectors) {
    assert.equal(resolveScheduled(scheduledFor, policy).businessKey, expected);
  }

  const input = {
    networkId: "close",
    policy,
    scheduledFor: "2027-01-01T00:00:00+09:00",
  };
  const outputs = Array.from(
    { length: 10 },
    () => resolveBusinessKey(input).businessKey,
  );
  assert.deepEqual(outputs, Array(10).fill("close@2027-01"));
});

test("scheduled timestamps require a valid explicit offset", () => {
  const policy = scheduledPolicy("day", "UTC", "{yyyy}-{MM}-{dd}");
  for (const invalid of [
    "2026-01-01T00:00:00",
    "2026-02-30T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:00+14:30",
    "2026-01-01T00:00:00.1234Z",
    "not-a-timestamp",
  ]) {
    assert.deepEqual(
      resolveScheduled(invalid, policy).errors.map((error) => error.code),
      ["SCHEDULED_FOR_INVALID"],
      invalid,
    );
  }
});

test("scheduled key resolution rejects period and format mismatches itself", () => {
  for (const policy of [
    scheduledPolicy("month", "UTC", "{yyyy}-{MM}-{dd}"),
    scheduledPolicy("day", "UTC", "{yyyy}-{MM}"),
    scheduledPolicy("day", "UTC", "{yyyy}-{MM}-{dd}-{hour}"),
  ]) {
    assert.ok(
      resolveScheduled("2026-01-01T00:00:00Z", policy).errors.some((error) =>
        ["FORMAT_PERIOD_MISMATCH", "FORMAT_PLACEHOLDER_UNSUPPORTED"].includes(
          error.code,
        ),
      ),
    );
  }
});

test("policy-specific required and forbidden inputs fail closed", () => {
  const scheduled = scheduledPolicy("day", "UTC", "{yyyy}-{MM}-{dd}");
  const missing = resolveBusinessKey({ networkId: "close", policy: scheduled });
  assert.deepEqual(
    missing.errors.map((error) => error.code),
    ["SCHEDULED_FOR_REQUIRED"],
  );
  assert.match(
    missing.errors[0].message,
    /either --scheduled-for or --business-key is required/,
  );
  assert.equal(
    resolveBusinessKey({
      networkId: "close",
      policy: scheduled,
      businessKey: "close@2026-01-correction",
    }).businessKey,
    "close@2026-01-correction",
  );
  const correction = resolveBusinessKey({
    networkId: "close",
    policy: scheduled,
    scheduledFor: "2026-01-01T00:00:00Z",
    businessKey: "override",
  });
  assert.equal(correction.businessKey, "override");
  assert.deepEqual(correction.errors, []);
  assert.deepEqual(
    resolveBusinessKey({
      networkId: "close",
      policy: scheduled,
      scheduledFor: "not-a-timestamp",
      businessKey: "override",
    }).errors.map((error) => error.code),
    ["SCHEDULED_FOR_INVALID"],
  );
  assert.deepEqual(
    resolveBusinessKey({
      networkId: "close",
      policy: scheduled,
      scheduledFor: "2026-01-01T00:00:00Z",
      businessKey: "bad\nkey",
    }).errors.map((error) => error.code),
    ["BUSINESS_KEY_CONTROL_CHARACTER"],
  );

  const explicit = { type: "explicit" };
  assert.deepEqual(
    resolveBusinessKey({ networkId: "close", policy: explicit }).errors.map(
      (error) => error.code,
    ),
    ["BUSINESS_KEY_REQUIRED"],
  );
  assert.deepEqual(
    resolveBusinessKey({
      networkId: "close",
      policy: explicit,
      businessKey: "key",
      scheduledFor: "2026-01-01T00:00:00Z",
    }).errors.map((error) => error.code),
    ["SCHEDULED_FOR_NOT_ALLOWED"],
  );
});

test("provided keys are preserved exactly and reject unsafe values", () => {
  const exact = "  close@2026-08 correction  ";
  const policies = [
    { type: "explicit" },
    scheduledPolicy("month", "UTC", "{network_id}@{yyyy}-{MM}"),
  ];
  for (const policy of policies) {
    assert.equal(
      resolveBusinessKey({ networkId: "close", policy, businessKey: exact })
        .businessKey,
      exact,
    );

    for (const [value, code] of [
      ["", "BUSINESS_KEY_EMPTY"],
      ["x".repeat(MAX_BUSINESS_KEY_LENGTH + 1), "BUSINESS_KEY_TOO_LONG"],
      ["line1\nline2", "BUSINESS_KEY_CONTROL_CHARACTER"],
      ["nul\0value", "BUSINESS_KEY_CONTROL_CHARACTER"],
    ]) {
      assert.deepEqual(
        resolveBusinessKey({
          networkId: "close",
          policy,
          businessKey: value,
        }).errors.map((error) => error.code),
        [code],
      );
    }
  }
});
