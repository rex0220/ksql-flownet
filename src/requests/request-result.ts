import type {
  ChildProcessResult,
  RunNetworkJsonOutput,
} from "./flownet-child-client.js";
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
        )))
  );
}
