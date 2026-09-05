import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  nodeStateKey,
  runKey,
} from "../../dist/domain/canonical-record-key.js";
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
  loseFirstRunResponse = false,
  staleUpdateReturnsDa02 = false,
  failRereadAfterDa02 = false,
  failRereadAfterRunLoss = false,
  truncateDateTimesOnRead = false,
} = {}) {
  const apps = new Map();
  const calls = [];
  let lost = false;
  let runLost = false;
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
      if (failRereadAfterRunLoss && runLost)
        return response({ code: "GAIA_TM12" }, 503);
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
      const records = recordsFor(app)
        .filter((record) =>
          predicates.every(
            ([code, expected]) =>
              String(record[code]?.value ?? "") === expected,
          ),
        )
        .map((record) => {
          const result = globalThis.structuredClone(record);
          if (truncateDateTimesOnRead) {
            for (const [code, value] of Object.entries(result)) {
              if (code.endsWith("_at") && typeof value.value === "string") {
                value.value = value.value.replace(
                  /:\d{2}(?:\.\d{3})?Z$/,
                  ":00Z",
                );
              }
            }
          }
          return result;
        });
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
        loseFirstRunResponse &&
        body.record.record_type.value === "NETWORK_RUN" &&
        !runLost
      ) {
        runLost = true;
        throw new TypeError("synthetic run response loss after durable insert");
      }
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
  return { fetch, calls, recordsFor };
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
      url.searchParams.get("query")?.includes(runKey("prod", "net", "net@1")),
  );
  assert.equal(
    businessGet.url.searchParams.get("query"),
    `record_key in ("${runKey("prod", "net", "net@1")}")`,
  );
  const put = fake.calls.find(({ method }) => method === "PUT");
  assert.deepEqual(put.body.updateKey, {
    field: "record_key",
    value: runKey("prod", "net", "net@1"),
  });
  assert.equal(put.body.revision, 1);
});

test("kintone: RunのR1重複禁止INSERTを最終裁定にする", async () => {
  const fake = createKintoneFake();
  const repo = repository(fake);
  const outcomes = await Promise.allSettled([
    repo.createRun(makeRun()),
    repo.createRun({ ...makeRun(), run_id: "run_2" }),
  ]);
  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = outcomes.find(({ status }) => status === "rejected");
  assert.ok(
    rejected?.reason instanceof RepositoryError &&
      rejected.reason.code === "DUPLICATE_RECORD",
  );
  const runPosts = fake.calls.filter(
    ({ method, body }) =>
      method === "POST" && body.record.record_type.value === "NETWORK_RUN",
  );
  assert.equal(runPosts.length, 2);
  assert.equal(
    runPosts[0].body.record.record_key.value,
    runKey("prod", "net", "net@1"),
  );
  assert.equal(
    runPosts[1].body.record.record_key.value,
    runPosts[0].body.record.record_key.value,
  );
});

test("kintone: Run INSERT成功応答消失はR1再GETで同一性を裁定する", async () => {
  const fake = createKintoneFake({ loseFirstRunResponse: true });
  const created = await repository(fake).createRun(makeRun());
  assert.equal(created.value.run_id, "run_1");
  assert.ok(
    fake.calls.some(
      ({ method, url }) =>
        method === "GET" &&
        url.searchParams.get("query")?.includes(runKey("prod", "net", "net@1")),
    ),
  );
});

test("kintone: Run INSERT応答消失後のR1再GET不能はfail-closed", async () => {
  const fake = createKintoneFake({
    loseFirstRunResponse: true,
    failRereadAfterRunLoss: true,
  });
  await assert.rejects(
    repository(fake).createRun(makeRun()),
    (error) =>
      error instanceof RepositoryError && error.code === "REMOTE_ERROR",
  );
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

test("kintone: Network lock強制回収監査をJSON reason方式で追記する", async () => {
  const fake = createKintoneFake();
  const repo = repository(fake);
  const audit = {
    event_id: "net_unlock_event-13",
    event_type: "NETWORK_LOCK_FORCE_RELEASED",
    network_id: "monthly",
    profile: "prod",
    lock_key: "N1:lock-key",
    record_id: "1001",
    previous_owner_invocation_id: "invoke-old",
    previous_lease_token: "lease-old",
    previous_heartbeat_at: "2026-08-30T00:58:00Z",
    previous_lease_expires_at: "2026-08-30T00:59:00Z",
    service_principal: "svc",
    requested_by: "requester",
    stop_confirmed_by: "operator",
    stop_method: "manual",
    stop_evidence_ref: "stop://1",
    reason: "confirmed stopped",
    evidence_ref: "incident://1",
    released_at: "2026-08-30T01:00:00Z",
    post_release_revision: 8,
  };
  await repo.appendOperationAudit(audit);
  const call = fake.calls.find(
    ({ method, body }) =>
      method === "POST" &&
      body.record.record_key.value === "OP:net_unlock_event-13",
  );
  assert.equal(call.body.app, 200);
  assert.equal(call.body.record.run_id.value, "");
  assert.equal(
    call.body.record.result_code.value,
    "NETWORK_LOCK_FORCE_RELEASED",
  );
  assert.equal(call.body.record.resolved_at.value, audit.released_at);
  assert.deepEqual(JSON.parse(call.body.record.reason.value), audit);
});

test("kintone: archiveRunとRUN_ARCHIVED監査をround-tripし5項目不一致をAUDIT_CONFLICTにする", async () => {
  const fake = createKintoneFake();
  const repo = repository(fake);
  const created = await repo.createRun({ ...makeRun(), status: "FAILED" });
  const archived = await repo.archiveRun(
    "run_1",
    created.revision,
    "2026-09-05T00:00:00Z",
  );
  assert.equal(archived.value.lifecycle_status, "ARCHIVED");
  const put = fake.calls.find(
    ({ method, body }) =>
      method === "PUT" && body.record.lifecycle_status?.value === "ARCHIVED",
  );
  assert.deepEqual(Object.keys(put.body.record).sort(), [
    "lifecycle_status",
    "updated_at",
  ]);
  const audit = {
    event_id: "archive_fixed",
    event_type: "RUN_ARCHIVED",
    run_id: "run_1",
    result_code: "RUN_ARCHIVED",
    requested_by: "operator",
    reason: "close",
    archived_at: "2026-09-05T00:00:00Z",
    previous_status: "FAILED",
    run_revision_before: created.revision,
    service_principal: "svc",
  };
  await repo.appendOperationAudit(audit);
  assert.deepEqual(
    (await repo.getOperationAuditByEventId(audit.event_id)).value,
    audit,
  );
  const post = fake.calls.find(
    ({ method, body }) =>
      method === "POST" && body.record.record_key.value === "OP:archive_fixed",
  );
  assert.equal(post.body.record.resolved_at.value, audit.archived_at);
  await assert.rejects(
    () => repo.appendOperationAudit({ ...audit, run_revision_before: 99 }),
    (error) =>
      error instanceof RepositoryError && error.code === "AUDIT_CONFLICT",
  );
});

test("kintone: Attempt ResolutionのD-13必須記録を監査appで往復する", async () => {
  const fake = createKintoneFake({ truncateDateTimesOnRead: true });
  const repo = repository(fake);
  const state = await repo.upsertNodeState({
    value: makeState(),
    expected_revision: null,
  });
  const attempt = await repo.createAttempt({
    node_state: state,
    node_attempt_id: "attempt_resolution_1",
    invocation_id: "invoke_1",
  });
  const running = await repo.upsertNodeState({
    value: {
      ...state.value,
      status: "RUNNING",
      latest_attempt_no: 1,
      active_attempt_id: "attempt_resolution_1",
    },
    expected_revision: state.revision,
  });
  await repo.finalizeAttempt("attempt_resolution_1", attempt.revision, {
    status: "UNKNOWN",
    result_code: "RESULT_UNKNOWN",
    runner_execution_started_at: "2026-08-30T00:00:00Z",
    execution_id: "exec_1",
    finished_at: "2026-08-30T00:01:00Z",
    duration_sec: 60,
    error_message: null,
    read_count: 1,
    written_count: 1,
    last_successful_chunk_no: 1,
    last_written_key: "key",
  });
  const unknown = await repo.upsertNodeState({
    value: {
      ...running.value,
      status: "UNKNOWN",
      active_attempt_id: null,
      finished_at: "2026-08-30T00:01:00Z",
    },
    expected_revision: running.revision,
  });
  const resolution = {
    event_type: "ATTEMPT_RESOLVED",
    resolution_type: "NODE_MANUAL_COMPLETION_CONFIRMED",
    attempt_id: "attempt_resolution_1",
    resolved_outcome: "SUCCESS",
    reason: "manual completion",
    evidence_ref: "evidence://1",
    service_principal: "svc",
    requested_by: "operator",
    approved_by: "supervisor",
    stop_confirmed_by: "operator",
    stop_evidence_ref: "stop://1",
    resolved_at: "2026-08-30T00:02:34.567Z",
  };
  await repo.appendResolution(resolution);
  const resolved = await repo.upsertNodeState({
    value: { ...unknown.value, status: "SUCCESS" },
    expected_revision: unknown.revision,
    resolution_event: {
      event_type: "ATTEMPT_RESOLVED",
      attempt_id: resolution.attempt_id,
      resolved_outcome: resolution.resolved_outcome,
      resolved_at: resolution.resolved_at,
    },
  });

  const call = fake.calls.find(
    ({ method, body }) =>
      method === "POST" &&
      body.record.record_type.value === "ATTEMPT_RESOLUTION",
  );
  assert.equal(call.body.record.record_key.value.length, 64);
  assert.deepEqual(JSON.parse(call.body.record.reason.value), {
    resolution_type: "NODE_MANUAL_COMPLETION_CONFIRMED",
    reason: "manual completion",
    stop_confirmed_by: "operator",
    stop_evidence_ref: "stop://1",
    resolved_at: "2026-08-30T00:02:34.567Z",
  });
  assert.deepEqual((await repo.getResolutions("run_1"))[0].value, resolution);
  assert.equal(resolved.value.status, "SUCCESS");

  const storedResolution = fake
    .recordsFor(200)
    .find(({ record_type }) => record_type.value === "ATTEMPT_RESOLUTION");
  const legacyDetails = JSON.parse(storedResolution.reason.value);
  delete legacyDetails.resolved_at;
  storedResolution.reason.value = JSON.stringify(legacyDetails);
  assert.equal(
    (await repo.getResolutions("run_1"))[0].value.resolved_at,
    "2026-08-30T00:02:00Z",
  );
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
