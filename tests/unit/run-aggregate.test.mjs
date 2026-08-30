import assert from "node:assert/strict";
import test from "node:test";

import { computeRunAggregateStatus } from "../../dist/domain/run-aggregate.js";

const cases = [
  [
    "UNKNOWN has highest priority",
    ["SUCCESS", "RUNNING", "UNKNOWN"],
    null,
    "UNKNOWN",
  ],
  ["RUNNING precedes failure", ["FAILED", "RUNNING"], null, "RUNNING"],
  ["FAILED", ["SUCCESS", "FAILED"], null, "FAILED"],
  ["BLOCKED aggregates to FAILED", ["SUCCESS", "BLOCKED"], null, "FAILED"],
  [
    "CANCELLED when no higher priority exists",
    ["SUCCESS", "CANCELLED"],
    null,
    "CANCELLED",
  ],
  ["all SUCCESS", ["SUCCESS", "SUCCESS"], null, "SUCCESS"],
  ["WAITING before start", ["WAITING"], null, "CREATED"],
  ["WAITING after start", ["WAITING"], "2026-08-30T00:00:00Z", "RUNNING"],
  ["reserved SKIPPED before start", ["SKIPPED"], null, "CREATED"],
  [
    "reserved SKIPPED after start",
    ["SKIPPED"],
    "2026-08-30T00:00:00Z",
    "RUNNING",
  ],
  ["empty set before start boundary", [], null, "CREATED"],
  ["empty set after start boundary", [], "2026-08-30T00:00:00Z", "RUNNING"],
];

for (const [name, states, startedAt, expected] of cases) {
  test(`仕様§10: ${name}`, () => {
    assert.equal(computeRunAggregateStatus(states, startedAt), expected);
  });
}
