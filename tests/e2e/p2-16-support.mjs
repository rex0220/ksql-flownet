import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  field,
  getAllPersistenceRecords,
  runFlowNetCommand,
  runFlowNetStatus,
  waitFor,
} from "./support.mjs";
import {
  createRequest,
  getRequest,
  P2_01_PREFIX,
  requestReason,
} from "./p2-01-support.mjs";
import { faultEnvironment, readFaultEvents } from "./m7-support.mjs";

const ARCHIVED_AUDIT_FIELDS = [
  "requested_by",
  "reason",
  "archived_at",
  "previous_status",
  "run_revision_before",
];

function assertFixtureValue(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.startsWith(P2_01_PREFIX), `${label} must use the E2E prefix`);
}

export function buildFaultControl({
  barrierId,
  app,
  recordId,
  field: fieldName,
  phase,
  release,
}) {
  assertFixtureValue(barrierId, "barrierId");
  assert.ok(Number.isSafeInteger(app) && app > 0, "app must be positive");
  if (recordId !== undefined)
    assert.ok(String(recordId).length > 0, "recordId must not be empty");
  assert.equal(typeof fieldName, "string");
  assert.ok(fieldName.length > 0, "field is required");
  assert.ok(["before", "after-success"].includes(phase));
  assert.ok(isAbsolute(release), "release must be an absolute path");
  return {
    mode: "pass",
    barriers: [
      {
        id: barrierId,
        match: {
          path: "^/k/v1/record\\.json$",
          method: "PUT",
          body: {
            app,
            field: fieldName,
            ...(recordId === undefined ? {} : { id: String(recordId) }),
          },
        },
        phase,
        release,
      },
    ],
  };
}

export function extractRunArchivedAuditFields(reasonJson) {
  const value =
    typeof reasonJson === "string" ? JSON.parse(reasonJson) : reasonJson;
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const extracted = Object.fromEntries(
    ARCHIVED_AUDIT_FIELDS.map((name) => {
      assert.ok(Object.hasOwn(value, name), `RUN_ARCHIVED audit lacks ${name}`);
      return [name, value[name]];
    }),
  );
  assert.equal(typeof extracted.requested_by, "string");
  assert.equal(typeof extracted.reason, "string");
  assert.match(extracted.archived_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(["FAILED", "CANCELLED"].includes(extracted.previous_status));
  assert.ok(
    Number.isSafeInteger(extracted.run_revision_before) &&
      extracted.run_revision_before > 0,
  );
  return extracted;
}

export async function createCloseRequest(settings, scope, label, runId) {
  assertFixtureValue(scope, "scope");
  assert.ok(runId);
  return createRequest(settings, {
    requestType: "CLOSE",
    runId,
    reason: requestReason(scope, label),
  });
}

export async function putCancelRequested(settings, request) {
  const url = new globalThis.URL("/k/v1/record.json", `${settings.baseUrl}/`);
  const response = await globalThis.fetch(url, {
    method: "PUT",
    headers: {
      "X-Cybozu-API-Token": settings.requestApiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app: settings.requestAppId,
      id: request.id,
      revision: request.revision,
      record: { cancel_requested: { value: ["取消"] } },
    }),
  });
  if (response.status === 409) return { status: 409, request: null };
  assert.ok(
    response.ok,
    `cancel_requested PUT failed with HTTP ${response.status}`,
  );
  return {
    status: response.status,
    request: await getRequest(settings, request.id),
  };
}

export async function loadRunLifecycle(settings, runId) {
  const records = (
    await getAllPersistenceRecords(
      settings,
      "state",
      `record_type in ("NETWORK_RUN") and run_id = "${runId}"`,
    )
  ).filter(
    (record) =>
      field(record, "record_type") === "NETWORK_RUN" &&
      field(record, "run_id") === runId,
  );
  assert.equal(records.length, 1, `NETWORK_RUN ${runId} must be unique`);
  return {
    recordId: field(records[0], "$id"),
    revision: Number(field(records[0], "$revision")),
    status: field(records[0], "status"),
    lifecycleStatus: field(records[0], "lifecycle_status"),
  };
}

export async function loadRunArchivedAudits(settings, runId) {
  const records = await getAllPersistenceRecords(
    settings,
    "audit",
    `record_type in ("OPERATION_AUDIT") and run_id = "${runId}"`,
  );
  return records
    .filter(
      (record) =>
        field(record, "record_type") === "OPERATION_AUDIT" &&
        field(record, "run_id") === runId &&
        field(record, "result_code") === "RUN_ARCHIVED",
    )
    .map((record) => {
      const reasonJson = field(record, "reason");
      const value = JSON.parse(reasonJson);
      return {
        recordId: field(record, "$id"),
        eventId: value.event_id,
        resolvedAt: field(record, "resolved_at"),
        ...extractRunArchivedAuditFields(value),
      };
    });
}

export async function getRunHold(settings, networkId, runId) {
  const status = await runFlowNetStatus(settings, networkId, { runId });
  const runs = status.output.runs.filter((run) => run.run_id === runId);
  assert.equal(runs.length, 1, `status must return Run ${runId}`);
  return { process: status.process, hold: runs[0].hold, run: runs[0] };
}

export async function prepareFaultBarrier(directory, input) {
  const controlFile = join(directory, `${input.label}-fault-control.json`);
  const logFile = join(directory, `${input.label}-fault-log.jsonl`);
  const releaseFile = join(directory, `${input.label}.release`);
  await Promise.all([
    rm(controlFile, { force: true }),
    rm(logFile, { force: true }),
    rm(releaseFile, { force: true }),
  ]);
  const control = buildFaultControl({ ...input, release: releaseFile });
  await writeFile(controlFile, `${JSON.stringify(control, null, 2)}\n`, "utf8");
  return {
    barrierId: input.barrierId,
    phase: input.phase,
    controlFile,
    logFile,
    releaseFile,
    environment: faultEnvironment(controlFile, logFile),
  };
}

export async function waitForBarrier(barrier) {
  return waitFor(
    async () =>
      (await readFaultEvents(barrier.logFile)).find(
        (event) => event.barrier_id === barrier.barrierId,
      ) ?? null,
    `fault barrier ${barrier.barrierId}`,
    { timeoutMs: 60_000, intervalMs: 100 },
  );
}

export async function releaseFaultBarrier(barrier) {
  await writeFile(barrier.releaseFile, "release\n", "utf8");
}

export async function cleanupFaultBarrier(barrier) {
  if (!barrier) return;
  await Promise.all([
    rm(barrier.controlFile, { force: true }),
    rm(barrier.logFile, { force: true }),
    rm(barrier.releaseFile, { force: true }),
  ]);
}

export async function runArchiveRun(
  settings,
  networkPath,
  runId,
  { requestedBy = `${P2_01_PREFIX}archive-harness`, reason } = {},
) {
  assertFixtureValue(requestedBy, "requestedBy");
  assertFixtureValue(reason, "reason");
  const directory = await mkdtemp(join(tmpdir(), "ksql-flow-test-archive-"));
  const reasonFile = join(directory, "reason.txt");
  try {
    await writeFile(reasonFile, `${reason}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const process = await runFlowNetCommand(
      settings,
      [
        "archive-run",
        networkPath,
        "--run-id",
        runId,
        "--reason-file",
        reasonFile,
        "--profile",
        settings.profile,
      ],
      { environment: { KSQL_FLOWNET_REQUESTED_BY: requestedBy } },
    );
    let output = null;
    if (process.stdout.trim() !== "") output = JSON.parse(process.stdout);
    return { process, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function networkLockSnapshot(settings) {
  const records = await getAllPersistenceRecords(
    settings,
    "state",
    'record_type in ("NETWORK_LOCK")',
  );
  return Object.fromEntries(
    records.map((record) => [
      field(record, "$id"),
      {
        revision: Number(field(record, "$revision")),
        recordKey: field(record, "record_key"),
        lockKey: field(record, "lock_key"),
        status: field(record, "status"),
      },
    ]),
  );
}

export function summarizeRequest(request) {
  return {
    id: request.id,
    requestType: request.requestType,
    requestState: request.requestState,
    cancelRequested: request.cancelRequested,
    claimedAt: request.claimedAt,
    resultCode: request.resultCode,
    hasResultMessage: Boolean(request.resultMessage),
  };
}

export function summarizeProcess(process) {
  return {
    exitCode: process.exitCode,
    signal: process.signal,
    stdoutPresent: process.stdout.trim() !== "",
    stderrPresent: process.stderr.trim() !== "",
  };
}

export async function readFaultBarrierEvents(barrier) {
  return (await readFaultEvents(barrier.logFile)).filter(
    (event) => event.barrier_id === barrier.barrierId,
  );
}
