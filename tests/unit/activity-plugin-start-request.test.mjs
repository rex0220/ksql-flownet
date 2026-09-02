import assert from "node:assert/strict";
import test from "node:test";

import {
  guardPendingStartRequest,
  loadStartCandidates,
} from "../../dist/plugin/request-client.js";
import {
  aggregateStartCandidates,
  matchesStartGuard,
  normalizeJstDatetimeLocal,
  normalizeStartFormInput,
  START_CANDIDATE_LIMIT,
  startGuardKey,
} from "../../dist/plugin/start-request.js";

const field = (value) => ({ value });
const startRecord = (id, overrides = {}) => ({
  $id: field(String(id)),
  request_type: field("START"),
  request_state: field("REQUESTED"),
  network_id: field("monthly"),
  business_key: field("monthly@2026-08-correction-1"),
  scheduled_for: field("2026-08-31T15:00:00Z"),
  ...overrides,
});

test("3 modes normalize datetime-local as +09:00 and enforce their required keys", () => {
  assert.equal(
    normalizeJstDatetimeLocal("2026-09-01T00:00"),
    "2026-08-31T15:00:00Z",
  );
  assert.throws(() => normalizeJstDatetimeLocal("2026-09-01"), /日時まで/u);
  assert.throws(
    () => normalizeJstDatetimeLocal("2026-02-30T00:00"),
    /実在する日時/u,
  );

  const scheduled = normalizeStartFormInput({
    mode: "scheduled",
    networkId: " monthly ",
    businessKey: "",
    scheduledForLocal: "2026-09-01T00:00",
    reason: " period run ",
  });
  assert.deepEqual(scheduled, {
    mode: "scheduled",
    networkId: "monthly",
    businessKey: null,
    scheduledFor: "2026-08-31T15:00:00Z",
    reason: "period run",
  });
  const correction = normalizeStartFormInput({
    mode: "correction",
    networkId: "monthly",
    businessKey: "monthly@2026-08-correction-1",
    scheduledForLocal: "2026-09-01T00:00",
    reason: "correction",
  });
  assert.ok(correction.businessKey);
  assert.ok(correction.scheduledFor);
  const explicit = normalizeStartFormInput({
    mode: "explicit",
    networkId: "adhoc",
    businessKey: "ticket-123",
    scheduledForLocal: "",
    reason: "manual",
  });
  assert.equal(explicit.scheduledFor, null);
  assert.throws(
    () =>
      normalizeStartFormInput({
        mode: "correction",
        networkId: "monthly",
        businessKey: "",
        scheduledForLocal: "2026-09-01T00:00",
        reason: "correction",
      }),
    /business_key/u,
  );
});

test("correction guard uses all three AND terms and strictly filters token matches", async () => {
  const normalized = normalizeStartFormInput({
    mode: "correction",
    networkId: "monthly",
    businessKey: "monthly@2026-08-correction-1",
    scheduledForLocal: "2026-09-01T00:00",
    reason: "correction",
  });
  let query = "";
  const result = await guardPendingStartRequest(
    async (request) => {
      query = request.query;
      return {
        records: [
          startRecord(1, {
            business_key: field("monthly@2026-08"),
          }),
          startRecord(2),
        ],
      };
    },
    300,
    startGuardKey(normalized),
  );
  assert.match(query, /network_id = "monthly"/u);
  assert.match(query, /business_key = "monthly@2026-08-correction-1"/u);
  assert.match(query, /scheduled_for = "2026-08-31T15:00:00Z"/u);
  assert.equal((query.match(/ and /gu) ?? []).length >= 4, true);
  assert.deepEqual(result, { state: "ready", matchingIds: ["2"] });

  assert.equal(
    matchesStartGuard(
      {
        networkId: "monthly",
        businessKey: "monthly@2026-08-correction-2",
        scheduledFor: normalized.scheduledFor,
      },
      startGuardKey(normalized),
    ),
    false,
    "same period with another correction key must not be blocked",
  );
});

test("explicit and scheduled guards query only their mode key", async () => {
  for (const [mode, input, expected, absent] of [
    [
      "explicit",
      {
        networkId: "adhoc",
        businessKey: "ticket-1",
        scheduledForLocal: "",
      },
      "business_key",
      "scheduled_for =",
    ],
    [
      "scheduled",
      {
        networkId: "monthly",
        businessKey: "",
        scheduledForLocal: "2026-09-01T00:00",
      },
      "scheduled_for",
      "business_key =",
    ],
  ]) {
    const normalized = normalizeStartFormInput({
      mode,
      ...input,
      reason: "reason",
    });
    let query = "";
    await guardPendingStartRequest(
      async (request) => {
        query = request.query;
        return { records: [] };
      },
      300,
      startGuardKey(normalized),
    );
    assert.match(query, new RegExp(`${expected} =`, "u"));
    assert.doesNotMatch(query, new RegExp(absent, "u"));
  }
});

test("candidate groups deduplicate, page to the 500 cap, note only at cap, and fail independently", async () => {
  const short = aggregateStartCandidates("Run実績", [
    { networkId: "n", businessKey: "b", scheduledFor: null },
    { networkId: "n", businessKey: "b", scheduledFor: null },
  ]);
  assert.equal(short.items.length, 1);
  assert.equal(short.note, null);

  let requestCalls = 0;
  const loaded = await loadStartCandidates(
    async (request) => {
      if (request.app === 100) throw new Error("state app unavailable");
      requestCalls += 1;
      const start = Number(/\$id > (\d+)/u.exec(request.query)?.[1] ?? 0) + 1;
      return {
        records: Array.from({ length: 100 }, (_, index) =>
          startRecord(start + index, {
            request_state: field("DONE"),
            business_key: field(`key-${start + index}`),
          }),
        ),
      };
    },
    300,
    100,
  );
  assert.equal(requestCalls, 5);
  assert.equal(loaded.requestHistory.items.length, START_CANDIDATE_LIMIT);
  assert.match(loaded.requestHistory.note, /取得上限500件/u);
  assert.equal(loaded.runHistory.state, "unavailable");
  assert.equal(loaded.runHistory.note, null);
});

test("normalizeJstDatetimeLocal emits kintone-canonical second precision", () => {
  assert.equal(
    normalizeJstDatetimeLocal("2026-09-01T00:00"),
    "2026-08-31T15:00:00Z",
  );
  assert.doesNotMatch(normalizeJstDatetimeLocal("2026-09-01T00:00"), /\.\d{3}Z/u);
});

test("matchesStartGuard tolerates millisecond representation drift in scheduled_for", () => {
  const key = {
    mode: "scheduled",
    networkId: "net-a",
    businessKey: null,
    scheduledFor: "2026-08-31T15:00:00Z",
  };
  assert.equal(
    matchesStartGuard(
      { networkId: "net-a", businessKey: null, scheduledFor: "2026-08-31T15:00:00.000Z" },
      key,
    ),
    true,
  );
  assert.equal(
    matchesStartGuard(
      { networkId: "net-a", businessKey: null, scheduledFor: "2026-08-31T15:01:00Z" },
      key,
    ),
    false,
  );
});
