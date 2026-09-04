import assert from "node:assert/strict";
import test from "node:test";

import {
  BundleError,
  buildBundle,
  createStoreZip,
  readStoreZip,
  uploadBundle,
  verifyBundle,
} from "../../dist/bundle/index.js";

const utf8 = (value) => Buffer.from(value, "utf8");

function jobs() {
  const inspectedNode = ({
    nodeId,
    jobId,
    nondeterministicCodes,
    approvedExceptions,
  }) => ({
    nodeId,
    jobId,
    nondeterministicCodes,
    approvedExceptions,
    inspection: {
      formatVersion: 1,
      kind: "JOB_INSPECTION",
      jobId,
      fileName: `${jobId}.sql`,
      dialect: 1,
      statementCount: 1,
      dependsOn: [],
      timeoutSec: null,
      diagnostics: [],
      nondeterministicElements: [],
    },
  });
  return [
    {
      path: "jobs/extract_sales.sql",
      sqlBytes: utf8("-- @ksql name: extract_sales\nSELECT $id FROM APP1;\n"),
      inspectedNode: inspectedNode({
        nodeId: "extract",
        jobId: "extract_sales",
        nondeterministicCodes: [],
        approvedExceptions: [],
      }),
    },
    {
      path: "jobs/aggregate_customer.sql",
      sqlBytes: utf8(
        "-- @ksql name: aggregate_customer\nSELECT NOW() FROM APP2;\n",
      ),
      inspectedNode: inspectedNode({
        nodeId: "aggregate",
        jobId: "aggregate_customer",
        nondeterministicCodes: ["KSQL1306"],
        approvedExceptions: [
          {
            node_id: "aggregate",
            code: "KSQL1306",
            approved_by: "release-owner@example.test",
            reason: "approved fixture",
            approved_at: "2026-08-30T01:02:03.000Z",
          },
        ],
      }),
    },
  ];
}

test("bundle build is byte-for-byte deterministic and manifest records every required fact", () => {
  const input = {
    networkYamlBytes: utf8("schema_version: 1\nnetwork_id: month_end\n"),
    jobs: jobs(),
  };
  const first = buildBundle(input);
  const second = buildBundle({ ...input, jobs: [...input.jobs].reverse() });
  assert.equal(second.zipSha256, first.zipSha256);
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.deepEqual(second.zipBytes, first.zipBytes);

  assert.deepEqual(
    first.manifest.files.map((file) => file.path),
    ["network.yaml", "jobs/aggregate_customer.sql", "jobs/extract_sales.sql"],
  );
  const aggregate = first.manifest.files[1];
  assert.equal(aggregate.jobId, "aggregate_customer");
  assert.deepEqual(aggregate.nondeterministicCodes, ["KSQL1306"]);
  assert.equal(
    aggregate.approvedExceptions[0].approved_by,
    "release-owner@example.test",
  );
  assert.ok(first.manifest.files.every((file) => file.byteLength > 0));
  assert.ok(
    first.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
  );
});

test("bundle round-trip verifies ZIP hash, canonical manifest hash, byte lengths, and file hashes", () => {
  const built = buildBundle({
    networkYamlBytes: utf8("schema_version: 1\n"),
    jobs: jobs(),
  });
  const verified = verifyBundle(built.zipBytes, {
    zipSha256: built.zipSha256,
    manifestSha256: built.manifestSha256,
    manifest: built.manifest,
  });
  assert.deepEqual(verified.manifest, built.manifest);
  assert.equal(verified.zipSha256, built.zipSha256);
  assert.equal(verified.manifestSha256, built.manifestSha256);
});

test("bundle round-trip preserves input patterns without resolving paths", () => {
  const network = utf8(
    "schema_version: 1\nnodes:\n  - inputs:\n      sales: daily/{profile}/sales_{business_key}.csv\n",
  );
  const built = buildBundle({ networkYamlBytes: network, jobs: jobs() });
  verifyBundle(built.zipBytes);
  const stored = readStoreZip(built.zipBytes).find(
    (entry) => entry.name === "network.yaml",
  );
  assert.deepEqual(stored.data, network);
  assert.doesNotMatch(stored.data.toString("utf8"), /[A-Za-z]:\\|\/tmp\//u);
});

test("bundle round-trip preserves output patterns without resolving paths", () => {
  const pattern = "exports/{run_id}/{node_id}/report_{business_key}.csv";
  const built = buildBundle({
    networkYamlBytes: Buffer.from(
      `schema_version: 1\nnodes:\n  - outputs:\n      report: ${pattern}\n`,
    ),
    jobs: jobs(),
  });
  const network = readStoreZip(built.zipBytes).find(
    (entry) => entry.name === "network.yaml",
  );
  assert.equal(network.data.toString("utf8").includes(pattern), true);
  assert.equal(
    network.data.toString("utf8").includes("KSQL_FLOWNET_IO_DIR"),
    false,
  );
});

test("one-byte ZIP tampering is detected fail-closed", () => {
  const built = buildBundle({
    networkYamlBytes: utf8("schema_version: 1\n"),
    jobs: jobs(),
  });
  const tampered = Buffer.from(built.zipBytes);
  const offset = tampered.indexOf("SELECT NOW()", 0, "utf8");
  assert.ok(offset >= 0);
  tampered[offset] ^= 1;
  assert.throws(
    () => verifyBundle(tampered, { zipSha256: built.zipSha256 }),
    (error) =>
      error instanceof BundleError && error.code === "BUNDLE_HASH_MISMATCH",
  );
  assert.throws(
    () => verifyBundle(tampered),
    (error) =>
      error instanceof BundleError && error.code === "BUNDLE_ZIP_INVALID",
  );
});

test("manifest comparison detects content tampering even when attacker rebuilds valid ZIP CRC", () => {
  const built = buildBundle({
    networkYamlBytes: utf8("schema_version: 1\n"),
    jobs: jobs(),
  });
  const entries = readStoreZip(built.zipBytes).map((entry) => ({
    name: entry.name,
    data:
      entry.name === "jobs/extract_sales.sql"
        ? utf8("-- changed with valid CRC --\n")
        : entry.data,
  }));
  const rebuilt = createStoreZip(entries);
  assert.throws(
    () => verifyBundle(rebuilt),
    (error) =>
      error instanceof BundleError && error.code === "BUNDLE_FILE_MISMATCH",
  );
});

test("upload helper uses injected fetch and obtains a fresh single-use fileKey per upload", async () => {
  let sequence = 0;
  const requests = [];
  const fakeFetch = async (input, init) => {
    requests.push({ input, init });
    sequence += 1;
    return new Response(
      JSON.stringify({ fileKey: `new-file-key-${sequence}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const options = {
    endpoint: "https://example.cybozu.com/k/v1/file.json",
    zipBytes: utf8("zip"),
    fetch: fakeFetch,
  };
  assert.equal(await uploadBundle(options), "new-file-key-1");
  assert.equal(await uploadBundle(options), "new-file-key-2");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].init.body, requests[1].init.body);
});
