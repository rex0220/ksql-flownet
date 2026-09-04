import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadIoConfig } from "../../dist/io/io-config.js";
import {
  InputPathError,
  percentEncodePathSegment,
  resolveNodeInputs,
} from "../../dist/io/io-path.js";

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "ksql-flownet-io-"));
  mkdirSync(join(root, "in", "daily"), { recursive: true });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function rejected(input, code) {
  await assert.rejects(resolveNodeInputs(input), (error) => {
    assert.ok(error instanceof InputPathError);
    assert.equal(error.code, code);
    return true;
  });
}

test("placeholder値を単一segmentへpercent encodeしhandleからhash/bytesを得る", async (context) => {
  const root = fixture(context);
  const businessKey = "a/../b\\.日本";
  const profile = ".";
  const fileName = `sales_${percentEncodePathSegment(businessKey)}_${percentEncodePathSegment(profile)}.csv`;
  const filePath = join(root, "in", "daily", fileName);
  const bytes = Buffer.from("id,value\n1,ok\n", "utf8");
  writeFileSync(filePath, bytes);
  const result = await resolveNodeInputs({
    ioRoot: root,
    patterns: { sales: "daily/sales_{business_key}_{profile}.csv" },
    businessKey,
    profile,
  });
  assert.deepEqual(result, [
    {
      name: "sales",
      path: resolve(filePath),
      sha256:
        "332433b40eb045d6e5b43d74eaef139d5a3b13d5b81765253390a31482050641",
      bytes: bytes.length,
    },
  ]);
  assert.equal(percentEncodePathSegment("."), "%2E");
  assert.equal(percentEncodePathSegment("/\\"), "%2F%5C");
});

test("root外、absolute、traversal、非directory中間、非通常file、不在を分類する", async (context) => {
  const root = fixture(context);
  writeFileSync(join(root, "in", "plain"), "not a directory");
  mkdirSync(join(root, "in", "directory.csv"));
  const base = { ioRoot: root, businessKey: "key", profile: "prod" };
  for (const pattern of [
    "../outside.csv",
    resolve(root, "outside.csv"),
    "daily/../../outside.csv",
  ]) {
    await rejected(
      { ...base, patterns: { source: pattern } },
      "INPUT_PATH_REJECTED",
    );
  }
  await rejected(
    { ...base, patterns: { source: "plain/file.csv" } },
    "INPUT_PATH_REJECTED",
  );
  await rejected(
    { ...base, patterns: { source: "directory.csv" } },
    "INPUT_PATH_REJECTED",
  );
  await rejected(
    { ...base, patterns: { source: "missing.csv" } },
    "INPUT_FILE_MISSING",
  );
});

test("symlinkまたはjunctionを含む入力pathを拒否する", async (context) => {
  const root = fixture(context);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "file.csv"), "secret");
  const link = join(root, "in", "linked");
  try {
    symlinkSync(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      context.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejected(
    {
      ioRoot: root,
      patterns: { source: "linked/file.csv" },
      businessKey: "key",
      profile: "prod",
    },
    "INPUT_PATH_REJECTED",
  );
});

test("IO configはabsolute existing directoryとpositive retentionだけを受理する", (context) => {
  const root = fixture(context);
  assert.deepEqual(loadIoConfig({ KSQL_FLOWNET_IO_DIR: root }), {
    root: resolve(root),
    retentionDays: 90,
  });
  assert.equal(
    loadIoConfig({
      KSQL_FLOWNET_IO_DIR: root,
      KSQL_FLOWNET_IO_RETENTION_DAYS: "30",
    }).retentionDays,
    30,
  );
  for (const environment of [
    {},
    { KSQL_FLOWNET_IO_DIR: "relative" },
    { KSQL_FLOWNET_IO_DIR: join(root, "missing") },
    { KSQL_FLOWNET_IO_DIR: root, KSQL_FLOWNET_IO_RETENTION_DAYS: "0" },
    { KSQL_FLOWNET_IO_DIR: root, KSQL_FLOWNET_IO_RETENTION_DAYS: "1.5" },
  ]) {
    assert.throws(() => loadIoConfig(environment));
  }
});
