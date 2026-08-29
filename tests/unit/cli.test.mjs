import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = fileURLToPath(
  new URL("../../dist/cli/index.js", import.meta.url),
);

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("--version prints the package.json version", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const result = runCli("--version");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${packageJson.version}\n`);
});

test("--help follows the CLI help contract", () => {
  const result = runCli("--help");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `Usage: ksql-flownet [options] [command]

kSQL-FlowNet Control Plane CLI

Options:
  -h, --help       display help for command
  -V, --version    display version

Commands:
  validate <network>  validate a network definition and its SQL files
  plan <network>      not implemented (FN-03)
`,
  );
});

test("plan fails explicitly until FN-03", () => {
  const result = runCli("plan", "network.yaml");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plan is not implemented \(FN-03\)/);
});

test("validate checks the definition and readable SQL files", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ksql-flownet-cli-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "jobs"));
  writeFileSync(join(directory, "jobs", "one.sql"), "SELECT 1;\n");
  writeFileSync(
    join(directory, "network.yaml"),
    `schema_version: 1
network_id: cli_test
business_key_policy:
  type: explicit
network_lock:
  lease_duration_sec: 3
  heartbeat_interval_sec: 1
nodes:
  - id: one
    job_id: job_one
    sql: jobs/one.sql
    depends_on: []
    trigger_rule: all_success
    idempotent: true
`,
  );

  const valid = runCli("validate", join(directory, "network.yaml"));
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Valid network definition/);

  writeFileSync(
    join(directory, "network.yaml"),
    readFileSync(join(directory, "network.yaml"), "utf8")
      .replace("jobs/one.sql", "jobs/missing.sql")
      .replace("trigger_rule: all_success", "trigger_rule: none_failed"),
  );
  const invalid = runCli("validate", join(directory, "network.yaml"));
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /reserved and not supported in Phase 1/);
  assert.match(invalid.stderr, /SQL file.*not readable/);
});

test("validate lists all schema errors", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ksql-flownet-errors-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, "network.yaml"),
    `schema_version: 2
network_id: bad
unknown: true
`,
  );

  const result = runCli("validate", join(directory, "network.yaml"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schema_version/);
  assert.match(result.stderr, /unknown property 'unknown'/);
  assert.match(result.stderr, /business_key_policy/);
  assert.match(result.stderr, /network_lock/);
  assert.match(result.stderr, /nodes/);
});
