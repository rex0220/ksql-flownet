import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const templatePath = new globalThis.URL(
  "../../templates/add-run-related-lists.console.js",
  import.meta.url,
);

const allSourceFields = {
  201: [
    "run_id",
    "record_type",
    "node_id",
    "status",
    "result_code",
    "requested_by",
    "invocation_id",
  ],
  301: [
    "run_id",
    "request_type",
    "request_state",
    "result_code",
    "reason",
    "作成日時",
  ],
  401: [
    "correlation_id",
    "job_id",
    "status",
    "error_message",
    "started_at",
    "finished_at",
    "execution_id",
  ],
};

async function executeTemplate(existingCodes = []) {
  const source = await readFile(templatePath, "utf8");
  const calls = [];
  const inputs = ["101", "201", "301", "401"];
  const api = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url.endsWith("/preview/app/form/fields.json") && method === "GET") {
      if (body.app === "101") {
        return {
          properties: Object.fromEntries(
            ["run_id", ...existingCodes].map((code) => [code, {}]),
          ),
        };
      }
      return {
        properties: Object.fromEntries(
          allSourceFields[body.app].map((code) => [code, {}]),
        ),
      };
    }
    if (url.endsWith("/preview/app/form/layout.json") && method === "GET") {
      return {
        layout: [
          {
            type: "ROW",
            fields: [
              "related_audit_events",
              "related_requests",
              "related_job_logs",
            ].map((code) => ({ code })),
          },
        ],
      };
    }
    if (url.endsWith("/preview/app/deploy.json") && method === "GET") {
      return { apps: [{ status: "SUCCESS" }] };
    }
    return { revision: "2" };
  };
  api.url = (path) => path;
  const completion = vm.runInNewContext(source, {
    confirm: () => true,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    kintone: { api },
    prompt: () => inputs.shift(),
    setTimeout: (callback) => callback(),
  });
  await completion;
  return JSON.parse(JSON.stringify(calls));
}

test("3種の関連レコード定義を要求どおり一括追加する", async () => {
  const calls = await executeTemplate();
  const addition = calls.find(
    ({ url, method }) =>
      url.endsWith("/preview/app/form/fields.json") && method === "POST",
  );
  assert.ok(addition);
  const properties = addition.body.properties;
  assert.deepEqual(Object.keys(properties), [
    "related_audit_events",
    "related_requests",
    "related_job_logs",
  ]);
  assert.deepEqual(properties.related_audit_events.referenceTable, {
    relatedApp: { app: "201" },
    condition: { field: "run_id", relatedField: "run_id" },
    displayFields: [
      "record_type",
      "node_id",
      "status",
      "result_code",
      "requested_by",
      "invocation_id",
    ],
    sort: "$id desc",
    size: "10",
  });
  assert.deepEqual(properties.related_requests.referenceTable, {
    relatedApp: { app: "301" },
    condition: { field: "run_id", relatedField: "run_id" },
    displayFields: [
      "request_type",
      "request_state",
      "result_code",
      "reason",
      "作成日時",
    ],
    sort: "$id desc",
    size: "5",
  });
  assert.deepEqual(properties.related_job_logs.referenceTable.condition, {
    field: "run_id",
    relatedField: "correlation_id",
  });
  assert.equal(
    calls.some(
      ({ url, method }) =>
        url.endsWith("/preview/app/form/layout.json") && method === "PUT",
    ),
    false,
    "kintoneが自動配置済みならlayoutへ重複追記しない",
  );
});

test("3フィールドがpreviewに追加済みなら定義確認と追加をスキップして再開する", async () => {
  const calls = await executeTemplate([
    "related_audit_events",
    "related_requests",
    "related_job_logs",
  ]);
  assert.equal(
    calls.filter(({ url }) => url.endsWith("/preview/app/form/fields.json"))
      .length,
    1,
  );
  assert.equal(
    calls.some(
      ({ url, method }) =>
        url.endsWith("/preview/app/form/fields.json") && method === "POST",
    ),
    false,
  );
});
