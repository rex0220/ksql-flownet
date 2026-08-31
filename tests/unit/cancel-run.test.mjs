import assert from "node:assert/strict";
import test from "node:test";

import { runCancelRunCommand } from "../../dist/cli/cancel-run-command.js";
import { changeCancelRequest } from "../../dist/orchestration/cancel-request.js";
import { InMemoryPersistenceRepository } from "../../dist/persistence/in-memory-repository.js";

const T0 = "2026-08-31T00:00:00.000Z";

function run(status = "RUNNING") {
  return {
    run_id: "run_1",
    network_id: "net",
    business_key: "net@1",
    max_active_runs: 1,
    status,
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: null,
    definition_schema_version: 1,
    definition_sha256: "a".repeat(64),
    source_bundle_sha256: "b".repeat(64),
    source_bundle_attachment: "file",
    resolved_profile_snapshot: {
      profile: "prod",
      base_url: "https://example.cybozu.com",
      guest_space_id: null,
      timezone: "Asia/Tokyo",
      apps: {},
      limits: {
        max_api_calls: null,
        max_read_rows: null,
        batch_timeout_sec: null,
      },
    },
    resolved_profile_sha256: "c".repeat(64),
    ksql_flow_version: "1",
    engine_version: "3",
    dialect: 1,
    created_at: T0,
    started_at: T0,
    finished_at: null,
    updated_at: T0,
  };
}

test("cancel request state machine reuses one fenced record and is idempotent", async () => {
  const repository = new InMemoryPersistenceRepository();
  await repository.createRun(run());
  const request = await changeCancelRequest({
    repository,
    runId: "run_1",
    requestedBy: "operator",
    reason: "stop",
    release: false,
    now: () => new Date(T0),
  });
  assert.equal(request.value.state, "REQUESTED");
  assert.equal(
    (
      await changeCancelRequest({
        repository,
        runId: "run_1",
        requestedBy: "other",
        reason: "duplicate",
        release: false,
      })
    ).revision,
    request.revision,
  );
  const accepted = await repository.updateCancelRequest(
    "run_1",
    request.revision,
    {
      ...request.value,
      state: "ACCEPTED",
      accepted_at: T0,
    },
  );
  const released = await changeCancelRequest({
    repository,
    runId: "run_1",
    requestedBy: "operator",
    reason: "resume",
    release: true,
    now: () => new Date(T0),
  });
  assert.equal(released.value.state, "RELEASED");
  assert.equal(released.value.release_reason, "resume");
  const requestedAgain = await changeCancelRequest({
    repository,
    runId: "run_1",
    requestedBy: "operator-2",
    reason: "stop again",
    release: false,
    now: () => new Date(T0),
  });
  assert.equal(requestedAgain.value.state, "REQUESTED");
  assert.equal(requestedAgain.revision, accepted.revision + 2);
});

test("a new request for a terminal Run is rejected with RUN_ALREADY_TERMINAL", async () => {
  const repository = new InMemoryPersistenceRepository();
  await repository.createRun(run("SUCCESS"));
  await assert.rejects(
    changeCancelRequest({
      repository,
      runId: "run_1",
      requestedBy: "operator",
      reason: "too late",
      release: false,
    }),
    (error) => error.code === "RUN_ALREADY_TERMINAL",
  );
});

test("cancel-run CLI validates arguments and renders idempotent state", async (context) => {
  const repository = new InMemoryPersistenceRepository();
  await repository.createRun(run());
  const stdout = [];
  context.mock.method(process.stdout, "write", (value) =>
    stdout.push(String(value)),
  );
  assert.equal(
    await runCancelRunCommand(
      ["--run-id", "run_1", "--reason-file", "reason.txt"],
      {
        repository,
        requestedBy: "operator",
        readFile: () => "maintenance",
        now: () => new Date(T0),
      },
    ),
    0,
  );
  assert.match(stdout.at(-1), /^REQUESTED: CANCEL:run_1/u);
});
