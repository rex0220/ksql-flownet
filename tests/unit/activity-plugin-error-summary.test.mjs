import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateErrorSummaries,
  loadErrorSummaries,
} from "../../dist/plugin/error-summary.js";
import {
  formatErrorSummaryLine,
  limitDisplayValue,
} from "../../dist/plugin/render.js";

const field = (value) => ({ value });
const attempt = (id, runId, nodeId, status, resultCode) => ({
  $id: field(String(id)),
  run_id: field(runId),
  node_id: field(nodeId),
  status: field(status),
  result_code: field(resultCode),
});
const nodeState = (id, runId, nodeId, statusReason) => ({
  $id: field(String(id)),
  run_id: field(runId),
  node_id: field(nodeId),
  status: field("FAILED"),
  status_reason: field(statusReason),
});

test("エラー概要はnodeごとの最新non-SUCCESS attemptを選び、非空status_reasonを併記する", () => {
  const summaries = aggregateErrorSummaries(
    ["run_1"],
    [
      attempt(10, "run_1", "node_a", "FAILED", "OLD"),
      attempt(30, "run_1", "node_a", "FAILED", "LATEST"),
      attempt(40, "run_1", "node_a", "SUCCESS", "OK"),
      attempt(20, "run_1", "node_b", "UNKNOWN", "NO_RESULT"),
    ],
    [
      nodeState(50, "run_1", "node_a", "old reason"),
      nodeState(60, "run_1", "node_a", "new reason"),
      nodeState(70, "run_1", "node_b", ""),
    ],
  );
  assert.deepEqual(summaries.get("run_1")?.items, [
    {
      nodeId: "node_a",
      resultCode: "LATEST",
      statusReason: "new reason",
      attemptRecordId: "30",
    },
    {
      nodeId: "node_b",
      resultCode: "NO_RESULT",
      statusReason: null,
      attemptRecordId: "20",
    },
  ]);
});

test("ボード用概要は先頭nodeと他N nodeへ縮約し表示長を制限する", () => {
  const summary = {
    state: "ready",
    items: [
      {
        nodeId: `node_${"x".repeat(200)}`,
        resultCode: "FAILED",
        statusReason: "reason",
        attemptRecordId: "30",
      },
      {
        nodeId: "node_b",
        resultCode: "NO_RESULT",
        statusReason: null,
        attemptRecordId: "20",
      },
      {
        nodeId: "node_c",
        resultCode: "TIMEOUT",
        statusReason: null,
        attemptRecordId: "10",
      },
    ],
  };
  const displayed = formatErrorSummaryLine(summary);
  assert.equal(displayed, limitDisplayValue(displayed));
  assert.equal([...displayed].length, 161);
  assert.ok(displayed.endsWith("…"));
});

test("エラー概要のchunk GET失敗は対象Runごとのunavailableへfail-openする", async () => {
  const summaries = await loadErrorSummaries(
    async () => {
      throw new Error("denied");
    },
    100,
    "200",
    ["run_1", "run_2"],
  );
  assert.deepEqual(summaries.get("run_1"), { state: "unavailable" });
  assert.deepEqual(summaries.get("run_2"), { state: "unavailable" });
});

test("エラー概要は既存chunk GETで監査と実行管理の必要fieldだけを読む", async () => {
  const requests = [];
  const summaries = await loadErrorSummaries(
    async (request) => {
      requests.push(request);
      if (request.app === "200") {
        return {
          records: [attempt(10, "run_1", "node_a", "FAILED", "SQL_ERROR")],
        };
      }
      return {
        records: [nodeState(20, "run_1", "node_a", "syntax category")],
      };
    },
    100,
    "200",
    ["run_1"],
  );
  assert.equal(requests.length, 2);
  const auditRequest = requests.find((request) => request.app === "200");
  const stateRequest = requests.find((request) => request.app === 100);
  assert.deepEqual(auditRequest.fields, [
    "run_id",
    "node_id",
    "status",
    "result_code",
    "$id",
  ]);
  assert.deepEqual(stateRequest.fields, [
    "run_id",
    "node_id",
    "status",
    "status_reason",
    "$id",
  ]);
  assert.match(auditRequest.query, /record_type in \("NODE_ATTEMPT"\)/u);
  assert.match(
    stateRequest.query,
    /status in \("FAILED", "UNKNOWN", "BLOCKED"\)/u,
  );
  assert.match(auditRequest.query, /run_id in \("run_1"\)/u);
  assert.equal(
    summaries.get("run_1")?.items[0]?.statusReason,
    "syntax category",
  );
});
