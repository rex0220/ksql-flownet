import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  createReadOnlyLogsClient,
  inspectRealLogs,
} from "../../spikes/c-status-migration/scripts/inspect-real-logs.mjs";

function field(value, type = "SINGLE_LINE_TEXT") {
  return { type, value };
}

test("実ログinspectは1件GETでfield発見後、GETだけで匿名集計する", async () => {
  const calls = [];
  const records = [
    {
      $id: field("1", "__ID__"),
      status: field("SUCCESS", "DROP_DOWN"),
      log_type: field("JOB", "DROP_DOWN"),
      log_detail: field("customer A free text", "MULTI_LINE_TEXT"),
      timeout_type: field("none", "DROP_DOWN"),
      job_name: field("secret job name"),
    },
    {
      $id: field("2", "__ID__"),
      status: field("UNCLASSIFIED_REAL_VALUE", "DROP_DOWN"),
      log_type: field("JOB", "DROP_DOWN"),
      log_detail: field("customer B free text", "MULTI_LINE_TEXT"),
      timeout_type: field("runner", "DROP_DOWN"),
      job_name: field("another secret job"),
    },
  ];
  const fetchMock = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const query = new URL(url).searchParams.get("query");
    return Response.json({
      records: /limit 1(?:\s|$)/.test(query) ? [records[0]] : records,
    });
  };
  const client = createReadOnlyLogsClient(
    {
      baseUrl: "https://example.cybozu.com",
      app: "4249",
      token: "read-only-secret",
    },
    fetchMock,
  );

  assert.deepEqual(Object.keys(client).sort(), [
    "apiCalls",
    "getOneRecord",
    "getRecords",
  ]);
  const report = await inspectRealLogs(client, 100);

  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.method === "GET"));
  assert.ok(calls.every(({ options }) => options.body === undefined));
  assert.match(calls[0].url.searchParams.get("query"), /limit 1/);
  assert.equal(report.mode, "read_only");
  assert.deepEqual(report.status.distribution, {
    SUCCESS: 1,
    UNCLASSIFIED_REAL_VALUE: 1,
  });
  assert.deepEqual(report.status.observed_statuses_not_in_fixture, [
    "UNCLASSIFIED_REAL_VALUE",
  ]);
  assert.equal(
    report.fixture_input_comparison.current_status.difference,
    "field_name_differs",
  );

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    "customer A free text",
    "customer B free text",
    "secret job name",
    "another secret job",
    "read-only-secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("status fieldが曖昧な場合は値を推測集計しない", async () => {
  const record = {
    status: field("SUCCESS"),
    current_status: field("FAILED"),
  };
  const client = createReadOnlyLogsClient(
    {
      baseUrl: "https://example.cybozu.com",
      app: "4249",
      token: "secret",
    },
    async () => Response.json({ records: [record] }),
  );
  const report = await inspectRealLogs(client, 1);
  assert.equal(report.status.selected_field, null);
  assert.deepEqual(report.status.distribution, {});
  assert.equal(
    report.fixture_input_comparison.current_status.difference,
    "ambiguous_candidates",
  );
});
