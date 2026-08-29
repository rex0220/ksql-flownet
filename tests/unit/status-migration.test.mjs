import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import { parse } from "yaml";

import {
  StatusMigrationError,
  convertStatusMigration,
} from "../../spikes/c-status-migration/scripts/convert.mjs";

const fixtureUrl = new URL(
  "../../spikes/c-status-migration/fixtures.yaml",
  import.meta.url,
);
const fixture = parse(await readFile(fixtureUrl, "utf8"));

test("D-06 fixture全14ケースを原因情報込みで変換する", () => {
  assert.equal(fixture.cases.length, 14);
  for (const fixtureCase of fixture.cases) {
    const expected = {
      new_node_state_status: fixtureCase.expected.new_node_state_status,
      result_code: fixtureCase.expected.result_code,
      result_destination:
        fixtureCase.expected.result_destination ?? "node_state",
    };
    assert.deepEqual(
      convertStatusMigration(fixtureCase.input),
      expected,
      fixtureCase.id,
    );
  }
});

test("statusが既知でも原因情報が欠ける組合せはfail-closedになる", () => {
  const cases = [
    { current_status: "SUCCESS" },
    {
      ...fixture.cases.find(({ id }) => id === "timeout_detected_by_runner")
        .input,
      timeout_source: "stale_recovery",
    },
    {
      ...fixture.cases.find(({ id }) => id === "skipped_dependency").input,
      log_detail: { skip_reason: "dependency" },
    },
    {
      ...fixture.cases.find(({ id }) => id === "failed_sql").input,
      log_detail: { outcome: "execution_error", error_category: "UNKNOWN" },
    },
  ];

  for (const input of cases) {
    assert.throws(
      () => convertStatusMigration(input),
      (error) =>
        error instanceof StatusMigrationError &&
        error.code.startsWith("MIGRATION_"),
    );
  }
});

test("未知statusを暗黙変換しない", () => {
  assert.throws(
    () =>
      convertStatusMigration({
        current_status: "PARTIAL_SUCCESS",
        record_type: "JOB",
        log_detail: {},
        timeout_source: "none",
        actor: { type: "ksql_flow_runner", authenticated: true },
      }),
    (error) =>
      error instanceof StatusMigrationError &&
      error.code === "MIGRATION_STATUS_UNKNOWN",
  );
});
