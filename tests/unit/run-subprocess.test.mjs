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

test("contract引数とattempt由来の一意result pathをspawnへ渡しstdout/stderrを保持する", async () => {
  const calls = [];
  const runner = new RunSubprocess({
    command: "ksql-flow",
    binArgs: ["C:\\Program Files\\ksql-flow\\dist\\cli.js"],
    executionDirectory: "C:\\exec",
    timeoutMs: 100,
    gracePeriodMs: 10,
    uniqueId: () => "unique-1",
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
  assert.equal(outcome.resultJsonPath, "C:\\exec\\attempt_1-unique-1.json");
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
