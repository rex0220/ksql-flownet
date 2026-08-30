/**
 * Durable timestamp precision note (FN-04 / FDR review material):
 *
 * kintone DATETIME fields persist minute precision. This affects ordering and
 * elapsed-time evidence for execution_started_at, runner_execution_started_at,
 * started_at, finished_at, updated_at, and resolved_at. Domain values remain
 * ISO-8601 strings and are not redesigned in FN-04. Callers must not use the
 * persisted DATETIME value to prove sub-minute ordering; precise runner/event
 * evidence must remain in its owning durable execution log until a later FDR
 * decision defines a canonical precision-preserving field.
 */
export const KINTONE_DATETIME_PRECISION = "minute" as const;

/**
 * Deployment prerequisite (M3): apply
 * spikes/a-app-layout/console/add-state-revision-before.console.js to the
 * selected app layout before integration tests. NODE_ATTEMPT writes formally
 * include state_revision_before and therefore fail against the old schema.
 */
export const STATE_REVISION_BEFORE_DEPLOYMENT_REQUIRED = true as const;
