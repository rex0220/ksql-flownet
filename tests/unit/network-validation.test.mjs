import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import { parseAllDocuments } from "yaml";

import { stableTopologicalSort } from "../../dist/dag/topological-sort.js";
import { MAX_IDENTIFIER_LENGTH } from "../../dist/domain/network-definition.js";
import { validateNetworkDefinition } from "../../dist/domain/validate-network.js";

function validDefinition() {
  return {
    schema_version: 1,
    network_id: "network",
    business_key_policy: { type: "explicit" },
    network_lock: { lease_duration_sec: 3, heartbeat_interval_sec: 1 },
    nodes: [
      {
        id: "one",
        job_id: "job_one",
        sql: "jobs/one.sql",
        depends_on: [],
        trigger_rule: "all_success",
        idempotent: true,
      },
    ],
  };
}

function messages(definition) {
  return validateNetworkDefinition(definition).errors.map(
    (error) => `${error.path}: ${error.message}`,
  );
}

function assertInvalid(definition, pattern) {
  assert.match(messages(definition).join("\n"), pattern);
}

test("schema accepts only version 1, rejects unknown keys, and defaults max_active_runs", () => {
  const valid = validateNetworkDefinition(validDefinition());
  assert.equal(valid.errors.length, 0);
  assert.equal(valid.definition.max_active_runs, 1);

  assertInvalid({ ...validDefinition(), schema_version: 2 }, /schema_version/);
  assertInvalid(
    { ...validDefinition(), surprise: true },
    /unknown property 'surprise'/,
  );
  assertInvalid(
    { ...validDefinition(), max_active_runs: 0 },
    /max_active_runs/,
  );
  assertInvalid(
    { ...validDefinition(), max_active_runs: 1.5 },
    /max_active_runs/,
  );
});

test("identifier constraints reject reserved text, separators, NUL, and excess length", () => {
  for (const networkId of [
    "__net__",
    "has:colon",
    "has\0nul",
    "x".repeat(MAX_IDENTIFIER_LENGTH + 1),
  ]) {
    assertInvalid(
      { ...validDefinition(), network_id: networkId },
      /network_id/,
    );
  }

  for (const property of ["id", "job_id"]) {
    const definition = validDefinition();
    definition.nodes[0][property] = "__net__";
    assertInvalid(definition, new RegExp(property));
  }
});

test("all required node fields are enforced", () => {
  for (const property of [
    "job_id",
    "idempotent",
    "depends_on",
    "trigger_rule",
  ]) {
    const definition = validDefinition();
    delete definition.nodes[0][property];
    assertInvalid(definition, new RegExp(property));
  }
});

test("node identity and dependency rules reject all invalid relationships", () => {
  const duplicate = validDefinition();
  duplicate.nodes.push({ ...duplicate.nodes[0] });
  assertInvalid(duplicate, /duplicate node id 'one'/);
  assert.deepEqual(
    validateNetworkDefinition(duplicate).errors.map((error) => error.code),
    ["DUPLICATE_NODE_ID"],
  );

  const unknown = validDefinition();
  unknown.nodes[0].depends_on = ["missing"];
  assertInvalid(unknown, /unknown dependency 'missing'/);

  const self = validDefinition();
  self.nodes[0].depends_on = ["one"];
  assertInvalid(self, /self-dependency/);

  const repeated = validDefinition();
  repeated.nodes.push({
    ...repeated.nodes[0],
    id: "two",
    depends_on: ["one", "one"],
  });
  assertInvalid(repeated, /duplicate dependency 'one'/);
});

test("reserved trigger rules fail instead of degrading to all_success", () => {
  for (const triggerRule of ["none_failed", "all_done"]) {
    const definition = validDefinition();
    definition.nodes[0].trigger_rule = triggerRule;
    assertInvalid(definition, /reserved and not supported in Phase 1/);
  }
  const unknown = validDefinition();
  unknown.nodes[0].trigger_rule = "sometimes";
  assertInvalid(unknown, /trigger_rule/);
});

test("business key policy validates variants, timezone, and placeholders", () => {
  for (const policy of [
    {
      type: "scheduled_period",
      period: "week",
      timezone: "UTC",
      format: "{yyyy}",
    },
    {
      type: "scheduled_period",
      period: "day",
      timezone: "Not/AZone",
      format: "{yyyy}",
    },
    {
      type: "scheduled_period",
      period: "day",
      timezone: "UTC",
      format: "{unknown}",
    },
    {
      type: "scheduled_period",
      period: "day",
      timezone: "UTC",
      format: "{yyyy",
    },
    { type: "explicit", format: "not-allowed" },
    { type: "future" },
  ]) {
    assert.ok(
      messages({ ...validDefinition(), business_key_policy: policy }).length >
        0,
    );
  }

  const scheduled = {
    ...validDefinition(),
    business_key_policy: {
      type: "scheduled_period",
      period: "day",
      timezone: "Asia/Tokyo",
      format: "{network_id}@{yyyy}-{MM}-{dd}",
    },
  };
  assert.equal(messages(scheduled).length, 0);

  for (const [period, format] of [
    ["month", "{yyyy}-{MM}-{dd}"],
    ["month", "{yyyy}"],
    ["day", "{yyyy}-{MM}"],
  ]) {
    const mismatch = {
      ...validDefinition(),
      business_key_policy: {
        type: "scheduled_period",
        period,
        timezone: "UTC",
        format,
      },
    };
    assert.ok(
      validateNetworkDefinition(mismatch).errors.some(
        (error) => error.code === "FORMAT_PERIOD_MISMATCH",
      ),
    );
  }
});

test("every validation error has a stable code", () => {
  const definition = validDefinition();
  definition.nodes = [
    { ...definition.nodes[0], depends_on: ["missing"] },
    { ...definition.nodes[0] },
  ];
  const result = validateNetworkDefinition(definition);
  assert.ok(result.errors.length > 0);
  assert.ok(
    result.errors.every((error) => /^[A-Z][A-Z0-9_]+$/.test(error.code)),
  );
});

test("network lock rejects invalid boundary values and accepts the exact one-third boundary", () => {
  for (const networkLock of [
    { lease_duration_sec: 0, heartbeat_interval_sec: 1 },
    { lease_duration_sec: -3, heartbeat_interval_sec: 1 },
    { lease_duration_sec: 3, heartbeat_interval_sec: 0 },
    { lease_duration_sec: 3, heartbeat_interval_sec: -1 },
    { lease_duration_sec: 3, heartbeat_interval_sec: 3 },
    { lease_duration_sec: 5, heartbeat_interval_sec: 2 },
  ]) {
    assert.ok(
      messages({ ...validDefinition(), network_lock: networkLock }).length > 0,
    );
  }

  for (const networkLock of [
    { lease_duration_sec: 3, heartbeat_interval_sec: 1 },
    { lease_duration_sec: 6, heartbeat_interval_sec: 2 },
  ]) {
    assert.equal(
      messages({ ...validDefinition(), network_lock: networkLock }).length,
      0,
    );
  }
});

test("Kahn validation reports nodes left by a cycle", () => {
  const definition = validDefinition();
  definition.nodes = [
    { ...definition.nodes[0], id: "a", depends_on: ["b"] },
    { ...definition.nodes[0], id: "b", depends_on: ["a"] },
  ];
  assertInvalid(definition, /cycle detected; nodes not sortable: a, b/);
});

test("stable topological order uses definition order for serial, branch/join, and multiple starts", () => {
  const node = (id, depends_on = []) => ({
    id,
    job_id: id,
    sql: `${id}.sql`,
    depends_on,
    trigger_rule: "all_success",
    idempotent: true,
  });

  assert.deepEqual(
    stableTopologicalSort([node("a"), node("b", ["a"]), node("c", ["b"])])
      .order,
    ["a", "b", "c"],
  );
  assert.deepEqual(
    stableTopologicalSort([
      node("start"),
      node("left", ["start"]),
      node("right", ["start"]),
      node("join", ["left", "right"]),
    ]).order,
    ["start", "left", "right", "join"],
  );
  assert.deepEqual(
    stableTopologicalSort([
      node("start_one"),
      node("start_two"),
      node("join", ["start_one", "start_two"]),
    ]).order,
    ["start_one", "start_two", "join"],
  );
  assert.deepEqual(
    stableTopologicalSort([
      node("a"),
      node("late", ["a"]),
      node("ready_earlier"),
    ]).order,
    ["a", "late", "ready_earlier"],
  );
});

test("every YAML definition in job-network-examples.md passes pure validation", () => {
  const markdown = readFileSync(
    new URL("../../docs/internal/job-network-examples.md", import.meta.url),
    "utf8",
  );
  const yamlBlocks = [...markdown.matchAll(/```yaml\r?\n([\s\S]*?)```/g)].map(
    (match) => match[1],
  );
  assert.ok(yamlBlocks.length > 0);

  for (const yaml of yamlBlocks) {
    const documents = parseAllDocuments(yaml);
    assert.equal(documents.length, 1);
    const result = validateNetworkDefinition(documents[0].toJS());
    assert.deepEqual(result.errors, [], yaml);
  }
});
