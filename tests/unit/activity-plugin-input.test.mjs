import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleActivityInputs,
  parseCancelRecord,
  parseCancelRecords,
  parseInvocationRecord,
  parseLockRecord,
  parseRunRecord,
} from "../../dist/plugin/activity-input.js";
import { deriveRunActivity } from "../../dist/orchestration/run-activity.js";

const T0 = "2026-09-01T00:00:00.000Z";
const field = (value) => ({ value });

function runRecord(overrides = {}) {
  return {
    $id: field("10"),
    record_type: field("NETWORK_RUN"),
    run_id: field("run_1"),
    status: field("RUNNING"),
    started_at: field(T0),
    ...overrides,
  };
}

function lockRecord(overrides = {}) {
  return {
    $id: field("20"),
    record_type: field("NETWORK_LOCK"),
    status: field("RUNNING"),
    owner_invocation_id: field("invoke_1"),
    status_reason: field("owner_instance_id=host-1"),
    heartbeat_at: field(T0),
    lease_expires_at: field("2026-09-01T00:00:30.000Z"),
    revision: field("2"),
    ...overrides,
  };
}

function invocationRecord(overrides = {}) {
  return {
    $id: field("30"),
    record_type: field("RUN_INVOCATION"),
    invocation_id: field("invoke_1"),
    run_id: field("run_1"),
    ...overrides,
  };
}

function cancelRecord(statusReason, overrides = {}) {
  return {
    $id: field("40"),
    record_type: field("CANCEL_REQUEST"),
    record_key: field("CANCEL:run_1"),
    run_id: field("run_1"),
    status_reason: field(statusReason),
    ...overrides,
  };
}

test("kintone field wrappers parse Run, active Lock, and owner Invocation", () => {
  assert.deepEqual(parseRunRecord(runRecord()), {
    runId: "run_1",
    status: "RUNNING",
    startedAt: T0,
  });
  assert.deepEqual(parseRunRecord(runRecord({ started_at: field("") })), {
    runId: "run_1",
    status: "RUNNING",
    startedAt: null,
  });
  assert.deepEqual(parseLockRecord(lockRecord()), {
    record_id: "20",
    owner_invocation_id: "invoke_1",
    owner_instance_id: "host-1",
    heartbeat_at: T0,
    lease_expires_at: "2026-09-01T00:00:30.000Z",
    revision: 2,
  });
  assert.deepEqual(parseInvocationRecord(invocationRecord()), {
    invocationId: "invoke_1",
    runId: "run_1",
  });
  assert.throws(() => parseRunRecord(runRecord({ status: field("BROKEN") })));
  assert.throws(() =>
    parseLockRecord(lockRecord({ lease_expires_at: field("not-a-date") })),
  );
  assert.throws(() =>
    parseInvocationRecord(invocationRecord({ invocation_id: field(1) })),
  );
});

test("CANCEL_REQUEST status_reason JSON is parsed fail-closed", async (t) => {
  assert.equal(
    parseCancelRecord(cancelRecord('{"state":"REQUESTED"}'), "run_1"),
    "REQUESTED",
  );
  for (const [name, record] of [
    ["broken JSON", cancelRecord("{")],
    ["array", cancelRecord("[]")],
    ["null", cancelRecord("null")],
    ["unknown state", cancelRecord('{"state":"PAUSED"}')],
    [
      "run mismatch",
      cancelRecord('{"state":"REQUESTED"}', { run_id: field("run_2") }),
    ],
    [
      "key mismatch",
      cancelRecord('{"state":"REQUESTED"}', {
        record_key: field("CANCEL:other"),
      }),
    ],
  ]) {
    await t.test(name, () => {
      assert.throws(() => parseCancelRecord(record, "run_1"));
    });
  }
  assert.throws(() =>
    parseCancelRecords(
      [
        cancelRecord('{"state":"REQUESTED"}'),
        cancelRecord('{"state":"ACCEPTED"}', { $id: field("41") }),
      ],
      new Set(["run_1"]),
    ),
  );
});

test("owner-only Invocation reduction preserves activity results", () => {
  const run = parseRunRecord(runRecord());
  const lock = parseLockRecord(lockRecord());
  const invocation = parseInvocationRecord(invocationRecord());
  const reduced = assembleActivityInputs({
    runs: [run],
    locks: [lock],
    ownerInvocations: [invocation],
    cancelStates: new Map(),
    nowMs: Date.parse(T0),
  }).get("run_1");
  assert.ok(reduced);
  const full = {
    ...reduced,
    invocationIds: ["old_1", invocation.invocationId, "old_2"],
  };
  assert.equal(deriveRunActivity(reduced), deriveRunActivity(full));
  assert.equal(deriveRunActivity(reduced), "LIVE");

  assert.throws(() =>
    assembleActivityInputs({
      runs: [run],
      locks: [lock, { ...lock, record_id: "21" }],
      ownerInvocations: [invocation],
      cancelStates: new Map(),
      nowMs: Date.parse(T0),
    }),
  );
  assert.throws(() =>
    assembleActivityInputs({
      runs: [run],
      locks: [lock],
      ownerInvocations: [],
      cancelStates: new Map(),
      nowMs: Date.parse(T0),
    }),
  );
});
