import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  field,
  getJobLogs,
  runFlowNetCommand,
  runFlowNetNetwork,
  runFlowNetStatus,
  waitFor,
} from "./support.mjs";

const FAULT_HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "fault-hook.mjs",
);
const TERMINAL_JOB_STATUSES = new Set([
  "SUCCESS",
  "FAILED",
  "ABORTED",
  "CANCELLED",
]);

export function faultEnvironment(controlFile, logFile) {
  const importOption = `--import=${pathToFileURL(FAULT_HOOK).href}`;
  const inherited = process.env.NODE_OPTIONS?.trim() ?? "";
  return {
    NODE_OPTIONS: [inherited, importOption].filter(Boolean).join(" "),
    M7_FAULT_CONTROL_FILE: controlFile,
    M7_FAULT_LOG_FILE: logFile,
  };
}

export async function setFaultMode(controlFile, mode) {
  assert.ok(["pass", "block", "block-writes"].includes(mode));
  await writeFile(controlFile, `${mode}\n`, "utf8");
}

export async function readFaultEvents(logFile) {
  const text = await readFile(logFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function waitForBlockedRequest(logFile) {
  return waitFor(
    async () =>
      (await readFaultEvents(logFile)).find(({ blocked }) => blocked) ?? null,
    "M7 fault hook blocked request",
    { timeoutMs: 45_000, intervalMs: 250 },
  );
}

export async function waitForBlockedHeartbeatRequest(logFile) {
  return waitFor(
    async () =>
      (await readFaultEvents(logFile)).find(
        ({ blocked, heartbeat }) => blocked && heartbeat,
      ) ?? null,
    "M7 fault hook blocked heartbeat request",
    { timeoutMs: 45_000, intervalMs: 250 },
  );
}

export async function waitForTerminalJobLog(
  settings,
  attemptId,
  jobId = "m6_longread",
) {
  return waitFor(
    async () => {
      const records = await getJobLogs(
        settings,
        `attempt_id = "${attemptId}" and job_id = "${jobId}" order by $id asc`,
      );
      return (
        records.find((record) =>
          TERMINAL_JOB_STATUSES.has(field(record, "status")),
        ) ?? null
      );
    },
    `terminal JOB log (${jobId}, ${attemptId})`,
    { timeoutMs: 180_000, intervalMs: 1_000 },
  );
}

export async function waitForCompletion(completion, description, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      completion,
      new Promise((_, reject) => {
        timeout = globalThis.setTimeout(
          () =>
            reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function summarizeControlPlaneCalls(events) {
  const summary = {
    total: 0,
    heartbeat: 0,
    blocked: 0,
    byPathAndMethod: {},
    records: { GET: 0, POST: 0, PUT: 0, DELETE: 0 },
    file: 0,
    other: 0,
  };
  for (const event of events.filter(({ targeted }) => targeted)) {
    summary.total += 1;
    if (event.heartbeat) summary.heartbeat += 1;
    if (event.blocked) summary.blocked += 1;
    const key = `${event.method} ${event.path}`;
    summary.byPathAndMethod[key] = (summary.byPathAndMethod[key] ?? 0) + 1;
    if (/\/records?\.json$/u.test(event.path)) {
      summary.records[event.method] = (summary.records[event.method] ?? 0) + 1;
    } else if (/\/file\.json$/u.test(event.path)) {
      summary.file += 1;
    } else {
      summary.other += 1;
    }
  }
  return summary;
}

export async function forceUnlockAndAdjudicate({
  settings,
  fixture,
  runId,
  evidenceRef,
  reason,
}) {
  const reasonFile = join(fixture.directory, "m7-force-unlock-reason.txt");
  await writeFile(reasonFile, `${reason}\n`, "utf8");
  const staleStatus = await waitFor(
    async () => {
      const status = await runFlowNetStatus(settings, fixture.networkId, {
        runId,
      });
      return status.output.lock?.stale_candidate ? status : null;
    },
    "M7 Network lock lease expiry",
    { timeoutMs: 150_000, intervalMs: 1_000 },
  );
  const identifiers =
    staleStatus.output.runs[0].recovery_identifiers.force_unlock_network;
  const released = await runFlowNetCommand(settings, [
    "force-unlock-network",
    identifiers.network_id,
    "--profile",
    identifiers.profile,
    "--expected-owner-invocation-id",
    identifiers.expected_owner_invocation_id,
    "--reason-file",
    reasonFile,
    "--evidence-ref",
    evidenceRef,
    "--stop-confirmed-by",
    "m7-e2e-operator",
    "--stop-evidence-ref",
    evidenceRef,
    "--stop-method",
    "local_pid",
  ]);
  assert.equal(released.exitCode, 0, released.stderr || released.stdout);
  const resumeRun =
    staleStatus.output.runs[0].recovery_identifiers.run_network.resume_run;
  const adjudication = await runFlowNetNetwork(
    settings,
    fixture.networkPath,
    "",
    { resumeRun },
  );
  return {
    staleStatus: staleStatus.output,
    released,
    resumeRun,
    adjudication,
  };
}
