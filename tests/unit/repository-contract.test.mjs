import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";
import { KintonePersistenceRepository } from "../../dist/persistence/kintone/repository.js";
import { RepositoryError } from "../../dist/persistence/repository.js";

function state() {
  return {
    node_state_id: "state_contract",
    node_state_key: nodeStateKey("run_contract", "node_contract"),
    run_id: "run_contract",
    node_id: "node_contract",
    job_id: "job_contract",
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

function kintoneFetchFake() {
  const apps = new Map();
  const records = (app) => {
    if (!apps.has(app)) apps.set(app, []);
    return apps.get(app);
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  return async (input, init) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "GET") {
      const query = url.searchParams.get("query");
      const predicates = [
        ...query.matchAll(/([a-z_$]+) in \("([^"]*)"\)/g),
      ].map((match) => [match[1], match[2]]);
      return json({
        records: records(Number(url.searchParams.get("app"))).filter((record) =>
          predicates.every(
            ([code, value]) => String(record[code]?.value ?? "") === value,
          ),
        ),
      });
    }
    if (init.method === "POST") {
      const appRecords = records(body.app);
      if (
        appRecords.some(
          (record) =>
            record.record_key.value === body.record.record_key.value ||
            (body.record.attempt_key &&
              record.attempt_key?.value === body.record.attempt_key.value),
        )
      ) {
        return json({ code: "CB_VA01" }, 400);
      }
      appRecords.push({ ...body.record, $revision: { value: "1" } });
      return json({ id: String(appRecords.length), revision: "1" });
    }
    if (init.method === "PUT") {
      const record = records(body.app).find(
        (candidate) => candidate.record_key.value === body.updateKey.value,
      );
      if (Number(record.$revision.value) !== body.revision)
        return json({ code: "GAIA_CO02" }, 409);
      const revision = String(Number(record.$revision.value) + 1);
      Object.assign(record, body.record, { $revision: { value: revision } });
      return json({ revision });
    }
    throw new Error(`unexpected ${init.method}`);
  };
}

const implementations = [
  ["in-memory fake", () => new InMemoryPersistenceRepository()],
  [
    "kintone fetch mock",
    () =>
      new KintonePersistenceRepository({
        baseUrl: "https://example.cybozu.com",
        stateAppId: 10,
        stateApiToken: "state",
        auditAppId: 20,
        auditApiToken: "audit",
        fetch: kintoneFetchFake(),
      }),
  ],
];

for (const [name, create] of implementations) {
  test(`repository component contract: ${name}`, async () => {
    const repository = create();
    const waiting = await repository.upsertNodeState({
      value: state(),
      expected_revision: null,
    });
    const attempt = await repository.createAttempt({
      node_state: waiting,
      node_attempt_id: "attempt_contract",
      invocation_id: "invoke_contract",
    });
    const runningState = await repository.upsertNodeState({
      value: {
        ...waiting.value,
        status: "RUNNING",
        latest_attempt_no: 1,
        active_attempt_id: "attempt_contract",
      },
      expected_revision: waiting.revision,
    });
    const started = await repository.setAttemptExecutionStarted(
      "attempt_contract",
      attempt.revision,
      { execution_started_at: "2026-08-30T00:01:00Z" },
    );
    const terminalAttempt = await repository.finalizeAttempt(
      "attempt_contract",
      started.revision,
      {
        status: "SUCCESS",
        result_code: "OK",
        runner_execution_started_at: "2026-08-30T00:01:00Z",
        execution_id: "exec_contract",
        finished_at: "2026-08-30T00:02:00Z",
        duration_sec: 60,
        error_message: null,
        read_count: 1,
        written_count: 1,
        last_successful_chunk_no: 1,
        last_written_key: "K1",
      },
    );
    const terminalState = await repository.upsertNodeState({
      value: {
        ...runningState.value,
        status: "SUCCESS",
        active_attempt_id: null,
        finished_at: "2026-08-30T00:02:00Z",
      },
      expected_revision: runningState.revision,
    });
    assert.equal(terminalAttempt.value.status, terminalState.value.status);
    await assert.rejects(
      repository.finalizeAttempt("attempt_contract", terminalAttempt.revision, {
        status: "FAILED",
        result_code: "LATE",
        runner_execution_started_at: null,
        execution_id: null,
        finished_at: "2026-08-30T00:03:00Z",
        duration_sec: null,
        error_message: null,
        read_count: 0,
        written_count: 0,
        last_successful_chunk_no: null,
        last_written_key: null,
      }),
      (error) =>
        error instanceof RepositoryError && error.code === "ATTEMPT_TERMINAL",
    );
  });
}
