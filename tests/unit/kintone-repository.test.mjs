import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import { KintonePersistenceRepository } from "../../dist/persistence/kintone/repository.js";
import { KINTONE_FIELD_MAP } from "../../dist/persistence/kintone/schema.js";
import { RepositoryError } from "../../dist/persistence/repository.js";

function makeState() {
  return {
    node_state_id: "state_1",
    node_state_key: nodeStateKey("run_1", "node_1"),
    run_id: "run_1",
    node_id: "node_1",
    job_id: "job_1",
    status: "WAITING",
    latest_attempt_no: 0,
    active_attempt_id: null,
    revision: 1,
    idempotent: true,
    trigger_rule: "all_success",
    blocked_by: [],
    status_reason: null,
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-30T00:00:00Z",
  };
}

function makeRun() {
  return {
    run_id: "run_1",
    network_id: "net",
    business_key: "net@1",
    max_active_runs: 1,
    status: "CREATED",
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: null,
    definition_schema_version: 1,
    definition_sha256: "sha256:def",
    source_bundle_sha256: "sha256:bundle",
    source_bundle_attachment: "uploaded-file-key",
    resolved_profile_snapshot: {
      profile: "prod",
      base_url: "https://example.cybozu.com",
      guest_space_id: null,
      timezone: "Asia/Tokyo",
      apps: { data: 1 },
      limits: {
        max_api_calls: 5000,
        max_read_rows: 200000,
        batch_timeout_sec: 3600,
      },
    },
    resolved_profile_sha256: "sha256:profile",
    ksql_flow_version: "1",
    engine_version: "3",
    dialect: 1,
    created_at: "2026-08-30T00:00:00Z",
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-30T00:00:00Z",
  };
}

function createKintoneFake({
  loseFirstAttemptResponse = false,
  staleUpdateReturnsDa02 = false,
  failRereadAfterDa02 = false,
} = {}) {
  const apps = new Map();
  const calls = [];
  let lost = false;
  let da02Returned = false;
  const recordsFor = (app) => {
    if (!apps.has(app)) apps.set(app, []);
    return apps.get(app);
  };
  const response = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetch = async (input, init) => {
    const url = new URL(input);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, headers: init.headers, body });
    if (method === "GET") {
      if (failRereadAfterDa02 && da02Returned)
        return response({ code: "GAIA_TM12" }, 503);
      const app = Number(url.searchParams.get("app"));
      const query = url.searchParams.get("query");
      const predicates = [
        ...query.matchAll(/([a-z_$]+) in \("((?:\\.|[^"])*)"\)/g),
      ].map((match) => [
        match[1],
        match[2].replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
      ]);
      const records = recordsFor(app).filter((record) =>
        predicates.every(
          ([code, expected]) => String(record[code]?.value ?? "") === expected,
        ),
      );
      return response({ records });
    }
    if (method === "POST") {
      const records = recordsFor(body.app);
      const duplicate = records.some(
        (record) =>
          record.record_key.value === body.record.record_key.value ||
          (body.record.attempt_key?.value &&
            record.attempt_key?.value === body.record.attempt_key.value),
      );
      if (duplicate)
        return response({ code: "CB_VA01", message: "duplicate" }, 400);
      const revision = "1";
      records.push({ ...body.record, $revision: { value: revision } });
      if (
        loseFirstAttemptResponse &&
        body.record.record_type.value === "NODE_ATTEMPT" &&
        !lost
      ) {
        lost = true;
        throw new TypeError("synthetic response loss after durable insert");
      }
      return response({ id: String(records.length), revision });
    }
    if (method === "PUT") {
      const records = recordsFor(body.app);
      if (body.updateKey && Object.hasOwn(body.record, body.updateKey.field)) {
        return response({ code: "CB_VA01" }, 400);
      }
      const record = records.find(
        (candidate) => candidate.record_key.value === body.updateKey.value,
      );
      if (!record) return response({ code: "GAIA_RE20" }, 404);
      if (Number(record.$revision.value) !== body.revision) {
        if (staleUpdateReturnsDa02) {
          da02Returned = true;
          return response({ code: "GAIA_DA02" }, 400);
        }
        return response({ code: "GAIA_CO02" }, 409);
      }
      const revision = String(Number(record.$revision.value) + 1);
      Object.assign(record, body.record, { $revision: { value: revision } });
      return response({ revision });
    }
    throw new Error(`unexpected ${method}`);
  };
  return { fetch, calls };
}

function repository(fake) {
  return new KintonePersistenceRepository({
    baseUrl: "https://example.cybozu.com",
    stateAppId: 100,
    stateApiToken: "state-token",
    auditAppId: 200,
    auditApiToken: "audit-token",
    fetch: fake.fetch,
  });
}

test("app-design-2app.mdのrecord type別field mapを固定する", () => {
  assert.deepEqual(Object.keys(KINTONE_FIELD_MAP.NETWORK_RUN), [
    "record_key",
    "record_type",
    "run_id",
    "network_id",
    "business_key",
    "max_active_runs",
    "status",
    "lifecycle_status",
    "resume_allowed",
    "as_of",
    "definition_schema_version",
    "definition_sha256",
    "source_bundle_sha256",
    "source_bundle_attachment",
    "resolved_profile_snapshot",
    "resolved_profile_sha256",
    "ksql_flow_version",
    "engine_version",
    "dialect",
    "created_at",
    "started_at",
    "finished_at",
    "updated_at",
  ]);
  assert.deepEqual(Object.keys(KINTONE_FIELD_MAP.NODE_ATTEMPT), [
    "record_key",
    "record_type",
    "run_id",
    "finished_at",
    "status",
    "result_code",
    "node_attempt_id",
    "attempt_key",
    "node_id",
    "job_id",
    "invocation_id",
    "attempt_no",
    "execution_started_at",
    "runner_execution_started_at",
    "execution_id",
    "duration_sec",
    "error_message",
    "read_count",
    "written_count",
    "last_successful_chunk_no",
    "last_written_key",
    "state_revision_before",
  ]);
});

test("kintone: token、2app、in query、POST/GET/PUT形状を守る", async () => {
  const fake = createKintoneFake();
  const repo = repository(fake);
  const created = await repo.createRun(makeRun());
  const found = await repo.getRunByBusinessKey("prod", "net", "net@1");
  assert.equal(found.value.run_id, "run_1");
  await repo.updateRunAggregate("run_1", created.revision, {
    status: "RUNNING",
    started_at: "2026-08-30T00:00:01Z",
    finished_at: null,
    updated_at: "2026-08-30T00:00:01Z",
  });
  assert.ok(fake.calls.every(({ method }) => method !== "DELETE"));
  assert.ok(fake.calls.every(({ headers }) => headers["X-Cybozu-API-Token"]));
  const businessGet = fake.calls.find(
    ({ method, url }) =>
      method === "GET" &&
      url.searchParams.get("query")?.includes("business_key"),
  );
  assert.match(
    businessGet.url.searchParams.get("query"),
    /record_type in \("NETWORK_RUN"\)/,
  );
  assert.doesNotMatch(
    businessGet.url.searchParams.get("query"),
    /record_type =/,
  );
  const put = fake.calls.find(({ method }) => method === "PUT");
  assert.deepEqual(put.body.updateKey, {
    field: "record_key",
    value: "RUN:run_1",
  });
  assert.equal(put.body.revision, 1);
});

test("kintone: Attempt INSERT成功応答消失は再GETで同一性を裁定する", async () => {
  const fake = createKintoneFake({ loseFirstAttemptResponse: true });
  const repo = repository(fake);
  const state = await repo.upsertNodeState({
    value: makeState(),
    expected_revision: null,
  });
  const attempt = await repo.createAttempt({
    node_state: state,
    node_attempt_id: "attempt_1",
    invocation_id: "invoke_1",
  });
  assert.equal(attempt.value.node_attempt_id, "attempt_1");
  assert.equal(attempt.value.attempt_no, 1);
  assert.equal(attempt.value.state_revision_before, state.revision);
  const attemptPost = fake.calls.find(
    ({ method, body }) =>
      method === "POST" && body.record.record_type.value === "NODE_ATTEMPT",
  );
  assert.equal(
    attemptPost.body.record.state_revision_before.value,
    state.revision,
  );
  assert.ok(
    fake.calls.some(
      ({ method, url }) =>
        method === "GET" &&
        url.searchParams.get("query")?.includes("ATT:attempt_1"),
    ),
  );
});

test("kintone: reconciliation監査をOPERATION_AUDIT形状で監査appへ書く", async () => {
  const fake = createKintoneFake();
  const repo = repository(fake);
  await repo.appendOperationAudit({
    event_id: "audit-event-1",
    event_type: "RECONCILIATION_REPAIR",
    repair_type: "TERMINAL_ATTEMPT_APPLIED",
    run_id: "run_1",
    target_type: "NODE_STATE",
    target_id: "state_1",
    before: { status: "RUNNING", revision: 2 },
    after: { status: "SUCCESS", revision: 3 },
    basis: "terminal attempt attempt_1 is the unique active attempt",
    occurred_at: "2026-08-30T00:01:00Z",
  });
  const call = fake.calls.find(
    ({ method, body }) =>
      method === "POST" && body.record.record_type.value === "OPERATION_AUDIT",
  );
  assert.equal(call.body.app, 200);
  assert.equal(call.body.record.record_key.value, "OP:audit-event-1");
  assert.equal(call.body.record.result_code.value, "TERMINAL_ATTEMPT_APPLIED");
  assert.deepEqual(JSON.parse(call.body.record.reason.value), {
    event_id: "audit-event-1",
    event_type: "RECONCILIATION_REPAIR",
    repair_type: "TERMINAL_ATTEMPT_APPLIED",
    run_id: "run_1",
    target_type: "NODE_STATE",
    target_id: "state_1",
    before: { status: "RUNNING", revision: 2 },
    after: { status: "SUCCESS", revision: 3 },
    basis: "terminal attempt attempt_1 is the unique active attempt",
    occurred_at: "2026-08-30T00:01:00Z",
  });
  assert.equal(call.body.record.resolved_at.value, "2026-08-30T00:01:00Z");
  assert.deepEqual(Object.keys(call.body.record).sort(), [
    "reason",
    "record_key",
    "record_type",
    "resolved_at",
    "result_code",
    "run_id",
  ]);
});

test("kintone: attempt_key競合は再GET後も別identityならfail-closed", async () => {
  const fake = createKintoneFake();
  const repo = repository(fake);
  const state = await repo.upsertNodeState({
    value: makeState(),
    expected_revision: null,
  });
  await repo.createAttempt({
    node_state: state,
    node_attempt_id: "attempt_a",
    invocation_id: "invoke_a",
  });
  await assert.rejects(
    repo.createAttempt({
      node_state: state,
      node_attempt_id: "attempt_b",
      invocation_id: "invoke_b",
    }),
    (error) =>
      error instanceof RepositoryError &&
      error.code === "ATTEMPT_NUMBER_CONFLICT",
  );
});

test("kintone: GAIA_CO02を安定REVISION_CONFLICTへ変換する", async () => {
  const fake = createKintoneFake();
  const repo = repository(fake);
  const run = await repo.createRun(makeRun());
  await repo.updateRunAggregate("run_1", run.revision, {
    status: "RUNNING",
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-30T00:00:01Z",
  });
  await assert.rejects(
    repo.updateRunAggregate("run_1", run.revision, {
      status: "FAILED",
      started_at: null,
      finished_at: null,
      updated_at: "2026-08-30T00:00:02Z",
    }),
    (error) =>
      error instanceof RepositoryError && error.code === "REVISION_CONFLICT",
  );
});

test("kintone: 並行updateKey PUT敗者のGAIA_DA02を再GETしてREVISION_CONFLICTへ裁定する", async () => {
  const fake = createKintoneFake({ staleUpdateReturnsDa02: true });
  const repo = repository(fake);
  const run = await repo.createRun(makeRun());
  const outcomes = await Promise.allSettled([
    repo.updateRunAggregate("run_1", run.revision, {
      status: "RUNNING",
      started_at: null,
      finished_at: null,
      updated_at: "2026-08-30T00:00:01Z",
    }),
    repo.updateRunAggregate("run_1", run.revision, {
      status: "FAILED",
      started_at: null,
      finished_at: null,
      updated_at: "2026-08-30T00:00:02Z",
    }),
  ]);
  const rejected = outcomes.find(({ status }) => status === "rejected");
  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.ok(
    rejected?.reason instanceof RepositoryError &&
      rejected.reason.code === "REVISION_CONFLICT",
  );
  const da02PutIndex = fake.calls.findIndex(
    ({ method, body }) =>
      method === "PUT" && body?.revision === run.revision && body?.record,
  );
  assert.ok(da02PutIndex >= 0);
  assert.ok(
    fake.calls.slice(da02PutIndex + 1).some(({ method }) => method === "GET"),
  );
});

test("kintone: GAIA_DA02後の再GET不能はREMOTE_ERRORへfail-closedする", async () => {
  const fake = createKintoneFake({
    staleUpdateReturnsDa02: true,
    failRereadAfterDa02: true,
  });
  const repo = repository(fake);
  const run = await repo.createRun(makeRun());
  await repo.updateRunAggregate("run_1", run.revision, {
    status: "RUNNING",
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-30T00:00:01Z",
  });
  await assert.rejects(
    repo.updateRunAggregate("run_1", run.revision, {
      status: "FAILED",
      started_at: null,
      finished_at: null,
      updated_at: "2026-08-30T00:00:02Z",
    }),
    (error) =>
      error instanceof RepositoryError && error.code === "REMOTE_ERROR",
  );
});
