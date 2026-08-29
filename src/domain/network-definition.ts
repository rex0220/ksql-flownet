// TODO(D-10): replace this conservative limit when the canonical key and
// backing-field limits are frozen.
export const MAX_IDENTIFIER_LENGTH = 128;

export type TriggerRule = "all_success" | "none_failed" | "all_done";

export interface ScheduledPeriodPolicy {
  readonly type: "scheduled_period";
  readonly period: "day" | "month";
  readonly timezone: string;
  readonly format: string;
}

export interface ExplicitPolicy {
  readonly type: "explicit";
}

export type BusinessKeyPolicy = ScheduledPeriodPolicy | ExplicitPolicy;

export interface NetworkLockDefinition {
  readonly lease_duration_sec: number;
  readonly heartbeat_interval_sec: number;
}

export interface NetworkNodeDefinition {
  readonly id: string;
  readonly job_id: string;
  readonly sql: string;
  readonly depends_on: readonly string[];
  readonly trigger_rule: TriggerRule;
  readonly idempotent: boolean;
}

export interface NetworkDefinition {
  readonly schema_version: 1;
  readonly network_id: string;
  readonly description?: string;
  readonly business_key_policy: BusinessKeyPolicy;
  readonly max_active_runs: number;
  readonly network_lock: NetworkLockDefinition;
  readonly nodes: readonly NetworkNodeDefinition[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly definition?: NetworkDefinition;
  readonly errors: readonly ValidationError[];
}
