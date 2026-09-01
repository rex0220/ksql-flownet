import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_REQUEST_HEARTBEAT_INTERVAL_MS,
  DEFAULT_REQUEST_STALE_AFTER_MS,
  definitionPathForNetwork,
  KINTONE_DATETIME_PRECISION_ALLOWANCE_MS,
  loadPollRequestsConfig,
  PollRequestsConfigError,
} from "../../dist/requests/poll-requests-config.js";

const fixture = resolve("tests/e2e/fixtures/network-success.yaml");

function allowlist(source) {
  const directory = mkdtempSync(join(tmpdir(), "flownet-request-config-"));
  const path = join(directory, "allowlist.yaml");
  writeFileSync(path, source, "utf8");
  return path;
}

const valid = () =>
  allowlist(
    `networks:\n  - network_id: m5_success\n    definition_path: ${JSON.stringify(fixture)}\n`,
  );

test("allowlistを読み込みnetwork_idから絶対定義pathを引ける", () => {
  const config = loadPollRequestsConfig(valid());
  assert.equal(config.networks.length, 1);
  assert.equal(definitionPathForNetwork(config, "m5_success"), fixture);
});

test("heartbeat/stale/分精度余裕の既定値を固定する", () => {
  const config = loadPollRequestsConfig(valid());
  assert.equal(
    config.heartbeatIntervalMs,
    DEFAULT_REQUEST_HEARTBEAT_INTERVAL_MS,
  );
  assert.equal(config.staleAfterMs, DEFAULT_REQUEST_STALE_AFTER_MS);
  assert.equal(
    config.stalePrecisionAllowanceMs,
    KINTONE_DATETIME_PRECISION_ALLOWANCE_MS,
  );
  assert.equal(config.staleAfterMs, 15 * 60_000);
  assert.equal(config.stalePrecisionAllowanceMs, 60_000);
});

test("heartbeat/stale閾値のoverrideを検証する", () => {
  const config = loadPollRequestsConfig(valid(), {
    heartbeatIntervalMs: 30_000,
    staleAfterMs: 600_000,
  });
  assert.equal(config.heartbeatIntervalMs, 30_000);
  assert.equal(config.staleAfterMs, 600_000);
  assert.throws(
    () =>
      loadPollRequestsConfig(valid(), {
        heartbeatIntervalMs: 60_000,
        staleAfterMs: 60_000,
      }),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "THRESHOLD_INVALID",
  );
});

test("重複network_idを拒否する", () => {
  const path = allowlist(
    `networks:\n  - network_id: m5_success\n    definition_path: ${JSON.stringify(fixture)}\n  - network_id: m5_success\n    definition_path: ${JSON.stringify(fixture)}\n`,
  );
  assert.throws(
    () => loadPollRequestsConfig(path),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "DUPLICATE_NETWORK",
  );
});

test("相対allowlist pathと相対definition pathを拒否する", () => {
  assert.throws(
    () => loadPollRequestsConfig("allowlist.yaml"),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "ALLOWLIST_PATH_NOT_ABSOLUTE",
  );
  const path = allowlist(
    "networks:\n  - network_id: m5_success\n    definition_path: ./network.yaml\n",
  );
  assert.throws(
    () => loadPollRequestsConfig(path),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "DEFINITION_PATH_NOT_ABSOLUTE",
  );
});

test("不存在/不正definitionとnetwork_id不一致を拒否する", () => {
  const missing = allowlist(
    `networks:\n  - network_id: missing\n    definition_path: ${JSON.stringify(resolve("does-not-exist.yaml"))}\n`,
  );
  assert.throws(
    () => loadPollRequestsConfig(missing),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "NETWORK_DEFINITION_INVALID",
  );
  const mismatch = allowlist(
    `networks:\n  - network_id: different\n    definition_path: ${JSON.stringify(fixture)}\n`,
  );
  assert.throws(
    () => loadPollRequestsConfig(mismatch),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "NETWORK_ID_MISMATCH",
  );
});

test("preflightは参照SQLが不在のnetwork定義を拒否する", () => {
  const directory = mkdtempSync(join(tmpdir(), "flownet-request-network-"));
  const networkPath = join(directory, "network.yaml");
  writeFileSync(
    networkPath,
    `schema_version: 1
network_id: missing_sql
business_key_policy:
  type: explicit
network_lock:
  lease_duration_sec: 3
  heartbeat_interval_sec: 1
nodes:
  - id: one
    job_id: one
    sql: missing.sql
    depends_on: []
    trigger_rule: all_success
    idempotent: true
`,
    "utf8",
  );
  const path = allowlist(
    `networks:\n  - network_id: missing_sql\n    definition_path: ${JSON.stringify(networkPath)}\n`,
  );
  assert.throws(
    () => loadPollRequestsConfig(path),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "NETWORK_DEFINITION_INVALID",
  );
});

test("allowlist外networkをfail-closedにする", () => {
  const config = loadPollRequestsConfig(valid());
  assert.throws(
    () => definitionPathForNetwork(config, "not-allowed"),
    (error) =>
      error instanceof PollRequestsConfigError &&
      error.code === "NETWORK_NOT_ALLOWED",
  );
});
