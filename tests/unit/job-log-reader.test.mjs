import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  decideMissingResult,
  KintoneJobLogReader,
} from "../../dist/executor/job-log-reader.js";
import {
  KintoneApiError,
  KintoneTransportError,
} from "../../dist/persistence/kintone/client.js";

test("開始マーカー判定表3行を安全側に裁定する", () => {
  const rows = [
    [null, null, false, "NOT_EXECUTED"],
    ["2026-08-30T00:00:00Z", null, true, "NOT_EXECUTED"],
    ["2026-08-30T00:00:00Z", null, false, "UNKNOWN"],
    ["2026-08-30T00:00:00Z", "2026-08-30T00:01:00Z", false, "UNKNOWN"],
  ];
  for (const [orchestrator, runner, confirmed, expected] of rows)
    assert.equal(
      decideMissingResult({
        orchestratorExecutionStartedAt: orchestrator,
        runnerExecutionStartedAt: runner,
        durableLaunchFailureConfirmed: confirmed,
      }),
      expected,
    );
});

test("JobLogReaderはapp/token注入のGETだけでattempt/executionを検索し分精度markerを返す", async () => {
  const calls = [];
  const reader = new KintoneJobLogReader({
    baseUrl: "https://example.cybozu.com/",
    appId: 4249,
    apiToken: "secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          records: [
            {
              runner_execution_started_at: { value: "2026-08-30T00:01:00Z" },
              execution_id: { value: "exec_1" },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(
    await reader.findExecutionStarted({
      attemptId: "attempt_1",
      executionId: "exec_1",
    }),
    { runnerExecutionStartedAt: "2026-08-30T00:01:00Z", executionId: "exec_1" },
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("app"), "4249");
  assert.match(url.searchParams.get("query"), /attempt_id = "attempt_1"/);
  assert.match(url.searchParams.get("query"), /execution_id = "exec_1"/);
});

test("JobLogReaderはattempt_idだけで終端statusを読取専用照合する", async () => {
  const reader = new KintoneJobLogReader({
    baseUrl: "https://example.cybozu.com",
    appId: 4249,
    apiToken: "secret",
    fetch: async () =>
      new Response(
        JSON.stringify({
          records: [
            {
              status: { value: "SUCCESS" },
              runner_execution_started_at: {
                value: "2026-08-30T00:01:00Z",
              },
              execution_id: { value: "exec_1" },
              finished_at: { value: "2026-08-30T00:02:00Z" },
            },
          ],
        }),
        { status: 200 },
      ),
  });
  assert.deepEqual(await reader.findAttemptResult("attempt_1"), {
    status: "SUCCESS",
    runnerExecutionStartedAt: "2026-08-30T00:01:00Z",
    executionId: "exec_1",
    finishedAt: "2026-08-30T00:02:00Z",
  });
});

test("JobLogReaderはfetch到達不能とAPI裁定エラーを区別する", async () => {
  const unreachable = new KintoneJobLogReader({
    baseUrl: "https://example.cybozu.com",
    appId: 4249,
    apiToken: "secret",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    unreachable.findExecutionStarted({ attemptId: "attempt_1" }),
    KintoneTransportError,
  );

  const conflict = new KintoneJobLogReader({
    baseUrl: "https://example.cybozu.com",
    appId: 4249,
    apiToken: "secret",
    fetch: async () =>
      new Response(JSON.stringify({ code: "GAIA_CO02" }), { status: 409 }),
  });
  await assert.rejects(
    conflict.findExecutionStarted({ attemptId: "attempt_1" }),
    (error) => {
      assert.ok(error instanceof KintoneApiError);
      assert.equal(error.status, 409);
      assert.equal(error.apiCode, "GAIA_CO02");
      return true;
    },
  );
});
