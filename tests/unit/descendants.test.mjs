import assert from "node:assert/strict";
import test from "node:test";

import {
  descendantsIncludingSelf,
  DescendantsError,
} from "../../dist/dag/descendants.js";

function definition(nodes) {
  return {
    schema_version: 1,
    network_id: "descendants",
    business_key_policy: { type: "explicit" },
    max_active_runs: 1,
    network_lock: { lease_duration_sec: 3, heartbeat_interval_sec: 1 },
    nodes: nodes.map(({ id, dependsOn = [] }) => ({
      id,
      job_id: `job_${id}`,
      sql: `jobs/${id}.sql`,
      depends_on: dependsOn,
      trigger_rule: "all_success",
      idempotent: true,
    })),
  };
}

test("指定ノード自身と全子孫だけを定義順で返す", () => {
  const dag = definition([
    { id: "upstream" },
    { id: "selected", dependsOn: ["upstream"] },
    { id: "sibling", dependsOn: ["upstream"] },
    { id: "left", dependsOn: ["selected"] },
    { id: "right", dependsOn: ["selected"] },
    { id: "join", dependsOn: ["left", "right"] },
  ]);
  assert.deepEqual(descendantsIncludingSelf(dag, "selected"), [
    "selected",
    "left",
    "right",
    "join",
  ]);
});

test("存在しないノードと計算不能なDAGを安定codeで拒否する", () => {
  assert.throws(
    () => descendantsIncludingSelf(definition([{ id: "one" }]), "missing"),
    (error) =>
      error instanceof DescendantsError &&
      error.code === "DESCENDANTS_NODE_NOT_FOUND",
  );
  assert.throws(
    () =>
      descendantsIncludingSelf(
        definition([
          { id: "one", dependsOn: ["two"] },
          { id: "two", dependsOn: ["one"] },
        ]),
        "one",
      ),
    (error) =>
      error instanceof DescendantsError &&
      error.code === "DESCENDANTS_DAG_INVALID",
  );
});
