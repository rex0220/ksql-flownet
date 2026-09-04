import assert from "node:assert/strict";
import test from "node:test";

import { RunSubprocess } from "../../dist/executor/run-subprocess.js";

const request = {
  sqlPath: "C:\\bundle\\jobs\\a.sql",
  profile: "prod",
  configPath: "C:\\secure\\ksql.config.json",
  asOf: "2026-08-01T00:00:00+09:00",
  correlationId: "run_1",
  attemptId: "attempt:1",
  expectedJobId: "job_a",
};

test("contract引数とattempt由来の決定的metadata pathをspawnへ渡しstdout/stderrを保持する", async () => {
  const calls = [];
  const runner = new RunSubprocess({
    command: "ksql-flow",
    binArgs: ["C:\\Program Files\\ksql-flow\\dist\\cli.js"],
    executionDirectory: "C:\\exec",
    timeoutMs: 100,
    gracePeriodMs: 10,
    spawn: (call) => {
      calls.push(call);
      call.onStdout("human output");
      call.onStderr("diagnostic");
      return {
        completion: Promise.resolve({ exitCode: 0 }),
        gracefulStop() {},
        forceStop() {},
      };
    },
  });
  const outcome = await runner.run(request);
  assert.equal(outcome.resultJsonPath, "C:\\exec\\metadata\\attempt_1.json");
  assert.equal(outcome.stdout, "human output");
  assert.equal(outcome.stderr, "diagnostic");
  assert.deepEqual(calls[0].args, [
    "C:\\Program Files\\ksql-flow\\dist\\cli.js",
    "run",
    "-f",
    request.sqlPath,
    "--profile",
    "prod",
    "--config",
    request.configPath,
    "--as-of",
    request.asOf,
    "--result-json",
    outcome.resultJsonPath,
    "--correlation-id",
    "run_1",
    "--attempt-id",
    "attempt:1",
    "--expected-job-id",
    "job_a",
  ]);
});

test("timeoutMs nullは外側のbatch timeoutを無効にする", async () => {
  let stopped = false;
  const runner = new RunSubprocess({
    command: "fake",
    executionDirectory: "C:\\exec",
    timeoutMs: null,
    gracePeriodMs: 1,
    uniqueId: () => "no-timeout",
    spawn: () => ({
      completion: Promise.resolve({ exitCode: 0 }),
      gracefulStop() {
        stopped = true;
      },
      forceStop() {
        stopped = true;
      },
    }),
  });
  const outcome = await runner.run(request);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
  assert.equal(stopped, false);
});

test("CSV inputsをsource名順のimport/hashペアとしてargvへ渡す", async () => {
  const calls = [];
  const runner = new RunSubprocess({
    command: "ksql-flow",
    executionDirectory: "C:\\exec",
    timeoutMs: null,
    gracePeriodMs: 1,
    uniqueId: () => "imports",
    spawn: (call) => {
      calls.push(call);
      return {
        completion: Promise.resolve({ exitCode: 0 }),
        gracefulStop() {},
        forceStop() {},
      };
    },
  });
  await runner.run({
    ...request,
    imports: [
      {
        name: "zeta",
        path: "C:\\io\\in\\z.csv",
        sha256: "b".repeat(64),
        bytes: 20,
      },
      {
        name: "alpha",
        path: "C:\\io\\in\\a.csv",
        sha256: "a".repeat(64),
        bytes: 10,
      },
    ],
  });
  assert.deepEqual(calls[0].args.slice(-8), [
    "--import-csv",
    "alpha=C:\\io\\in\\a.csv",
    "--expected-import-sha256",
    `alpha=${"a".repeat(64)}`,
    "--import-csv",
    "zeta=C:\\io\\in\\z.csv",
    "--expected-import-sha256",
    `zeta=${"b".repeat(64)}`,
  ]);
});

test("timeoutはgraceful signal後のCANCELLED終了を待つ", async () => {
  let graceful = 0;
  let finish;
  const completion = new Promise((resolve) => (finish = resolve));
  const runner = new RunSubprocess({
    command: "fake",
    executionDirectory: "C:\\exec",
    timeoutMs: 1,
    gracePeriodMs: 50,
    uniqueId: () => "graceful",
    spawn: () => ({
      completion,
      gracefulStop() {
        graceful += 1;
        finish({ exitCode: 3 });
      },
      forceStop() {},
    }),
  });
  const outcome = await runner.run(request);
  assert.equal(graceful, 1);
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.forced, false);
  assert.equal(outcome.timedOut, true);
});

test("grace超過はforced killし、停止結果不明を保持する", async () => {
  let forced = 0;
  const runner = new RunSubprocess({
    command: "fake",
    executionDirectory: "C:\\exec",
    timeoutMs: 1,
    gracePeriodMs: 1,
    forcedExitWaitMs: 1,
    uniqueId: () => "forced",
    spawn: () => ({
      completion: new Promise(() => {}),
      gracefulStop() {},
      forceStop() {
        forced += 1;
      },
    }),
  });
  const outcome = await runner.run(request);
  assert.equal(forced, 1);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.forced, true);
});

test("spawn同期失敗をSQL未起動の確定証拠として返す", async () => {
  const runner = new RunSubprocess({
    command: "missing",
    executionDirectory: "C:\\exec",
    timeoutMs: 1,
    gracePeriodMs: 1,
    spawn: () => {
      throw new Error("ENOENT");
    },
  });
  const outcome = await runner.run(request);
  assert.equal(outcome.launchFailureConfirmed, true);
  assert.match(outcome.stderr, /ENOENT/);
});

test("相関ID・attempt ID・expected job IDをspawn前に検証する", async () => {
  let spawnCalls = 0;
  const runner = new RunSubprocess({
    command: "fake",
    executionDirectory: "C:\\exec",
    timeoutMs: 1,
    gracePeriodMs: 1,
    spawn: () => {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });
  for (const field of ["correlationId", "attemptId", "expectedJobId"])
    await assert.rejects(
      runner.run({ ...request, [field]: "unsafe id" }),
      /A-Za-z0-9/,
    );
  assert.equal(spawnCalls, 0);
});
