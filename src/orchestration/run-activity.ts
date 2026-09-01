import type {
  CancelRequestState,
  NetworkRun,
} from "../domain/persistence-model.js";
import { KINTONE_DATETIME_TRUNCATION_MS } from "../persistence/kintone/design-notes.js";
import type { NetworkLockStatus } from "../persistence/network-lock-reader.js";

export type RunActivity = "LIVE" | "IDLE" | "INTERRUPTED" | "STOPPED";

export interface ActivityInput {
  readonly status: NetworkRun["status"];
  readonly startedAt: string | null;
  readonly invocationIds: readonly string[];
  readonly lock: NetworkLockStatus | null;
  readonly cancelState: CancelRequestState | null;
  readonly nowMs: number;
}

export function deriveRunActivity(input: ActivityInput): RunActivity | null {
  if (["SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"].includes(input.status))
    return null;
  if (input.cancelState === "REQUESTED" || input.cancelState === "ACCEPTED")
    return "STOPPED";
  if (
    input.lock !== null &&
    input.invocationIds.includes(input.lock.owner_invocation_id) &&
    input.nowMs <=
      Date.parse(input.lock.lease_expires_at) + KINTONE_DATETIME_TRUNCATION_MS
  )
    return "LIVE";
  return input.startedAt === null ? "IDLE" : "INTERRUPTED";
}
