// TODO(D-10): replace this conservative limit when the canonical key and
// backing-field limits are frozen.
export const MAX_IDENTIFIER_LENGTH = 128;

// TODO(D-10): replace this conservative limit when the backing business-key
// field and canonical lock-key limits are frozen.
export const MAX_BUSINESS_KEY_LENGTH = 128;

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
  readonly inputs?: Readonly<Record<string, string>>;
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
  readonly code: ValidationErrorCode;
  readonly path: string;
  readonly message: string;
}

export type ValidationErrorCode =
  | "NETWORK_FILE_UNREADABLE"
  | "YAML_PARSE_ERROR"
  | "YAML_VALUE_INVALID"
  | "SCHEMA_INVALID"
  | "UNKNOWN_PROPERTY"
  | "TIMEZONE_INVALID"
  | "FORMAT_PLACEHOLDER_UNSUPPORTED"
  | "FORMAT_PLACEHOLDER_INVALID"
  | "FORMAT_PERIOD_MISMATCH"
  | "NETWORK_LOCK_HEARTBEAT_NOT_LESS_THAN_LEASE"
  | "NETWORK_LOCK_HEARTBEAT_EXCEEDS_ONE_THIRD"
  | "DUPLICATE_NODE_ID"
  | "INPUT_PATTERN_INVALID"
  | "TRIGGER_RULE_UNSUPPORTED"
  | "SELF_DEPENDENCY"
  | "DUPLICATE_DEPENDENCY"
  | "UNKNOWN_DEPENDENCY"
  | "CYCLE_DETECTED"
  | "SQL_FILE_UNREADABLE"
  | "SCHEDULED_FOR_REQUIRED"
  | "SCHEDULED_FOR_NOT_ALLOWED"
  | "SCHEDULED_FOR_INVALID"
  | "BUSINESS_KEY_INPUT_CONFLICT"
  | "BUSINESS_KEY_REQUIRED"
  | "BUSINESS_KEY_NOT_ALLOWED"
  | "BUSINESS_KEY_EMPTY"
  | "BUSINESS_KEY_TOO_LONG"
  | "BUSINESS_KEY_CONTROL_CHARACTER";

export interface ValidationResult {
  readonly definition?: NetworkDefinition;
  readonly errors: readonly ValidationError[];
}
