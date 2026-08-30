import type { NetworkRunStatus, NodeStateStatus } from "./persistence-model.js";

export function computeRunAggregateStatus(
  nodeStates: readonly NodeStateStatus[],
  startedAt: string | null,
): NetworkRunStatus {
  if (nodeStates.includes("UNKNOWN")) return "UNKNOWN";
  if (nodeStates.includes("RUNNING")) return "RUNNING";
  if (nodeStates.some((status) => status === "FAILED" || status === "BLOCKED"))
    return "FAILED";
  if (nodeStates.includes("CANCELLED")) return "CANCELLED";
  if (
    nodeStates.length > 0 &&
    nodeStates.every((status) => status === "SUCCESS")
  )
    return "SUCCESS";
  return startedAt === null ? "CREATED" : "RUNNING";
}
