import assert from "node:assert/strict";
import test from "node:test";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import { AttemptExecutor } from "../../dist/executor/attempt-executor.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";

const executionInput = {
  sqlPath: "C:\\bundle\\jobs\\job.sql",
  profile: "prod",
  configPath: "C:\\secure\\config.json",
  asOf: "2026-08-01T00:00:00+09:00",
  correlationId: "run_1",
  attemptId: "attempt_1",
  expectedJobId: "job_1",
  executionStartedAt: "2026-08-30T00:00:00Z",
};

function executionResult(overrides = {}) {
  const status = overrides.status ?? "SUCCESS";
  const executionStarted = overrides.executionStarted ?? true;
  return {
    formatVersion: 1,
    kind: "EXECUTION_RESULT",
    contract: "ksql-flow.execution/v1",
    correlationId: "run_1",
    attemptId: "attempt_1",
    executionId: "exec_1",
    jobId: "job_1",
    profile: "prod",
    status,
    resultCode: overrides.resultCode ?? "OK",
    executionStarted,
    exitCode: overrides.exitCode ?? 0,
    asOf: executionInput.asOf,
    startedAt: executionStarted ? "2026-08-30T00:01:00.000Z" : null,
    finishedAt: "2026-08-30T00:02:00.000Z",
    durationMs: executionStarted ? 60000 : 0,
    readCount: 5,
    writtenCount: 4,
    deletedCount: 0,
    apiCalls: 2,
    lastSuccessfulChunkNo: 1,
    lastWrittenKey: "K4",
    ksqlFlowVersion: "1.0.0",
    engineVersion: "3.0.0",
    error:
      status === "SUCCESS"
        ? null
        : {
            category: "TEST",
            code: "CONTROLLED",
            message: "controlled",
            retryable: false,
            detailsTruncated: false,
          },
    ...overrides,
  };
}

async function prepared() {
  const repository = new InMemoryPersistenceRepository();
  const waiting = await repository.upsertNodeState({
    expected_revision: null,
    value: {
      node_state_id: "state_1",
      node_state_key: nodeStateKey("run_1", "node_1"),
      run_id: "run_1",
      node_id: "node_1",
      job_id: "job_1",
      status: "WAITING",
      latest_attempt_no: 0,
      active_attempt_id: null,
      revision: 1,
      idempotent: true,
      trigger_rule: "all_success",
      blocked_by: [],
      status_reason: null,
      started_at: null,
      finished_at: null,
      updated_at: "2026-08-30T00:00:00Z",
    },
  });
  const attempt = await repository.createAttempt({
    node_state: waiting,
    node_attempt_id: "attempt_1",
    invocation_id: "invocation_1",
  });
  const nodeState = await repository.upsertNodeState({
    expected_revision: waiting.revision,
    value: {
      ...waiting.value,
      status: "RUNNING",
      latest_attempt_no: 1,
      active_attempt_id: "attempt_1",
      started_at: "2026-08-30T00:00:00Z",
      updated_at: "2026-08-30T00:00:00Z",
    },
  });
  return { repository, attempt, nodeState };
}

function executor(
  setup,
  value,
  processOverrides = {},
  marker = "2026-08-30T00:01:00Z",
) {
  return new AttemptExecutor({
    repository: setup.repository,
    runner: {
      run: async () => ({
        exitCode: value?.exitCode ?? null,
        stdout: "",
        stderr: "diagnostic only",
        resultJsonPath: "C:\\exec\\attempt_1.json",
        timedOut: false,
        forced: false,
        launchFailureConfirmed: false,
        ...processOverrides,
      }),
    },
    jobLogReader: {
      findExecutionStarted: async () =>
        marker === null
          ? null
          : { runnerExecutionStartedAt: marker, executionId: "exec_1" },
    },
    resultFileReader: async () => {
      if (value === null) throw new Error("ENOENT");
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    now: () => "2026-08-30T00:03:00.000Z",
  });
}

function unavailableMarkerExecutor(setup) {
  return new AttemptExecutor({
    repository: setup.repository,
    runner: {
      run: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "ENOENT",
        resultJsonPath: "C:\\exec\\attempt_1.json",
        timedOut: false,
        forced: false,
        launchFailureConfirmed: true,
      }),
    },
    jobLogReader: {
      findExecutionStarted: async () => {
        throw new Error("GET unavailable");
      },
    },
    resultFileReader: async () => {
      throw new Error("ENOENT");
    },
    now: () => "2026-08-30T00:03:00.000Z",
  });
}

test("D-09順序でSUCCESS結果をAttempt確定後にNode Stateへ反映する", async () => {
  const setup = await prepared();
  const outcome = await executor(setup, executionResult()).execute({
    ...executionInput,
    ...setup,
  });
  assert.equal(outcome.attempt.value.status, "SUCCESS");
  assert.equal(outcome.attempt.value.result_code, "OK");
  assert.equal(
    outcome.attempt.value.runner_execution_started_at,
    "2026-08-30T00:01:00Z",
  );
  assert.equal(outcome.nodeState.value.status, "SUCCESS");
  assert.equal(outcome.nodeState.value.active_attempt_id, null);
});

test("LOCK_CONFLICTをPREPARE_FAILED Attempt + WAITING Stateにしattempt番号を保持する", async () => {
  const setup = await prepared();
  const value = executionResult({
    status: "FAILED",
    resultCode: "LOCK_CONFLICT",
    exitCode: 5,
    executionStarted: false,
    startedAt: null,
    durationMs: 0,
    readCount: 0,
    writtenCount: 0,
    apiCalls: 0,
    lastSuccessfulChunkNo: null,
    lastWrittenKey: null,
  });
  const outcome = await executor(setup, value, {}, null).execute({
    ...executionInput,
    ...setup,
  });
  assert.equal(outcome.attempt.value.status, "CANCELLED");
  assert.equal(outcome.attempt.value.result_code, "PREPARE_FAILED");
  assert.equal(outcome.attempt.value.attempt_no, 1);
  assert.equal(outcome.nodeState.value.status, "WAITING");
  assert.equal(outcome.nodeState.value.latest_attempt_no, 1);
  assert.equal(outcome.invocationResultCode, "LOCK_CONFLICT");
});

test("不正結果 + runner markerありはUNKNOWNで確定する", async () => {
  const setup = await prepared();
  const value = executionResult({ attemptId: "wrong" });
  const outcome = await executor(setup, value).execute({
    ...executionInput,
    ...setup,
  });
  assert.equal(outcome.classification.kind, "INVALID_RESULT");
  assert.equal(outcome.attempt.value.status, "UNKNOWN");
  assert.equal(outcome.nodeState.value.status, "UNKNOWN");
});

test("spawn失敗を確定でき、runner markerなしなら未実行PREPARE_FAILEDにする", async () => {
  const setup = await prepared();
  const outcome = await executor(
    setup,
    null,
    { launchFailureConfirmed: true },
    null,
  ).execute({ ...executionInput, ...setup });
  assert.equal(outcome.attempt.value.status, "CANCELLED");
  assert.equal(outcome.attempt.value.result_code, "PREPARE_FAILED");
  assert.equal(outcome.nodeState.value.status, "WAITING");
});

test("JobLog GET不能時はmarkerなしと推測せずUNKNOWNにする", async () => {
  const setup = await prepared();
  const outcome = await unavailableMarkerExecutor(setup).execute({
    ...executionInput,
    ...setup,
  });
  assert.equal(outcome.attempt.value.status, "UNKNOWN");
  assert.equal(outcome.nodeState.value.status, "UNKNOWN");
});

test("graceful CANCELLED結果を停止確定として保存する", async () => {
  const setup = await prepared();
  const value = executionResult({
    status: "CANCELLED",
    resultCode: "CANCELLED",
    exitCode: 3,
  });
  const outcome = await executor(setup, value, { timedOut: true }).execute({
    ...executionInput,
    ...setup,
  });
  assert.equal(outcome.attempt.value.status, "CANCELLED");
  assert.equal(outcome.nodeState.value.status, "CANCELLED");
});

test("grace超過forced killは結果があってもUNKNOWNにする", async () => {
  const setup = await prepared();
  const outcome = await executor(setup, executionResult(), {
    exitCode: null,
    timedOut: true,
    forced: true,
  }).execute({ ...executionInput, ...setup });
  assert.equal(outcome.classification.kind, "INVALID_RESULT");
  assert.equal(outcome.attempt.value.status, "UNKNOWN");
  assert.equal(outcome.attempt.value.result_code, "FORCED_TERMINATION");
});
