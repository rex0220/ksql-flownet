import assert from "node:assert/strict";
import test from "node:test";

import { runRecordJobUnlockCommand } from "../../dist/cli/record-job-unlock-command.js";
import { runResolveNodeCommand } from "../../dist/cli/resolve-node-command.js";

function commandRepository(status = "UNKNOWN", idempotent = false) {
  const resolutions = [];
  const audits = [];
  const state = {
    value: {
      node_state_id: "state_1",
      node_state_key: "S1:state",
      run_id: "run_1",
      node_id: "node_1",
      job_id: "job_1",
      status,
      latest_attempt_no: 1,
      active_attempt_id: null,
      revision: 3,
      idempotent,
      trigger_rule: "all_success",
      blocked_by: [],
      status_reason: null,
      started_at: "2026-08-30T00:00:00Z",
      finished_at: "2026-08-30T00:01:00Z",
      updated_at: "2026-08-30T00:01:00Z",
    },
    revision: 3,
  };
  return {
    resolutions,
    audits,
    async getRun() {
      return {
        value: { resolved_profile_snapshot: { profile: "prod" } },
        revision: 1,
      };
    },
    async getNodeStates() {
      return [state];
    },
    async getAttempts() {
      return [
        {
          value: {
            node_attempt_id: "attempt_1",
            node_id: "node_1",
            attempt_no: 1,
            status,
          },
          revision: 2,
        },
      ];
    },
    async appendResolution(value) {
      resolutions.push(value);
      return { value, revision: 1 };
    },
    async upsertNodeState(write) {
      state.value = { ...write.value, revision: 4 };
      state.revision = 4;
      return state;
    },
    async appendOperationAudit(value) {
      audits.push(value);
      return { value, revision: 1 };
    },
  };
}

test("resolve-node CLI maps required audit options and uses environment-derived principals from dependencies", async (context) => {
  const repository = commandRepository();
  context.mock.method(process.stdout, "write", () => true);
  assert.equal(
    await runResolveNodeCommand(
      [
        "--run-id",
        "run_1",
        "--node-id",
        "node_1",
        "--to",
        "SUCCESS",
        "--reason-file",
        "reason.txt",
        "--evidence-ref",
        "evidence://1",
        "--stop-confirmed-by",
        "operator",
        "--stop-evidence-ref",
        "stop://1",
        "--manual-completion",
        "--approved-by",
        "supervisor",
      ],
      {
        repository,
        servicePrincipal: "svc",
        requestedBy: "operator",
        readFile: () => "manual completion evidence",
        now: () => new Date("2026-08-30T00:02:00Z"),
      },
    ),
    0,
  );
  assert.equal(repository.resolutions[0].service_principal, "svc");
  assert.equal(repository.resolutions[0].requested_by, "operator");
  assert.equal(repository.resolutions[0].approved_by, "supervisor");
});

test("record-job-unlock CLI validates and links the producer JSON", async (context) => {
  const repository = commandRepository();
  context.mock.method(process.stdout, "write", () => true);
  const result = JSON.stringify({
    kind: "LOCK_RECOVERY_RESULT",
    formatVersion: 1,
    jobKey: "prod:job_1",
    recordId: null,
    outcome: "NOT_FOUND",
    before: null,
    executedAt: "2026-08-30T00:02:00Z",
  });
  assert.equal(
    await runRecordJobUnlockCommand(
      [
        "--result-file",
        "result.json",
        "--run-id",
        "run_1",
        "--node-id",
        "node_1",
        "--reason-file",
        "reason.txt",
        "--evidence-ref",
        "incident://1",
        "--stop-confirmed-by",
        "operator",
      ],
      {
        repository,
        servicePrincipal: "svc",
        requestedBy: "operator",
        readFile: (path) => (path === "result.json" ? result : "stopped"),
        now: () => new Date("2026-08-30T00:03:00Z"),
        uuid: () => "audit-1",
      },
    ),
    0,
  );
  assert.equal(
    repository.audits[0].event_type,
    "JOB_LOCK_FORCE_UNLOCK_RECORDED",
  );
  assert.equal(repository.audits[0].lock_recovery_result.outcome, "NOT_FOUND");
});
