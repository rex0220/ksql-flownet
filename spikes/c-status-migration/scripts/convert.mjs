export class StatusMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StatusMigrationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StatusMigrationError(code, message);
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("MIGRATION_INPUT_INCOMPLETE", `${name} must be an object`);
  }
  return value;
}

function requireExact(value, expected, name) {
  if (value !== expected) {
    fail(
      "MIGRATION_COMBINATION_UNKNOWN",
      `${name} must be ${JSON.stringify(expected)} for this migration path`,
    );
  }
}

function requireCommon(input, recordType, actorType) {
  requireExact(input.record_type, recordType, "record_type");
  requireExact(input.timeout_source, "none", "timeout_source");
  const actor = requireObject(input.actor, "actor");
  requireExact(actor.type, actorType, "actor.type");
  requireExact(actor.authenticated, true, "actor.authenticated");
  return requireObject(input.log_detail, "log_detail");
}

function nodeState(status, resultCode) {
  return {
    new_node_state_status: status,
    result_code: resultCode,
    result_destination: "node_state",
  };
}

/**
 * Convert one legacy log classification into the D-06 Node State result.
 * The function deliberately accepts only evidenced combinations.
 */
export function convertStatusMigration(input) {
  requireObject(input, "input");

  switch (input.current_status) {
    case "SUCCESS": {
      const detail = requireCommon(input, "JOB", "ksql_flow_runner");
      requireExact(detail.outcome, "completed", "log_detail.outcome");
      requireExact(detail.error_category, null, "log_detail.error_category");
      return nodeState("SUCCESS", "OK");
    }
    case "NO_DATA": {
      const detail = requireCommon(input, "JOB", "ksql_flow_runner");
      requireExact(detail.outcome, "no_target_records", "log_detail.outcome");
      requireExact(detail.error_category, null, "log_detail.error_category");
      return nodeState("SUCCESS", "NO_DATA");
    }
    case "ABORTED": {
      const detail = requireCommon(input, "JOB", "ksql_flow_runner");
      requireExact(
        detail.outcome,
        "assert_condition_failed",
        "log_detail.outcome",
      );
      requireExact(
        detail.error_category,
        "ASSERT",
        "log_detail.error_category",
      );
      return nodeState("FAILED", "ASSERT_FAILED");
    }
    case "FAILED": {
      const detail = requireCommon(input, "JOB", "ksql_flow_runner");
      const failures = {
        SQL: ["execution_error", "SQL_ERROR"],
        API: ["request_failed_after_retry", "API_ERROR"],
        AUTH: ["authentication_or_permission_error", "AUTH_ERROR"],
      };
      const classified = failures[detail.error_category];
      if (!classified) {
        fail(
          "MIGRATION_COMBINATION_UNKNOWN",
          "log_detail.error_category is not a classified FAILED cause",
        );
      }
      requireExact(detail.outcome, classified[0], "log_detail.outcome");
      return nodeState("FAILED", classified[1]);
    }
    case "TIMEOUT": {
      const detail = requireObject(input.log_detail, "log_detail");
      const actor = requireObject(input.actor, "actor");
      requireExact(actor.authenticated, true, "actor.authenticated");
      if (input.timeout_source === "runner") {
        requireExact(input.record_type, "JOB", "record_type");
        requireExact(actor.type, "ksql_flow_runner", "actor.type");
        requireExact(
          detail.outcome,
          "runner_aborted_at_deadline",
          "log_detail.outcome",
        );
        requireExact(
          detail.completion_known,
          true,
          "log_detail.completion_known",
        );
        return nodeState("FAILED", "EXECUTION_TIMEOUT");
      }
      if (input.timeout_source === "stale_recovery") {
        requireExact(input.record_type, "LOCK_RECOVERY", "record_type");
        requireExact(actor.type, "recovery_process", "actor.type");
        requireExact(
          detail.outcome,
          "stale_lease_reclaimed_by_other_execution",
          "log_detail.outcome",
        );
        requireExact(
          detail.completion_known,
          false,
          "log_detail.completion_known",
        );
        return nodeState("UNKNOWN", "LEASE_EXPIRED");
      }
      fail(
        "MIGRATION_COMBINATION_UNKNOWN",
        "TIMEOUT requires a known timeout_source",
      );
      break;
    }
    case "SKIPPED": {
      const detail = requireObject(input.log_detail, "log_detail");
      const actor = requireObject(input.actor, "actor");
      requireExact(actor.authenticated, true, "actor.authenticated");
      switch (detail.skip_reason) {
        case "filtered":
          requireExact(input.record_type, "BATCH_JOB", "record_type");
          requireExact(input.timeout_source, "none", "timeout_source");
          requireExact(actor.type, "legacy_run_all", "actor.type");
          return {
            new_node_state_status: null,
            result_code: "LEGACY_FILTERED",
            result_destination: "invocation",
          };
        case "dependency":
          requireExact(input.record_type, "BATCH_JOB", "record_type");
          requireExact(input.timeout_source, "none", "timeout_source");
          requireExact(actor.type, "legacy_run_all", "actor.type");
          if (
            typeof detail.dependency_id !== "string" ||
            detail.dependency_id.length === 0
          ) {
            fail(
              "MIGRATION_INPUT_INCOMPLETE",
              "log_detail.dependency_id is required",
            );
          }
          return nodeState("BLOCKED", "DEPENDENCY_FAILED");
        case "stop_on_error":
          requireExact(input.record_type, "BATCH_JOB", "record_type");
          requireExact(input.timeout_source, "none", "timeout_source");
          requireExact(actor.type, "legacy_run_all", "actor.type");
          return nodeState("CANCELLED", "BATCH_STOPPED");
        case "batch_timeout":
          requireExact(input.record_type, "BATCH_JOB", "record_type");
          requireExact(input.timeout_source, "batch", "timeout_source");
          requireExact(actor.type, "legacy_run_all", "actor.type");
          return nodeState("CANCELLED", "BATCH_TIMEOUT");
        case "locked":
          requireExact(input.record_type, "JOB", "record_type");
          requireExact(input.timeout_source, "none", "timeout_source");
          requireExact(actor.type, "ksql_flow_runner", "actor.type");
          requireExact(
            detail.lock_holder_confirmed,
            true,
            "log_detail.lock_holder_confirmed",
          );
          return {
            new_node_state_status: "WAITING",
            result_code: "LOCK_CONFLICT",
            result_destination: "invocation",
          };
        default:
          fail(
            "MIGRATION_COMBINATION_UNKNOWN",
            "SKIPPED requires a known log_detail.skip_reason",
          );
      }
      break;
    }
    case "CANCELLED": {
      const detail = requireCommon(input, "JOB", "authenticated_operator");
      requireExact(
        detail.outcome,
        "explicit_external_stop",
        "log_detail.outcome",
      );
      requireExact(detail.stop_confirmed, true, "log_detail.stop_confirmed");
      return nodeState("CANCELLED", "USER_CANCELLED");
    }
    default:
      fail(
        "MIGRATION_STATUS_UNKNOWN",
        `current_status ${JSON.stringify(input.current_status)} is not classified`,
      );
  }

  fail("MIGRATION_COMBINATION_UNKNOWN", "migration input is not classified");
}
