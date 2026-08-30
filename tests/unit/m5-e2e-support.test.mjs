import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDistinctProcessCwds,
  createM5Timing,
  describeRunIdentity,
  m5ConfirmedBy,
  resolveKsqlFlowCliPath,
} from "../e2e/support.mjs";

test("M5 run identity fixes all R1 inputs and exposes the generated key", () => {
  const first = describeRunIdentity("prod", "network-one", "business-one");
  const second = describeRunIdentity("prod", "network-one", "business-one");
  assert.deepEqual(second, first);
  assert.match(first.r1Key, /^R1:[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(
    describeRunIdentity("other", "network-one", "business-one").r1Key,
    first.r1Key,
  );
});

test("M5 timing records ISO events and measured milliseconds", () => {
  const dates = [
    new Date("2026-08-30T00:00:00.000Z"),
    new Date("2026-08-30T00:00:01.250Z"),
  ];
  const timing = createM5Timing(() => dates.shift());
  timing.mark("startedAt");
  timing.mark("finishedAt");
  timing.measure("elapsedMs", "startedAt", "finishedAt");
  assert.deepEqual(timing.snapshot(), {
    events: {
      startedAt: "2026-08-30T00:00:00.000Z",
      finishedAt: "2026-08-30T00:00:01.250Z",
    },
    intervalsMs: { elapsedMs: 1250 },
  });
});

test("M5 lock conflict rejects an identical standalone cwd", () => {
  assert.throws(
    () => assertDistinctProcessCwds("C:\\work\\flownet", "C:\\work\\flownet"),
    /異なるcwd/u,
  );
});

test("M5 lock conflict accepts distinct process cwd values", () => {
  assert.doesNotThrow(() =>
    assertDistinctProcessCwds(
      "C:\\work\\flownet",
      "C:\\work\\flownet-e2e-standalone",
    ),
  );
});

test("kill cleanup confirmed-by accepts argument then environment", () => {
  assert.equal(
    m5ConfirmedBy({ M5_FORCE_UNLOCK_CONFIRMED_BY: "environment-user" }, [
      "--confirmed-by",
      "argument-user",
    ]),
    "argument-user",
  );
  assert.equal(
    m5ConfirmedBy({ M5_FORCE_UNLOCK_CONFIRMED_BY: "environment-user" }, []),
    "environment-user",
  );
  assert.throws(() => m5ConfirmedBy({}, []), /confirmed-by/u);
});

test("kill target resolves only the kSQL-Flow dist cli script", () => {
  assert.equal(
    resolveKsqlFlowCliPath([
      "C:\\Users\\tester\\Projects\\ksql-flow\\dist\\cli.js",
      "--trace-warnings",
    ]),
    "C:\\Users\\tester\\Projects\\ksql-flow\\dist\\cli.js",
  );
  assert.throws(
    () =>
      resolveKsqlFlowCliPath(["C:\\work\\ksql-flownet\\dist\\cli\\index.js"]),
    /matches=\[\]/u,
  );
});
