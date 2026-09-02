import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  createKintoneFetchRecords,
  createKintonePostRecord,
} from "../../dist/plugin/desktop.js";

const bundlePath = new globalThis.URL(
  "../../plugin/dist/activity.js",
  import.meta.url,
);
const metafilePath = new globalThis.URL(
  "../../plugin/dist/activity-meta.json",
  import.meta.url,
);
const vectorsPath = new globalThis.URL(
  "../fixtures/status-activity/vectors.json",
  import.meta.url,
);

test("browser bundle and metafile contain no Node runtime tokens", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const metafile = readFileSync(metafilePath, "utf8");
  for (const [label, pattern] of [
    ["node:", /node:/u],
    ["node:crypto", /node:crypto/u],
    ["require(", /require\s*\(/u],
    ["process.", /process\s*\./u],
  ]) {
    assert.doesNotMatch(bundle, pattern, `${label} in bundle`);
    assert.doesNotMatch(metafile, pattern, `${label} in metafile`);
  }
  const metadata = JSON.parse(metafile);
  assert.equal(
    Object.keys(metadata.inputs).some((path) => path.endsWith("status.ts")),
    false,
  );
  assert.equal(
    Object.keys(metadata.inputs).some((path) =>
      path.endsWith("reconciliation.ts"),
    ),
    false,
  );
  assert.equal(
    Object.keys(metadata.inputs).some((path) =>
      path.endsWith("run-activity.ts"),
    ),
    true,
  );
});

test("browser-equivalent vm evaluates all 15 shared activity vectors", () => {
  const context = {};
  vm.runInNewContext(readFileSync(bundlePath, "utf8"), context, {
    filename: "activity.js",
  });
  const deriveRunActivity = context.KsqlFlownetActivity.deriveRunActivity;
  const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
  assert.equal(vectors.length, 15);
  const nowMs = Date.parse("2026-08-31T01:00:00Z");
  for (const vector of vectors) {
    const lock =
      vector.lock === null
        ? null
        : {
            record_id: "lock_1",
            owner_invocation_id: vector.lock.owner_belongs
              ? "invoke_1"
              : "invoke_other",
            owner_instance_id: "host",
            heartbeat_at: "2026-08-31T00:59:00.000Z",
            lease_expires_at: new Date(
              nowMs + vector.lock.lease_relative_seconds * 1_000,
            ).toISOString(),
            revision: 1,
          };
    assert.equal(
      deriveRunActivity({
        status: vector.status,
        startedAt: vector.started_at,
        invocationIds: ["invoke_1"],
        lock,
        cancelState: vector.cancel_state,
        nowMs,
      }),
      vector.expected,
      vector.name,
    );
  }
});

test("desktopバンドルへ設定画面コードを混入させない(2026-09-01実機回帰: 一覧で設定設置が走り要素不足エラー)", async () => {
  const { readFileSync } = await import("node:fs");
  const desktop = readFileSync(
    new globalThis.URL("../../plugin/dist/desktop.js", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "installConfigPage",
    "bootstrapConfigPage",
    "設定画面の要素が不足",
  ]) {
    assert.ok(
      !desktop.includes(forbidden),
      `desktop.jsに設定画面コードを含めない: ${forbidden}`,
    );
  }
});

test("runtime adapters allow only form fields GET, records GET, and single-record POST", async () => {
  const calls = [];
  const api = async (url, method, body) => {
    calls.push({ url, method, body });
    return method === "GET" ? { records: [] } : { id: "1", revision: "1" };
  };
  api.url = (path, guest) => {
    assert.equal(guest, true);
    return path;
  };
  const fetchRecords = createKintoneFetchRecords({ api });
  for (const app of [100, 200, 300, 400]) {
    await fetchRecords({ app, query: "limit 1", fields: ["$id"] });
  }
  await createKintonePostRecord({ api })({
    app: 300,
    record: {
      request_type: { value: "STOP" },
      run_id: { value: "run_1" },
      reason: { value: "reason" },
    },
  });
  await createKintonePostRecord({ api })({
    app: 300,
    record: {
      request_type: { value: "START" },
      network_id: { value: "monthly" },
      business_key: { value: "" },
      scheduled_for: { value: "2026-08-31T15:00:00.000Z" },
      reason: { value: "reason" },
    },
  });
  const roles = new Map([
    [100, "state"],
    [200, "audit"],
    [300, "request"],
    [400, "log"],
  ]);
  const allowed = new Set([
    "state|/k/v1/records.json|GET",
    "audit|/k/v1/records.json|GET",
    "request|/k/v1/records.json|GET",
    "log|/k/v1/records.json|GET",
    "request|/k/v1/record.json|POST",
  ]);
  assert.equal(calls.length, 6);
  for (const { url, method, body } of calls) {
    const role = roles.get(body.app);
    assert.ok(role, `unknown app role: ${body.app}`);
    assert.ok(
      allowed.has(`${role}|${url}|${method}`),
      `${role}|${url}|${method}`,
    );
    if (method === "POST") {
      assert.equal(role, "request");
      const fields = Object.keys(body.record);
      assert.ok(
        [
          "request_type,run_id,reason",
          "request_type,network_id,business_key,scheduled_for,reason",
        ].includes(fields.join(",")),
      );
    }
  }
});

test("desktop bundle contains no cursor, bulk, PUT or DELETE API", () => {
  const desktop = readFileSync(
    new globalThis.URL("../../plugin/dist/desktop.js", import.meta.url),
    "utf8",
  );
  for (const [label, pattern] of [
    ["cursor", /\/k\/v1\/records\/cursor\.json/u],
    ["bulk", /\/k\/v1\/bulkRequest\.json/u],
    ["PUT", /["']PUT["']/u],
    ["DELETE", /["']DELETE["']/u],
  ]) {
    assert.doesNotMatch(desktop, pattern, label);
  }
  const endpoints = [...desktop.matchAll(/\/k\/v1\/[A-Za-z/]+\.json/gu)].map(
    (match) => match[0],
  );
  assert.ok(endpoints.length >= 2, "allowed endpoints are present");
  assert.deepEqual([...new Set(endpoints)].sort(), [
    "/k/v1/app/form/fields.json",
    "/k/v1/record.json",
    "/k/v1/records.json",
  ]);
});
