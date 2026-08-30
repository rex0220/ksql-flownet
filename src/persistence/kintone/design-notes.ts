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

/**
 * updateKey concurrency observation (M3 device measurement, 2026-08-30): two
 * PUTs using the same revision do not have a deterministic loser response.
 * kintone returned either 409 GAIA_CO02 or 400 GAIA_DA02 across repeated
 * races. GAIA_DA02 is therefore adjudicated by re-reading the record: a newer
 * revision or a missing target is a revision conflict, while inconclusive or
 * failed reads remain fail-closed remote errors.
 */
export const UPDATE_KEY_DA02_REQUIRES_REREAD = true as const;

/**
 * Network Run uniqueness (M3): the R1 canonical record_key derived from
 * profile, network_id, and business_key is permanent across terminal and
 * non-terminal Runs. A duplicate-prohibited INSERT on that key is the final
 * adjudication. Network-lock serialization only narrows the race window as the
 * first defense; the unique constraint remains the final defense.
 */
export const RUN_R1_INSERT_IS_FINAL_UNIQUENESS_ADJUDICATION = true as const;
