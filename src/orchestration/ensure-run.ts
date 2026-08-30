import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildBundle, readStoreZip, verifyBundle } from "../bundle/index.js";
import { resolveBusinessKey } from "../domain/business-key.js";
import { nodeStateKey } from "../domain/canonical-record-key.js";
import {
  loadNetworkDefinition,
  loadNetworkDefinitionSource,
} from "../domain/load-network.js";
import type { NetworkDefinition } from "../domain/network-definition.js";
import type {
  NetworkRun,
  NodeState,
  ResolvedProfileSnapshot,
  RunInvocation,
  RunInvocationStatus,
} from "../domain/persistence-model.js";
import type {
  CapabilitiesResult,
  JobInspection,
  ProfileDescription,
} from "../executor/ksql-flow-cli.js";
import {
  assertProfileSnapshot,
  canonicalJsonSha256,
  profileSnapshot,
  sha256Hex,
  validateCapabilities,
  validateJobInspections,
} from "../executor/preflight.js";
import type { NetworkLockReference } from "../persistence/network-lock.js";
import type {
  PersistenceRepository,
  Versioned,
} from "../persistence/repository.js";
import { RepositoryError } from "../persistence/repository.js";
import { reconcileRun } from "./reconciliation.js";

export type EnsureRunOutcome = "NEW" | "RESUME" | "NOOP";

export type EnsureRunErrorCode =
  | "NETWORK_VALIDATION_FAILED"
  | "BUSINESS_KEY_INVALID"
  | "MULTIPLE_RUNS"
  | "RUN_NOT_FOUND"
  | "RUN_ID_MISMATCH"
  | "RUN_NOT_RESUMABLE"
  | "MAX_ACTIVE_RUNS"
  | "PROFILE_DESCRIPTION_INVALID"
  | "BUNDLE_INPUT_CHANGED"
  | "RUN_SNAPSHOT_MISMATCH"
  | "BUNDLE_DIALECT_MISMATCH"
  | "ENSURE_RUN_FAILED";

export class EnsureRunError extends Error {
  constructor(
    readonly code: EnsureRunErrorCode,
    message: string,
    readonly blockedBy: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnsureRunError";
  }
}

export interface EnsureRunExecutor {
  capabilities(): Promise<CapabilitiesResult>;
  describeProfile(): Promise<ProfileDescription>;
  inspectJob(sqlPath: string): Promise<JobInspection>;
}

export interface EnsureRunBundleStore {
  upload(zipBytes: Uint8Array): Promise<string>;
  download(fileKey: string): Promise<Uint8Array>;
}

export interface EnsureRunLockManager {
  acquire(): Promise<NetworkLockReference>;
  release(
    reference: NetworkLockReference,
    status?: string,
    resultCode?: string,
  ): Promise<unknown>;
}

export interface EnsureRunInput {
  readonly networkPath: string;
  readonly profile: string;
  readonly scheduledFor?: string;
  readonly businessKey?: string;
  readonly resume?: boolean;
  readonly resumeRunId?: string;
  readonly requestedBy: string;
  readonly host: string;
  readonly invocationId?: string;
  readonly repository: PersistenceRepository;
  readonly lockManager: EnsureRunLockManager;
  readonly executor: EnsureRunExecutor;
  readonly bundleStore: EnsureRunBundleStore;
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

export interface EnsureRunCloseInput {
  readonly status: Exclude<RunInvocationStatus, "RUNNING">;
  readonly resultCode: string;
  readonly selectedNodeIds?: readonly string[];
  readonly preservedNodeIds?: readonly string[];
  readonly blockedNodeIds?: readonly string[];
  /** D-29 unrecovered drain releases only if possible and leaves Invocation untouched. */
  readonly persistInvocation?: boolean;
}

export interface EnsureRunNoopResult {
  readonly outcome: "NOOP";
  readonly run: Versioned<NetworkRun>;
  readonly invocation: null;
  readonly blockedBy: readonly string[];
  readonly businessKey: string;
}

export interface EnsureRunExecutionResult {
  readonly outcome: "NEW" | "RESUME";
  readonly run: Versioned<NetworkRun>;
  readonly invocation: Versioned<RunInvocation>;
  readonly blockedBy: readonly string[];
  readonly businessKey: string;
  readonly bundleBytes: Buffer;
  readonly lock: NetworkLockReference;
  close(input: EnsureRunCloseInput): Promise<void>;
}

export type EnsureRunResult = EnsureRunNoopResult | EnsureRunExecutionResult;

export async function ensureRun(
  input: EnsureRunInput,
): Promise<EnsureRunResult> {
  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? randomUUID;
  const loaded = loadNetworkDefinition(input.networkPath);
  if (loaded.definition === undefined || loaded.errors.length > 0) {
    throw new EnsureRunError(
      "NETWORK_VALIDATION_FAILED",
      formatValidationErrors(loaded.errors),
    );
  }
  const definition = loaded.definition;
  const businessKey = resolveEnsureBusinessKey(
    input,
    definition.network_id,
    definition.business_key_policy,
    now,
  );

  // Contract 9.1: capability failure must not acquire the Network lock.
  const capabilities = await input.executor.capabilities();
  validateCapabilities(capabilities);

  let lock: NetworkLockReference | null = null;
  let invocation: Versioned<RunInvocation> | null = null;
  let handedOff = false;
  try {
    lock = await input.lockManager.acquire();
    let run = await findRunInsideLock(
      input,
      definition.network_id,
      businessKey,
    );
    let outcome: "NEW" | "RESUME";
    let bundleBytes: Buffer;

    if (run === null) {
      if (input.resumeRunId !== undefined) {
        throw new EnsureRunError(
          "RUN_NOT_FOUND",
          `run '${input.resumeRunId}' was not found`,
        );
      }
      const blockedBy = (
        await input.repository.listRuns(input.profile, definition.network_id)
      )
        .filter(
          ({ value }) =>
            value.business_key !== businessKey &&
            value.resume_allowed &&
            value.lifecycle_status !== "ARCHIVED" &&
            value.status !== "SUCCESS",
        )
        .map(({ value }) => value.run_id)
        .sort();
      if (blockedBy.length >= definition.max_active_runs) {
        throw new EnsureRunError(
          "MAX_ACTIVE_RUNS",
          `max_active_runs=${definition.max_active_runs} is reached; blocking run_id(s): ${blockedBy.join(", ")}`,
          blockedBy,
        );
      }
      const created = await createNewRun(
        input,
        definition,
        businessKey,
        capabilities,
        now,
        uuid,
        async (createdRun) => {
          invocation = await createInvocation(
            input,
            createdRun,
            "NEW",
            now,
            uuid,
            definition.nodes.map((node) => node.id),
          );
        },
      );
      run = created.run;
      bundleBytes = created.bundleBytes;
      outcome = "NEW";
    } else {
      assertRunIdentity(run.value, input.profile, definition.network_id);
      if (run.value.status === "SUCCESS") {
        await input.lockManager.release(lock, "SUCCESS", "ALREADY_SUCCESS");
        lock = null;
        return {
          outcome: "NOOP",
          run,
          invocation: null,
          blockedBy: [],
          businessKey: run.value.business_key,
        };
      }
      outcome = "RESUME";
      invocation = await createInvocation(input, run, outcome, now, uuid);
      assertRunResumable(run.value);
      const description = await input.executor.describeProfile();
      assertDescriptionProfile(description, input.profile);
      assertStoredProfile(description, run.value);
      bundleBytes = Buffer.from(
        await input.bundleStore.download(run.value.source_bundle_attachment),
      );
      verifyBundle(bundleBytes, { zipSha256: run.value.source_bundle_sha256 });
      await ensureNodeStates(
        input.repository,
        run.value.run_id,
        definitionFromBundle(bundleBytes, run.value),
        now().toISOString(),
        uuid,
      );
    }

    if (invocation === null) {
      invocation = await createInvocation(input, run, outcome, now, uuid);
    }
    await reconcileRun(input.repository, run.value.run_id);
    run = await input.repository.getRun(run.value.run_id);

    const activeLock = lock;
    const activeInvocation = invocation;
    let closed = false;
    handedOff = true;
    return {
      outcome,
      run,
      invocation,
      blockedBy: [],
      businessKey: run.value.business_key,
      bundleBytes,
      lock: activeLock,
      async close(finalization): Promise<void> {
        if (closed) return;
        closed = true;
        let finalizationError: unknown;
        if (finalization.persistInvocation !== false) {
          try {
            await input.repository.finalizeInvocation(
              activeInvocation.value.invocation_id,
              activeInvocation.revision,
              {
                status: finalization.status,
                result_code: finalization.resultCode,
                finished_at: now().toISOString(),
                ...(finalization.selectedNodeIds === undefined
                  ? {}
                  : { selected_node_ids: finalization.selectedNodeIds }),
                ...(finalization.preservedNodeIds === undefined
                  ? {}
                  : { preserved_node_ids: finalization.preservedNodeIds }),
                ...(finalization.blockedNodeIds === undefined
                  ? {}
                  : { blocked_node_ids: finalization.blockedNodeIds }),
              },
            );
          } catch (error) {
            finalizationError = error;
          }
        }
        try {
          await input.lockManager.release(
            activeLock,
            finalization.status,
            finalization.resultCode,
          );
        } catch (releaseError) {
          throw new AggregateError(
            finalizationError === undefined
              ? [releaseError]
              : [finalizationError, releaseError],
            "ensure-run close failed",
            { cause: releaseError },
          );
        }
        if (finalizationError !== undefined) throw finalizationError;
      },
    };
  } catch (error) {
    let invocationFinalizationError: unknown;
    if (invocation !== null) {
      try {
        await input.repository.finalizeInvocation(
          invocation.value.invocation_id,
          invocation.revision,
          {
            status: "FAILED",
            result_code: errorCode(error),
            finished_at: now().toISOString(),
          },
        );
      } catch (finalizationError) {
        invocationFinalizationError = finalizationError;
      }
    }
    if (invocationFinalizationError !== undefined) {
      throw new AggregateError(
        [normalizeEnsureError(error), invocationFinalizationError],
        "ensure-run failed and its Invocation could not be finalized",
        { cause: error },
      );
    }
    throw normalizeEnsureError(error);
  } finally {
    if (lock !== null && !handedOff) {
      await input.lockManager.release(lock, "FAILED", "ENSURE_RUN_FAILED");
    }
  }
}

async function findRunInsideLock(
  input: EnsureRunInput,
  networkId: string,
  businessKey: string,
): Promise<Versioned<NetworkRun> | null> {
  try {
    if (input.resumeRunId !== undefined) {
      return await input.repository.getRun(input.resumeRunId);
    }
    return await input.repository.getRunByBusinessKey(
      input.profile,
      networkId,
      businessKey,
    );
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "MULTIPLE_RECORDS") {
      throw new EnsureRunError(
        "MULTIPLE_RUNS",
        "multiple runs matched profile + network_id + business_key",
      );
    }
    if (
      input.resumeRunId !== undefined &&
      error instanceof RepositoryError &&
      error.code === "RECORD_NOT_FOUND"
    ) {
      return null;
    }
    throw error;
  }
}

async function createNewRun(
  input: EnsureRunInput,
  definition: NonNullable<
    ReturnType<typeof loadNetworkDefinition>["definition"]
  >,
  businessKey: string,
  capabilities: CapabilitiesResult,
  now: () => Date,
  uuid: () => string,
  onRunCreated: (run: Versioned<NetworkRun>) => Promise<void>,
): Promise<{ run: Versioned<NetworkRun>; bundleBytes: Buffer }> {
  const description = await input.executor.describeProfile();
  assertDescriptionProfile(description, input.profile);
  const networkBytes = await readFile(input.networkPath);
  const root = dirname(input.networkPath);
  const inspected = await Promise.all(
    definition.nodes.map(async (node) => {
      const sqlPath = resolve(root, node.sql);
      const before = await readFile(sqlPath);
      const inspection = await input.executor.inspectJob(sqlPath);
      const after = await readFile(sqlPath);
      if (!before.equals(after)) {
        throw new EnsureRunError(
          "BUNDLE_INPUT_CHANGED",
          `SQL file changed while it was inspected: ${sqlPath}`,
        );
      }
      return { node, sqlBytes: after, inspection };
    }),
  );
  const inspectionMap = new Map(
    inspected.map(({ node, inspection }) => [node.id, inspection]),
  );
  const validated = validateJobInspections(definition.nodes, inspectionMap);
  const validatedByNode = new Map(validated.map((item) => [item.nodeId, item]));
  const jobs = inspected.map(({ node, sqlBytes }) => ({
    path: `jobs/${node.id}.sql`,
    sqlBytes,
    inspectedNode: validatedByNode.get(node.id)!,
  }));
  const dialects = [
    ...new Set(inspected.map(({ inspection }) => inspection.dialect)),
  ];
  if (dialects.length !== 1) {
    throw new EnsureRunError(
      "BUNDLE_DIALECT_MISMATCH",
      `inspected jobs do not have one dialect: ${dialects.join(", ")}`,
    );
  }
  const bundle = buildBundle({ networkYamlBytes: networkBytes, jobs });
  verifyBundle(bundle.zipBytes, {
    zipSha256: bundle.zipSha256,
    manifestSha256: bundle.manifestSha256,
    manifest: bundle.manifest,
  });
  const uploadFileKey = await input.bundleStore.upload(bundle.zipBytes);
  const at = now().toISOString();
  const snapshot = persistenceProfileSnapshot(description);
  const value: NetworkRun = {
    run_id: `netrun_${uuid()}`,
    network_id: definition.network_id,
    business_key: businessKey,
    max_active_runs: definition.max_active_runs,
    status: "CREATED",
    lifecycle_status: "ACTIVE",
    resume_allowed: true,
    as_of: input.scheduledFor ?? null,
    definition_schema_version: definition.schema_version,
    definition_sha256: sha256Hex(networkBytes),
    source_bundle_sha256: bundle.zipSha256,
    source_bundle_attachment: uploadFileKey,
    resolved_profile_snapshot: snapshot,
    resolved_profile_sha256: profileSnapshot(description).canonicalJsonSha256,
    ksql_flow_version: capabilities.ksqlFlowVersion,
    engine_version: capabilities.engineVersion,
    dialect: dialects[0]!,
    created_at: at,
    started_at: null,
    finished_at: null,
    updated_at: at,
  };
  const created = await input.repository.createRun(value);
  // Re-read after attachment consumption so kintone supplies the downloadable fileKey.
  const stored = await input.repository.getRun(created.value.run_id);
  await onRunCreated(stored);
  const persistedBytes = Buffer.from(
    await input.bundleStore.download(stored.value.source_bundle_attachment),
  );
  verifyBundle(persistedBytes, { zipSha256: bundle.zipSha256 });
  await ensureNodeStates(
    input.repository,
    stored.value.run_id,
    definition,
    at,
    uuid,
  );
  return { run: stored, bundleBytes: persistedBytes };
}

function definitionFromBundle(
  bundleBytes: Uint8Array,
  run: NetworkRun,
): NetworkDefinition {
  const networkBytes = readStoreZip(bundleBytes).find(
    ({ name }) => name === "network.yaml",
  )?.data;
  if (
    networkBytes === undefined ||
    sha256Hex(networkBytes) !== run.definition_sha256
  ) {
    throw new EnsureRunError(
      "RUN_SNAPSHOT_MISMATCH",
      "stored network definition does not match the Run definition SHA-256",
    );
  }
  const loaded = loadNetworkDefinitionSource(networkBytes.toString("utf8"));
  if (loaded.definition === undefined || loaded.errors.length > 0) {
    throw new EnsureRunError(
      "RUN_SNAPSHOT_MISMATCH",
      `stored network definition is invalid: ${formatValidationErrors(loaded.errors)}`,
    );
  }
  if (
    loaded.definition.network_id !== run.network_id ||
    loaded.definition.schema_version !== run.definition_schema_version
  ) {
    throw new EnsureRunError(
      "RUN_SNAPSHOT_MISMATCH",
      "stored network definition identity does not match the Run",
    );
  }
  return loaded.definition;
}

async function ensureNodeStates(
  repository: PersistenceRepository,
  runId: string,
  definition: NetworkDefinition,
  at: string,
  uuid: () => string,
): Promise<void> {
  const existing = await repository.getNodeStates(runId);
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  for (const state of existing) {
    const node = nodesById.get(state.value.node_id);
    if (
      node === undefined ||
      state.value.job_id !== node.job_id ||
      state.value.idempotent !== node.idempotent ||
      state.value.trigger_rule !== node.trigger_rule
    ) {
      throw new EnsureRunError(
        "RUN_SNAPSHOT_MISMATCH",
        `Node State '${state.value.node_id}' does not match the stored bundle`,
      );
    }
  }
  const existingIds = new Set(existing.map(({ value }) => value.node_id));
  for (const node of definition.nodes) {
    if (existingIds.has(node.id)) continue;
    await repository.upsertNodeState({
      value: initialNodeState(runId, node, at, uuid),
      expected_revision: null,
    });
  }
}

function initialNodeState(
  runId: string,
  node: NonNullable<
    ReturnType<typeof loadNetworkDefinition>["definition"]
  >["nodes"][number],
  at: string,
  uuid: () => string,
): NodeState {
  return {
    node_state_id: `nodestate_${uuid()}`,
    node_state_key: nodeStateKey(runId, node.id),
    run_id: runId,
    node_id: node.id,
    job_id: node.job_id,
    status: "WAITING",
    latest_attempt_no: 0,
    active_attempt_id: null,
    revision: 1,
    idempotent: node.idempotent,
    trigger_rule: "all_success",
    blocked_by: [],
    status_reason: null,
    started_at: null,
    finished_at: null,
    updated_at: at,
  };
}

async function createInvocation(
  input: EnsureRunInput,
  run: Versioned<NetworkRun>,
  mode: "NEW" | "RESUME",
  now: () => Date,
  uuid: () => string,
  newRunNodeIds?: readonly string[],
): Promise<Versioned<RunInvocation>> {
  const states =
    newRunNodeIds === undefined
      ? await input.repository.getNodeStates(run.value.run_id)
      : [];
  const preserved = states
    .filter(({ value }) => value.status === "SUCCESS")
    .map(({ value }) => value.node_id)
    .sort();
  const blocked = states
    .filter(
      ({ value }) =>
        value.status === "UNKNOWN" ||
        ((value.status === "FAILED" || value.status === "CANCELLED") &&
          !value.idempotent),
    )
    .map(({ value }) => value.node_id)
    .sort();
  const blockedSet = new Set(blocked);
  const selected =
    newRunNodeIds === undefined
      ? states
          .filter(
            ({ value }) =>
              value.status !== "SUCCESS" && !blockedSet.has(value.node_id),
          )
          .map(({ value }) => value.node_id)
          .sort()
      : [...newRunNodeIds].sort();
  return input.repository.createInvocation({
    invocation_id: input.invocationId ?? `invoke_${uuid()}`,
    run_id: run.value.run_id,
    mode,
    requested_by: input.requestedBy,
    host: input.host,
    started_at: now().toISOString(),
    finished_at: null,
    status: "RUNNING",
    result_code: "PENDING",
    selected_node_ids: selected,
    preserved_node_ids: preserved,
    blocked_node_ids: blocked,
    reason: mode === "NEW" ? "new business run" : "resume incomplete run",
  });
}

function resolveEnsureBusinessKey(
  input: EnsureRunInput,
  networkId: string,
  policy: NonNullable<
    ReturnType<typeof loadNetworkDefinition>["definition"]
  >["business_key_policy"],
  now: () => Date,
): string {
  if (input.resumeRunId !== undefined) return "";
  const manual =
    input.resume !== true &&
    input.scheduledFor === undefined &&
    input.businessKey === undefined
      ? `${networkId}@manual-${manualTimestamp(now())}`
      : undefined;
  const selectedBusinessKey = input.businessKey ?? manual;
  const resolved = resolveBusinessKey({
    networkId,
    policy,
    ...(input.scheduledFor === undefined
      ? {}
      : { scheduledFor: input.scheduledFor }),
    ...(selectedBusinessKey === undefined
      ? {}
      : { businessKey: selectedBusinessKey }),
  });
  if (resolved.businessKey === undefined || resolved.errors.length > 0) {
    throw new EnsureRunError(
      "BUSINESS_KEY_INVALID",
      formatValidationErrors(resolved.errors),
    );
  }
  return resolved.businessKey;
}

function manualTimestamp(value: Date): string {
  return value
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
}

function assertRunIdentity(
  run: NetworkRun,
  profile: string,
  networkId: string,
): void {
  const mismatches: string[] = [];
  if (run.network_id !== networkId) mismatches.push("network_id");
  if (run.resolved_profile_snapshot.profile !== profile)
    mismatches.push("profile");
  if (mismatches.length > 0) {
    throw new EnsureRunError(
      "RUN_ID_MISMATCH",
      `specified run does not match ${mismatches.join(", ")}`,
    );
  }
}

function assertRunResumable(run: NetworkRun): void {
  if (!run.resume_allowed || run.lifecycle_status === "ARCHIVED") {
    throw new EnsureRunError(
      "RUN_NOT_RESUMABLE",
      `run '${run.run_id}' is not resumable (lifecycle_status=${run.lifecycle_status}, resume_allowed=${String(run.resume_allowed)})`,
    );
  }
}

function assertDescriptionProfile(
  description: ProfileDescription,
  profile: string,
): void {
  if (description.profile !== profile) {
    throw new EnsureRunError(
      "PROFILE_DESCRIPTION_INVALID",
      `describe-profile returned '${description.profile}', expected '${profile}'`,
    );
  }
}

function assertStoredProfile(
  description: ProfileDescription,
  run: NetworkRun,
): void {
  const snapshot = run.resolved_profile_snapshot;
  assertProfileSnapshot(description, {
    canonicalJsonSha256: run.resolved_profile_sha256,
    baseUrl: snapshot.base_url,
    guestSpaceId: snapshot.guest_space_id,
    apps: snapshot.apps,
    timezone: snapshot.timezone,
  });
}

function persistenceProfileSnapshot(
  description: ProfileDescription,
): ResolvedProfileSnapshot {
  const maxApiCalls = description.limits.maxApiCalls;
  const maxReadRows = description.limits.maxReadRows;
  const batchTimeoutSec = description.limits.batchTimeoutSec;
  if (
    description.timezone === null ||
    !isFiniteNumberOrNull(maxApiCalls) ||
    !isFiniteNumberOrNull(maxReadRows) ||
    !isFiniteNumberOrNull(batchTimeoutSec)
  ) {
    throw new EnsureRunError(
      "PROFILE_DESCRIPTION_INVALID",
      "describe-profile is missing timezone or required limits",
    );
  }
  return {
    profile: description.profile,
    base_url: description.baseUrl,
    guest_space_id: description.guestSpaceId,
    timezone: description.timezone,
    apps: { ...description.apps },
    limits: {
      max_api_calls: maxApiCalls,
      max_read_rows: maxReadRows,
      batch_timeout_sec: batchTimeoutSec,
    },
  };
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function formatValidationErrors(
  errors: readonly { code: string; path: string; message: string }[],
): string {
  return errors
    .map((error) => `[${error.code}] ${error.path}: ${error.message}`)
    .join("; ");
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "ENSURE_RUN_FAILED";
}

function normalizeEnsureError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new EnsureRunError(
    "ENSURE_RUN_FAILED",
    "ensure-run failed with a non-Error value",
    [],
    { cause: error },
  );
}

export function profileDescriptionSha256(
  description: ProfileDescription,
): string {
  return canonicalJsonSha256(description);
}
