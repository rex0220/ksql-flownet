import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import {
  KsqlFlowCli,
  KsqlFlowCliError,
} from "../../dist/executor/ksql-flow-cli.js";
import {
  PreflightError,
  assertProfileSnapshot,
  canonicalJson,
  canonicalJsonSha256,
  profileSnapshot,
  validateCapabilities,
  validateJobInspections,
} from "../../dist/executor/preflight.js";

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/executor/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const capabilities = () => fixture("capabilities");
const profile = () => fixture("describe-profile");
const inspection = () => fixture("inspect-job");

function node(overrides = {}) {
  return {
    id: "aggregate",
    job_id: "aggregate_customer",
    sql: "jobs/aggregate_customer.sql",
    depends_on: [],
    trigger_rule: "all_success",
    idempotent: true,
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    node_id: "aggregate",
    code: "KSQL1306",
    approved_by: "release-owner@example.test",
    reason: "business date is fixed by the upstream snapshot",
    approved_at: "2026-08-30T01:02:03.000Z",
    ...overrides,
  };
}

test("CLI invoker injects command/profile/config and validates all M1 output kinds", async () => {
  const calls = [];
  const outputs = [capabilities(), profile(), inspection()];
  const cli = new KsqlFlowCli({
    command: "C:/tools/ksql-flow.cmd",
    profile: "prod",
    configPath: "C:/secure/ksql.config.json",
    spawn: async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: JSON.stringify(outputs.shift()),
        stderr: "",
      };
    },
  });

  assert.equal((await cli.capabilities()).kind, "CAPABILITIES");
  assert.equal((await cli.describeProfile()).kind, "PROFILE_DESCRIPTION");
  assert.equal(
    (await cli.inspectJob("snapshot/jobs/aggregate_customer.sql")).kind,
    "JOB_INSPECTION",
  );
  assert.deepEqual(calls, [
    {
      command: "C:/tools/ksql-flow.cmd",
      args: ["capabilities", "--json"],
    },
    {
      command: "C:/tools/ksql-flow.cmd",
      args: [
        "describe-profile",
        "--profile",
        "prod",
        "--config",
        "C:/secure/ksql.config.json",
        "--json",
      ],
    },
    {
      command: "C:/tools/ksql-flow.cmd",
      args: [
        "inspect-job",
        "-f",
        "snapshot/jobs/aggregate_customer.sql",
        "--profile",
        "prod",
        "--config",
        "C:/secure/ksql.config.json",
        "--json",
      ],
    },
  ]);
});

test("CLI invoker maps spawn, exit, JSON, and output-shape failures to stable codes", async () => {
  const cases = [
    [
      async () => Promise.reject(new Error("ENOENT")),
      "KSQL_FLOW_PROCESS_FAILED",
    ],
    [
      async () => ({ exitCode: null, stdout: "", stderr: "" }),
      "KSQL_FLOW_PROCESS_FAILED",
    ],
    [
      async () => ({ exitCode: 1, stdout: "", stderr: "bad args" }),
      "KSQL_FLOW_EXIT_MISMATCH",
    ],
    [
      async () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
      "KSQL_FLOW_INVALID_JSON",
    ],
    [
      async () => ({
        exitCode: 0,
        stdout: '{"formatVersion":1,"kind":"OTHER"}',
        stderr: "",
      }),
      "KSQL_FLOW_OUTPUT_INVALID",
    ],
  ];
  for (const [spawn, code] of cases) {
    const cli = new KsqlFlowCli({
      command: "fake",
      profile: "p",
      configPath: "c",
      spawn,
    });
    await assert.rejects(cli.capabilities(), (error) => {
      assert.ok(error instanceof KsqlFlowCliError);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test("capability preflight rejects a missing contract and every required false/missing feature", () => {
  const noContract = capabilities();
  noContract.executionContracts = [];
  assert.throws(
    () => validateCapabilities(noContract),
    (error) =>
      error instanceof PreflightError &&
      error.code === "CAPABILITY_CONTRACT_MISSING",
  );

  for (const feature of [
    "resultJson",
    "correlationIds",
    "describeProfile",
    "inspectJob",
    "durableExecutionStarted",
  ]) {
    for (const replacement of [false, undefined]) {
      const value = capabilities();
      if (replacement === undefined) delete value.features[feature];
      else value.features[feature] = replacement;
      assert.throws(
        () => validateCapabilities(value),
        (error) =>
          error instanceof PreflightError &&
          error.code === "CAPABILITY_FEATURE_MISSING" &&
          error.details.includes(feature),
      );
    }
  }
  assert.doesNotThrow(() => validateCapabilities(capabilities()));
});

test("canonical profile JSON/hash is deterministic for shuffled keys at every depth", () => {
  const left = profile();
  const right = {
    timezone: left.timezone,
    retry: {
      respectRetryAfter: false,
      maxDelayMs: 2500,
      maxAttempts: 7,
      initialDelayMs: 25,
    },
    profile: left.profile,
    logApp: { name: "execution_log", appId: 999 },
    limits: {
      maxTempRows: 987,
      maxReadRows: 654,
      maxApiCalls: 321,
      batchTimeoutSec: 1200,
    },
    kind: left.kind,
    httpTimeoutMs: left.httpTimeoutMs,
    guestSpaceId: left.guestSpaceId,
    formatVersion: left.formatVersion,
    baseUrl: left.baseUrl,
    apps: { execution_log: 999, orders: 101 },
  };
  assert.equal(canonicalJson(right), canonicalJson(left));
  assert.equal(canonicalJsonSha256(right), canonicalJsonSha256(left));
});

test("profile snapshot detects hash, URL, guest space, app IDs, and timezone mismatches", () => {
  const value = profile();
  const snapshot = profileSnapshot(value);
  assert.doesNotThrow(() => assertProfileSnapshot(value, snapshot));

  const mutations = [
    { canonicalJsonSha256: "0".repeat(64) },
    { baseUrl: "https://other.cybozu.com" },
    { guestSpaceId: 99 },
    { apps: { ...snapshot.apps, orders: 102 } },
    { timezone: "UTC" },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => assertProfileSnapshot(value, { ...snapshot, ...mutation }),
      (error) =>
        error instanceof PreflightError &&
        error.code === "PROFILE_SNAPSHOT_MISMATCH",
    );
  }
});

test("job inspection rejects jobId mismatch and unapproved KSQL1306 on idempotent nodes", () => {
  const inspected = inspection();
  assert.throws(
    () =>
      validateJobInspections(
        [node({ job_id: "different" })],
        new Map([["aggregate", inspected]]),
      ),
    (error) =>
      error instanceof PreflightError && error.code === "JOB_ID_MISMATCH",
  );
  assert.throws(
    () => validateJobInspections([node()], new Map([["aggregate", inspected]])),
    (error) =>
      error instanceof PreflightError &&
      error.code === "NONDETERMINISTIC_IDEMPOTENT_JOB",
  );
});

test("approved KSQL1306 passes and is fixed into inspection result while KSQL1305 is not nondeterministic", () => {
  const approved = approval();
  const result = validateJobInspections(
    [node()],
    new Map([["aggregate", inspection()]]),
    [approved],
  );
  assert.deepEqual(result[0].nondeterministicCodes, ["KSQL1306"]);
  assert.deepEqual(result[0].approvedExceptions, [approved]);

  const warningOnly = inspection();
  warningOnly.diagnostics = warningOnly.diagnostics.filter(
    (item) => item.code === "KSQL1305",
  );
  warningOnly.nondeterministicElements = [];
  assert.doesNotThrow(() =>
    validateJobInspections([node()], new Map([["aggregate", warningOnly]])),
  );
});

test("exception for an undetected code is rejected as over-approval", () => {
  const inspected = inspection();
  inspected.diagnostics = inspected.diagnostics.filter(
    (item) => item.code !== "KSQL1306",
  );
  inspected.nondeterministicElements = [];
  assert.throws(
    () =>
      validateJobInspections([node()], new Map([["aggregate", inspected]]), [
        approval(),
      ]),
    (error) =>
      error instanceof PreflightError &&
      error.code === "INSPECTION_EXCEPTION_NOT_DETECTED",
  );
});
