import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertDistinctProcessCwds,
  childEnvironment,
  createM5Timing,
  describeRunIdentity,
  matchesE2ECleanupPrefix,
  m5ConfirmedBy,
  requireM5Environment,
  resolveKsqlFlowCliPath,
  resolveProcessTreeRootId,
} from "../e2e/support.mjs";

test("E2E cleanup matches business and network prefixes in JavaScript", () => {
  const record = (businessKey, networkId) => ({
    business_key: { value: businessKey },
    network_id: { value: networkId },
  });

  assert.equal(
    matchesE2ECleanupPrefix(record("scope_suffix", "network"), "scope"),
    true,
  );
  assert.equal(
    matchesE2ECleanupPrefix(record("business", "scope_suffix"), "scope"),
    true,
  );
  assert.equal(
    matchesE2ECleanupPrefix(record("business_scope", "network"), "scope"),
    false,
  );
  assert.equal(matchesE2ECleanupPrefix({}, "scope"), false);
});

test("M5 run identity fixes all R1 inputs and exposes the generated key", () => {
  const first = describeRunIdentity("e2e", "network-one", "business-one");
  const second = describeRunIdentity("e2e", "network-one", "business-one");
  assert.deepEqual(second, first);
  assert.match(first.r1Key, /^R1:[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(
    describeRunIdentity("other", "network-one", "business-one").r1Key,
    first.r1Key,
  );
});

function e2eEnvironment(overrides = {}) {
  return {
    KSQL_SPIKE_BASE_URL: "https://example.cybozu.com",
    KSQL_SPIKE_APP_EXEC: "4257",
    KSQL_SPIKE_APP_AUDIT: "4258",
    KSQL_SPIKE_TOKEN_EXEC: "state-token",
    KSQL_SPIKE_TOKEN_AUDIT: "audit-token",
    KSQL_E2E_LOG_APP_ID: "4264",
    KSQL_E2E_TOKEN_LOGS: "write-token",
    KSQL_E2E_TOKEN_LOGS_RO: "read-token",
    KSQL_FLOW_BIN: "node.exe",
    ...overrides,
  };
}

test("M5 environment defaults to the isolated E2E profile and log app", () => {
  const settings = requireM5Environment(e2eEnvironment());
  assert.equal(settings.profile, "e2e");
  assert.equal(settings.jobLogAppId, 4264);
  assert.equal(settings.jobLogWriteToken, "write-token");
  assert.equal(settings.jobLogReadToken, "read-token");

  const child = childEnvironment(settings);
  assert.equal(child.KSQL_FLOWNET_PROFILE, "e2e");
  assert.equal(child.KSQL_FLOW_LOG_APP_ID, "4264");
  assert.equal(child.KSQL_FLOW_LOG_API_TOKEN, "read-token");
  assert.equal(child.KSQL_E2E_TOKEN_LOGS, "write-token");
});

test("M5 environment rejects production log and profile settings", () => {
  assert.throws(
    () => requireM5Environment(e2eEnvironment({ KSQL_E2E_LOG_APP_ID: "4249" })),
    /E2Eは本番ログアプリ4249を使用できません/u,
  );
  assert.throws(
    () =>
      requireM5Environment(e2eEnvironment({ KSQL_FLOWNET_PROFILE: "prod" })),
    /E2Eはprodプロファイルを使用できません/u,
  );
});

test("M5 environment requires isolated E2E log variables", () => {
  for (const name of [
    "KSQL_E2E_LOG_APP_ID",
    "KSQL_E2E_TOKEN_LOGS",
    "KSQL_E2E_TOKEN_LOGS_RO",
  ]) {
    const environment = e2eEnvironment();
    delete environment[name];
    assert.throws(
      () => requireM5Environment(environment),
      new RegExp(name, "u"),
    );
  }
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
  // OS に依存しない絶対パス(Windows では C:\..., Linux では /...)
  const cliPath = resolve(
    "/",
    "Users",
    "tester",
    "ksql-flow",
    "dist",
    "cli.js",
  );
  assert.equal(resolveKsqlFlowCliPath([cliPath, "--trace-warnings"]), cliPath);
  assert.throws(
    () =>
      resolveKsqlFlowCliPath([
        resolve("/", "work", "ksql-flownet", "dist", "cli", "index.js"),
      ]),
    /matches=\[\]/u,
  );
});

test("kill target treats Nodist parent and real node as one process tree", () => {
  assert.equal(
    resolveProcessTreeRootId([
      { processId: 100, parentProcessId: 50 },
      { processId: 101, parentProcessId: 100 },
    ]),
    100,
  );
  assert.equal(
    resolveProcessTreeRootId([{ processId: 101, parentProcessId: 100 }]),
    101,
  );
  assert.throws(
    () =>
      resolveProcessTreeRootId([
        { processId: 100, parentProcessId: 50 },
        { processId: 101, parentProcessId: 51 },
      ]),
    /found 2 roots/u,
  );
});
