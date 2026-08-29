import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

function createPlanFixture(context, policyYaml) {
  const directory = mkdtempSync(join(tmpdir(), "ksql-flownet-plan-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "jobs"));
  writeFileSync(join(directory, "jobs", "first.sql"), "SELECT 1;\n");
  writeFileSync(join(directory, "jobs", "second.sql"), "SELECT 2;\n");
  writeFileSync(
    join(directory, "network.yaml"),
    `schema_version: 1
network_id: cli_plan
business_key_policy:
${policyYaml}
network_lock:
  lease_duration_sec: 3
  heartbeat_interval_sec: 1
nodes:
  - id: first
    job_id: job_first
    sql: jobs/first.sql
    depends_on: []
    trigger_rule: all_success
    idempotent: true
  - id: second
    job_id: job_second
    sql: jobs/second.sql
    depends_on: [first]
    trigger_rule: all_success
    idempotent: false
`,
  );
  return directory;
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
  plan <network> [--scheduled-for <timestamp>] [--business-key <key>]
                      display the business key and stable execution plan (read-only)
`,
  );
});

test("plan prints a generated business key and stable topological plan", (context) => {
  const directory = createPlanFixture(
    context,
    '  type: scheduled_period\n  period: month\n  timezone: Asia/Tokyo\n  format: "{network_id}@{yyyy}-{MM}"',
  );
  const result = runCli(
    "plan",
    join(directory, "network.yaml"),
    "--scheduled-for",
    "2026-12-31T15:00:00Z",
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `Business key: cli_plan@2027-01
Execution plan:
1. first | job_id=job_first | idempotent=true | depends_on=-
2. second | job_id=job_second | idempotent=false | depends_on=first
`,
  );
});

test("plan requires the policy-specific business key input", (context) => {
  const scheduledDirectory = createPlanFixture(
    context,
    '  type: scheduled_period\n  period: day\n  timezone: UTC\n  format: "{yyyy}-{MM}-{dd}"',
  );
  const scheduled = runCli("plan", join(scheduledDirectory, "network.yaml"));
  assert.equal(scheduled.status, 1);
  assert.match(scheduled.stderr, /SCHEDULED_FOR_REQUIRED/);
  assert.match(
    scheduled.stderr,
    /either --scheduled-for or --business-key is required/,
  );

  const explicitDirectory = createPlanFixture(context, "  type: explicit");
  const explicit = runCli("plan", join(explicitDirectory, "network.yaml"));
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /BUSINESS_KEY_REQUIRED/);
});

test("plan accepts an explicit key for a scheduled-period network", (context) => {
  const directory = createPlanFixture(
    context,
    '  type: scheduled_period\n  period: month\n  timezone: UTC\n  format: "{network_id}@{yyyy}-{MM}"',
  );
  const result = runCli(
    "plan",
    join(directory, "network.yaml"),
    "--business-key",
    "cli_plan@2026-08-correction",
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Business key: cli_plan@2026-08-correction$/m);
});

test("plan rejects both scheduled-period business key inputs", (context) => {
  const directory = createPlanFixture(
    context,
    '  type: scheduled_period\n  period: month\n  timezone: UTC\n  format: "{network_id}@{yyyy}-{MM}"',
  );
  const result = runCli(
    "plan",
    join(directory, "network.yaml"),
    "--scheduled-for",
    "2026-08-01T00:00:00Z",
    "--business-key",
    "cli_plan@2026-08-correction",
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /BUSINESS_KEY_INPUT_CONFLICT/);
});

test("plan with an explicit key preserves it and remains read-only", (context) => {
  const directory = createPlanFixture(context, "  type: explicit");
  const paths = [
    join(directory, "network.yaml"),
    join(directory, "jobs", "first.sql"),
    join(directory, "jobs", "second.sql"),
  ];
  const before = paths.map((path) => ({
    path,
    content: readFileSync(path, "utf8"),
    modified: statSync(path).mtimeMs,
  }));
  const entriesBefore = readdirSync(directory, { recursive: true }).sort();

  const result = runCli(
    "plan",
    join(directory, "network.yaml"),
    "--business-key",
    "cli_plan@correction-1",
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Business key: cli_plan@correction-1$/m);
  assert.deepEqual(
    readdirSync(directory, { recursive: true }).sort(),
    entriesBefore,
  );
  for (const expected of before) {
    assert.equal(readFileSync(expected.path, "utf8"), expected.content);
    assert.equal(statSync(expected.path).mtimeMs, expected.modified);
  }
});

test("plan enumerates definition and SQL validation errors", (context) => {
  const directory = createPlanFixture(
    context,
    '  type: scheduled_period\n  period: month\n  timezone: UTC\n  format: "{yyyy}-{MM}-{dd}"',
  );
  rmSync(join(directory, "jobs", "second.sql"));

  const result = runCli(
    "plan",
    join(directory, "network.yaml"),
    "--scheduled-for",
    "2026-01-01T00:00:00Z",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FORMAT_PERIOD_MISMATCH/);
  assert.match(result.stderr, /SQL_FILE_UNREADABLE/);
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
