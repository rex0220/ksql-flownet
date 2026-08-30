import type { NodeStateStatus } from "../domain/persistence-model.js";

const ALLOWED_TRANSITIONS: Readonly<
  Record<NodeStateStatus, ReadonlySet<NodeStateStatus>>
> = {
  WAITING: new Set(["WAITING", "RUNNING", "BLOCKED"]),
  RUNNING: new Set([
    "RUNNING",
    "WAITING",
    "SUCCESS",
    "FAILED",
    "CANCELLED",
    "UNKNOWN",
  ]),
  SUCCESS: new Set(["SUCCESS", "WAITING"]),
  FAILED: new Set(["FAILED", "WAITING"]),
  BLOCKED: new Set(["BLOCKED", "WAITING"]),
  SKIPPED: new Set(["SKIPPED"]),
  CANCELLED: new Set(["CANCELLED", "WAITING"]),
  UNKNOWN: new Set(["UNKNOWN", "SUCCESS", "FAILED", "CANCELLED"]),
};

export function isAllowedNodeStateTransition(
  from: NodeStateStatus,
  to: NodeStateStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
