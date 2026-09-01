import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

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
