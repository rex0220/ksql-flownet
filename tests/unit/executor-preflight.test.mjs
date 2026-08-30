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
const nondeterministicInspection = () => fixture("inspect-job-ksql1306");

function node(overrides = {}) {
  return {
    id: "aggregate",
    job_id: "m5_shared_read",
    sql: "jobs/success-n1-extract.sql",
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
    command: "node.exe",
    binArgs: ["C:/tools/ksql flow/dist/cli.js"],
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
  const inspected = await cli.inspectJob(
    "snapshot/jobs/success-n1-extract.sql",
  );
  assert.equal(inspected.kind, "JOB_INSPECTION");
  assert.equal(inspected.fileName, "success-n1-extract.sql");
  assert.equal(inspected.statementCount, 2);
  assert.deepEqual(calls, [
    {
      command: "node.exe",
      args: ["C:/tools/ksql flow/dist/cli.js", "capabilities", "--json"],
    },
    {
      command: "node.exe",
      args: [
        "C:/tools/ksql flow/dist/cli.js",
        "describe-profile",
        "--profile",
        "prod",
        "--config",
        "C:/secure/ksql.config.json",
        "--json",
      ],
    },
    {
      command: "node.exe",
      args: [
        "C:/tools/ksql flow/dist/cli.js",
        "inspect-job",
        "-f",
        "snapshot/jobs/success-n1-extract.sql",
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

test("describe-profile accepts null limits and additive output fields", async () => {
  const value = profile();
  value.limits.batchTimeoutSec = null;
  value.futureField = { enabled: true };
  value.retry.futureRetryField = "additive";
  const cli = new KsqlFlowCli({
    command: "fake",
    profile: "prod",
    configPath: "config.json",
    spawn: async () => ({
      exitCode: 0,
      stdout: JSON.stringify(value),
      stderr: "",
    }),
  });

  assert.deepEqual((await cli.describeProfile()).limits, {
    batchTimeoutSec: null,
    maxApiCalls: null,
    maxReadRows: null,
    maxTempRows: null,
  });
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
      respectRetryAfter: true,
      maxDelayMs: 60000,
      maxAttempts: 5,
      initialDelayMs: 1000,
    },
    profile: left.profile,
    logApp: { name: "実行ログ", appId: 4249 },
    limits: {
      maxTempRows: null,
      maxReadRows: null,
      maxApiCalls: null,
      batchTimeoutSec: 3600,
    },
    kind: left.kind,
    httpTimeoutMs: left.httpTimeoutMs,
    guestSpaceId: left.guestSpaceId,
    formatVersion: left.formatVersion,
    baseUrl: left.baseUrl,
    apps: { 顧客管理: 4246, 案件管理: 4247, 実行ログ: 4249 },
  };
  assert.equal(canonicalJson(right), canonicalJson(left));
  assert.equal(canonicalJsonSha256(right), canonicalJsonSha256(left));
  assert.match(canonicalJson(left), /"maxApiCalls":null/);
  assert.notEqual(
    canonicalJsonSha256(left),
    canonicalJsonSha256({
      ...left,
      limits: { ...left.limits, maxApiCalls: 0 },
    }),
  );
});

test("profile snapshot detects hash, URL, guest space, app IDs, and timezone mismatches", () => {
  const value = profile();
  const snapshot = profileSnapshot(value);
  assert.doesNotThrow(() => assertProfileSnapshot(value, snapshot));

  const mutations = [
    { canonicalJsonSha256: "0".repeat(64) },
    { baseUrl: "https://other.cybozu.com" },
    { guestSpaceId: 99 },
    { apps: { ...snapshot.apps, 顧客管理: 4248 } },
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
  const inspected = nondeterministicInspection();
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
    new Map([["aggregate", nondeterministicInspection()]]),
    [approved],
  );
  assert.deepEqual(result[0].nondeterministicCodes, ["KSQL1306"]);
  assert.deepEqual(result[0].approvedExceptions, [approved]);

  const warningOnly = nondeterministicInspection();
  warningOnly.diagnostics = [
    {
      code: "KSQL1305",
      severity: "warning",
      line: 1,
      column: 1,
      message: "plain INSERT may not be idempotent",
    },
  ];
  warningOnly.nondeterministicElements = [];
  assert.doesNotThrow(() =>
    validateJobInspections([node()], new Map([["aggregate", warningOnly]])),
  );
});

test("exception for an undetected code is rejected as over-approval", () => {
  const inspected = nondeterministicInspection();
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
