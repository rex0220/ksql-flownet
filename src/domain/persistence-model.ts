import type { CanonicalRecordKey } from "./canonical-record-key.js";

export type NodeStateStatus =
  | "WAITING"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "BLOCKED"
  | "SKIPPED"
  | "CANCELLED"
  | "UNKNOWN";

export type NodeAttemptStatus =
  "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "UNKNOWN";

export type NetworkRunStatus =
  "CREATED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "UNKNOWN";

export type RunInvocationStatus =
  "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "UNKNOWN";

export interface ResolvedProfileSnapshot {
  profile: string;
  base_url: string;
  guest_space_id: number | null;
  timezone: string;
  apps: Record<string, number>;
  limits: {
    max_api_calls: number;
    max_read_rows: number;
    batch_timeout_sec: number;
  };
}

export interface NetworkRun {
  run_id: string;
  network_id: string;
  business_key: string;
  max_active_runs: number;
  status: NetworkRunStatus;
  lifecycle_status: "ACTIVE" | "ARCHIVED";
  resume_allowed: boolean;
  as_of: string | null;
  definition_schema_version: number;
  definition_sha256: string;
  source_bundle_sha256: string;
  source_bundle_attachment: string;
  resolved_profile_snapshot: ResolvedProfileSnapshot;
  resolved_profile_sha256: string;
  ksql_flow_version: string;
  engine_version: string;
  dialect: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface RunInvocation {
  invocation_id: string;
  run_id: string;
  mode: "NEW" | "RESUME" | "RERUN_FROM";
  requested_by: string;
  host: string;
  started_at: string;
  finished_at: string | null;
  status: RunInvocationStatus;
  result_code: string;
  selected_node_ids: string[];
  preserved_node_ids: string[];
  blocked_node_ids: string[];
  reason: string;
}

export interface NodeState {
  node_state_id: string;
  node_state_key: CanonicalRecordKey<"S1">;
  run_id: string;
  node_id: string;
  job_id: string;
  status: NodeStateStatus;
  latest_attempt_no: number;
  active_attempt_id: string | null;
  revision: number;
  idempotent: boolean;
  trigger_rule: "all_success";
  blocked_by: string[];
  status_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface NodeAttempt {
  node_attempt_id: string;
  attempt_key: CanonicalRecordKey<"A1">;
  run_id: string;
  node_id: string;
  job_id: string;
  invocation_id: string;
  attempt_no: number;
  status: NodeAttemptStatus;
  result_code: string;
  execution_started_at: string | null;
  runner_execution_started_at: string | null;
  execution_id: string | null;
  finished_at: string | null;
  duration_sec: number | null;
  error_message: string | null;
  read_count: number;
  written_count: number;
  last_successful_chunk_no: number | null;
  last_written_key: string | null;
  /** D-09 start-protocol evidence. */
  state_revision_before: number | null;
}

export interface AttemptResolution {
  event_type:
    | "ATTEMPT_RESOLVED"
    | "NODE_MANUAL_COMPLETION_CONFIRMED"
    | "NODE_COMPENSATION_COMPLETED";
  attempt_id: string;
  resolved_outcome: "SUCCESS" | "FAILED" | "CANCELLED";
  evidence_ref: string;
  service_principal: string;
  requested_by: string;
  approved_by: string;
  resolved_at: string;
}
