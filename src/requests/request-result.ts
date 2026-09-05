import type {
  ChildProcessResult,
  RunNetworkJsonOutput,
} from "./flownet-child-client.js";
import type { ArchiveRunOutcome } from "../orchestration/archive-run.js";
import type { RequestResult } from "./kintone-request-store.js";

export function classifyRunNetworkResult(input: {
  readonly output: RunNetworkJsonOutput | null;
  readonly process: ChildProcessResult;
}): RequestResult {
  const output = validRunNetworkOutput(input.output) ? input.output : null;
  if (output !== null && output.invocation_id !== null) {
    const retryBrakeNodeIds = output.retry_brake_node_ids ?? [];
    if (retryBrakeNodeIds.length > 0) {
      return {
        state: "DONE",
        code: "RETRY_BRAKE",
        message: `aggregate=${output.aggregate_status ?? "UNKNOWN"}; invocation_id=${output.invocation_id}; retry_brake_node_ids=${retryBrakeNodeIds.join(",")}`,
      };
    }
    return {
      state: "DONE",
      code: output.invocation_result_code,
      message: `aggregate=${output.aggregate_status ?? "UNKNOWN"}; invocation_id=${output.invocation_id}`,
    };
  }
  if (output?.outcome === "NOOP") {
    return {
      state: "DONE",
      code: output.invocation_result_code,
      message: `aggregate=${output.aggregate_status ?? "SUCCESS"}; invocation_id=none`,
    };
  }
  if (input.process.spawnError !== undefined) {
    return rejected(
      "CHILD_SPAWN_FAILED",
      "run-network child could not be started",
    );
  }
  if (output?.outcome === "REJECTED") {
    return rejected(
      output.invocation_result_code,
      "run-network rejected the request before creating an Invocation",
    );
  }
  return rejected(
    "CHILD_RESULT_INVALID",
    "run-network did not return a valid machine-readable result",
  );
}

export function classifyStartNetworkResult(input: {
  readonly output: RunNetworkJsonOutput | null;
  readonly process: ChildProcessResult;
}): RequestResult {
  const output = validRunNetworkOutput(input.output) ? input.output : null;
  if (output !== null && output.invocation_id !== null) {
    return classifyRunNetworkResult(input);
  }
  if (output?.outcome === "NOOP" && output.run_id !== null) {
    return {
      state: "DONE",
      code: "NOOP_ALREADY_SUCCESS",
      message: `既存Run #${output.run_id} はSUCCESSのため起動をスキップしました。補正実行は別のbusiness_keyを指定してください。`,
    };
  }
  if (input.process.spawnError !== undefined) {
    return rejected(
      "CHILD_SPAWN_FAILED",
      "run-network child could not be started",
    );
  }
  if (output?.outcome === "REJECTED") {
    const blockedRunIds = output.blocked_run_ids ?? [];
    if (output.invocation_result_code === "RUN_ALREADY_EXISTS") {
      const runId = blockedRunIds[0];
      return rejected(
        "RUN_ALREADY_EXISTS",
        runId === undefined
          ? "同一業務キーの未完了Runがあります。RERUNを使用してください。"
          : `同一業務キーの未完了Run #${runId} があります。RERUNを使用してください。`,
      );
    }
    if (output.invocation_result_code === "MAX_ACTIVE_RUNS") {
      const runId = blockedRunIds[0] ?? "不明";
      return rejected(
        "MAX_ACTIVE_RUNS",
        `未完了Run #${runId}があるため起動できません。失敗Runのやり直しはRERUNを、整理できない場合は二次対応者へ`,
      );
    }
    if (output.invocation_result_code === "LOCK_CONFLICT") {
      return rejected(
        "LOCK_CONFLICT",
        "network実行ロックが競合しました。時間をおいて再起票してください。",
      );
    }
    return rejected(
      output.invocation_result_code,
      "run-network rejected the START request before creating an Invocation",
    );
  }
  return rejected(
    "CHILD_RESULT_INVALID",
    "run-network did not return a valid machine-readable result",
  );
}

export function classifyCancelResult(
  result: ChildProcessResult,
  release: boolean,
): RequestResult {
  if (result.spawnError !== undefined) {
    return rejected(
      "CHILD_SPAWN_FAILED",
      "cancel-run child could not be started",
    );
  }
  if (result.exitCode === 0) {
    return {
      state: "DONE",
      code: release ? "RELEASED" : "STOP_REQUESTED",
      message: release
        ? "Run hold was released; no automatic resume was started"
        : "Run hold was requested at the next node boundary",
    };
  }
  return rejected(
    "CANCEL_RUN_REJECTED",
    "cancel-run rejected the request or failed before completing the operation",
  );
}

const ARCHIVE_PENDING_CODES = new Set([
  "ARCHIVE_AUDIT_FAILED",
  "AUDIT_CONFLICT",
  "LEASE_INTERRUPTED_AFTER_ARCHIVE",
]);
const ARCHIVE_REJECTED_CODES = new Set([
  "LOCK_CONFLICT",
  "LOCK_UNAVAILABLE",
  "LEASE_INTERRUPTED",
  "RUN_READ_FAILED",
  "RUN_STATUS_NOT_CLOSABLE",
  "RUN_UNKNOWN_NOT_CLOSABLE",
  "RUN_NOT_TERMINAL",
  "RUN_ON_HOLD",
  "RUN_LIVE",
  "ARCHIVE_WRITE_FAILED",
]);

export function classifyArchiveRun(input: {
  readonly output: ArchiveRunOutcome | null;
  readonly process: ChildProcessResult;
}): RequestResult {
  const output = validArchiveRunOutput(input.output) ? input.output : null;
  if (
    output === null ||
    input.process.spawnError !== undefined ||
    input.process.stdoutTruncated ||
    input.process.stderrTruncated ||
    input.process.exitCode !== expectedArchiveExitCode(output)
  ) {
    return rejected(
      "CHILD_RESULT_INVALID",
      "archive-run result was invalid; the Run may already be ARCHIVED, so verify it with status --json",
    );
  }

  const event = `event_id=${output.event_id}`;
  const lockFailure = output.lock_released ? "" : " lock_release_failed=true";
  switch (output.outcome) {
    case "ARCHIVED":
      if (output.audit === "PENDING") {
        return {
          state: "DONE",
          code: "RUN_ARCHIVED_AUDIT_PENDING",
          message: `code=${output.code} ${event}${lockFailure}`,
        };
      }
      if (!output.lock_released) {
        return {
          state: "DONE",
          code: "RUN_ARCHIVED_LOCK_UNRELEASED",
          message: `${event} lock_release_failed=true`,
        };
      }
      return {
        state: "DONE",
        code: "RUN_ARCHIVED",
        message: event,
      };
    case "ALREADY_ARCHIVED":
      return output.lock_released
        ? {
            state: "DONE",
            code: "RUN_ALREADY_ARCHIVED",
            message: event,
          }
        : {
            state: "DONE",
            code: "RUN_ARCHIVED_LOCK_UNRELEASED",
            message: `${event} already_archived=true lock_release_failed=true`,
          };
    case "UNCONFIRMED":
      return rejected(
        "ARCHIVE_UNCONFIRMED",
        `Run archive state is unconfirmed; verify it with status --json ${event}${lockFailure}`,
      );
    case "REJECTED":
      return rejected(output.code, `${event}${lockFailure}`);
  }
}

export function rejected(code: string, message: string): RequestResult {
  return { state: "REJECTED", code, message };
}

function validRunNetworkOutput(
  value: RunNetworkJsonOutput | null,
): value is RunNetworkJsonOutput {
  return (
    value !== null &&
    ["NEW", "RESUME", "NOOP", "REJECTED"].includes(value.outcome) &&
    (typeof value.run_id === "string" || value.run_id === null) &&
    (typeof value.invocation_id === "string" || value.invocation_id === null) &&
    (typeof value.aggregate_status === "string" ||
      value.aggregate_status === null) &&
    typeof value.invocation_result_code === "string" &&
    value.invocation_result_code !== "" &&
    (value.retry_brake_node_ids === undefined ||
      (Array.isArray(value.retry_brake_node_ids) &&
        value.retry_brake_node_ids.every(
          (nodeId) => typeof nodeId === "string",
        ))) &&
    (value.blocked_run_ids === undefined ||
      (Array.isArray(value.blocked_run_ids) &&
        value.blocked_run_ids.every((runId) => typeof runId === "string")))
  );
}

function expectedArchiveExitCode(output: ArchiveRunOutcome): number {
  return (output.outcome === "ARCHIVED" &&
    output.audit === "RECORDED" &&
    output.lock_released) ||
    (output.outcome === "ALREADY_ARCHIVED" && output.lock_released)
    ? 0
    : 1;
}

function validArchiveRunOutput(
  value: ArchiveRunOutcome | null,
): value is ArchiveRunOutcome {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.run_id !== "string" ||
    value.run_id === "" ||
    typeof value.event_id !== "string" ||
    value.event_id === "" ||
    typeof value.lock_released !== "boolean"
  ) {
    return false;
  }
  const revision = value.run_revision;
  switch (value.outcome) {
    case "ARCHIVED":
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        return false;
      if (value.audit === "RECORDED") return !("code" in value);
      return (
        value.audit === "PENDING" &&
        "code" in value &&
        ARCHIVE_PENDING_CODES.has(value.code)
      );
    case "ALREADY_ARCHIVED":
      return (
        typeof revision === "number" &&
        Number.isSafeInteger(revision) &&
        revision >= 1 &&
        !("code" in value)
      );
    case "UNCONFIRMED":
      return revision === null && value.code === "ARCHIVE_UNCONFIRMED";
    case "REJECTED":
      return (
        (revision === null ||
          (typeof revision === "number" &&
            Number.isSafeInteger(revision) &&
            revision >= 1)) &&
        ARCHIVE_REJECTED_CODES.has(value.code)
      );
    default:
      return false;
  }
}
