import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readStoreZip, verifyBundle } from "../bundle/index.js";
import { stableTopologicalSort } from "../dag/topological-sort.js";
import { loadNetworkDefinitionSource } from "../domain/load-network.js";
import type { NetworkDefinition } from "../domain/network-definition.js";
import type {
  CancelRequest,
  NetworkRun,
  NetworkRunStatus,
  NodeAttempt,
  NodeState,
  NodeStateStatus,
  RunInvocation,
  RunInvocationStatus,
} from "../domain/persistence-model.js";
import { computeRunAggregateStatus } from "../domain/run-aggregate.js";
import type {
  AttemptExecutionOutcome,
  AttemptExecutorInput,
} from "../executor/attempt-executor.js";
import type { JobLogReader } from "../executor/job-log-reader.js";
import type {
  PersistenceRepository,
  Versioned,
} from "../persistence/repository.js";
import { RepositoryError } from "../persistence/repository.js";
import { KintoneTransportError } from "../persistence/kintone/client.js";
import {
  adjudicateOrphanRunningAttempts,
  finalizeAbandonedInvocations,
  orphanAdjudicationReason,
} from "./orphan-attempt-adjudication.js";
import { isCancelHold } from "./cancel-request.js";

export interface SchedulerLeaseMonitor {
  canStartNewNode(): boolean;
  canPersistResults(): boolean;
  confirmLeaseForFinalWrite(): Promise<boolean>;
  requiresNetworkLeaseInterruptedFinalization(): boolean;
  markControlPlaneUnreachable?(): void;
  /** A heartbeat is also the fencing read before an ordinary state write. */
  tick?(): Promise<boolean>;
  start?(): void;
  stop?(): void;
}

export interface SchedulerAttemptExecutor {
  execute(input: AttemptExecutorInput): Promise<AttemptExecutionOutcome>;
}

export interface SchedulerCloseInput {
  readonly status: Exclude<RunInvocationStatus, "RUNNING">;
  readonly resultCode: string;
  readonly selectedNodeIds: readonly string[];
  readonly preservedNodeIds: readonly string[];
  readonly blockedNodeIds: readonly string[];
  readonly reason?: string;
  readonly persistInvocation?: boolean;
}

export interface SequentialSchedulerInput {
  readonly run: Versioned<NetworkRun>;
  readonly invocation: Versioned<RunInvocation>;
  readonly bundleBytes: Uint8Array;
  readonly repository: PersistenceRepository;
  readonly attemptExecutor: SchedulerAttemptExecutor;
  readonly jobLogReader?: Pick<JobLogReader, "findAttemptResult">;
  readonly leaseMonitor: SchedulerLeaseMonitor;
  readonly profile: string;
  readonly configPath: string;
  readonly executionRoot?: string;
  readonly close: (input: SchedulerCloseInput) => Promise<void>;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly controlPlaneDrain?: {
    readonly retryDelayMs?: number;
    readonly nowMs?: () => number;
    readonly sleep?: (delayMs: number) => Promise<void>;
  };
}

export type SchedulerNodeDisposition =
  "EXECUTED" | "PRESERVED" | "BLOCKED" | "DEFERRED" | "EXCLUDED";

export interface SchedulerNodeResult {
  readonly nodeId: string;
  readonly disposition: SchedulerNodeDisposition;
  readonly status: NodeStateStatus;
  readonly attemptNo: number | null;
  readonly resultCode: string | null;
}

export interface SequentialSchedulerSummary {
  readonly nodeResults: readonly SchedulerNodeResult[];
  readonly aggregateStatus: NetworkRunStatus;
  readonly invocationStatus: Exclude<RunInvocationStatus, "RUNNING">;
  readonly invocationResultCode: string;
  readonly selectedNodeIds: readonly string[];
  readonly preservedNodeIds: readonly string[];
  readonly blockedNodeIds: readonly string[];
  readonly retryBrakeNodeIds: readonly string[];
  readonly reconciliationRequired: boolean;
}

export class SchedulerLeaseInterruptedError extends Error {
  readonly code = "NETWORK_LEASE_INTERRUPTED";

  constructor(
    readonly reconciliationRequired: boolean,
    options?: ErrorOptions,
  ) {
    super(
      reconciliationRequired
        ? "network lease could not be confirmed; execution evidence requires reconciliation"
        : "network lease was interrupted",
      options,
    );
    this.name = "SchedulerLeaseInterruptedError";
  }
}

/** FN-10 Phase 1 scheduler: one invocation, one node at a time. */
export async function runSequentialScheduler(
  input: SequentialSchedulerInput,
): Promise<SequentialSchedulerSummary> {
  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? randomUUID;
  let extracted: Awaited<ReturnType<typeof extractBundle>> | null = null;
  const selected = new Set<string>(
    input.invocation.value.mode === "RERUN_FROM"
      ? input.invocation.value.selected_node_ids
      : [],
  );
  const preserved = new Set<string>();
  const blocked = new Set<string>();
  const results = new Map<string, SchedulerNodeResult>();
  let aggregateStatus: NetworkRunStatus = input.run.value.status;
  let closeInput: SchedulerCloseInput | null = null;
  let reconciliationRequired = false;
  let adjudicationReason: string | undefined;

  input.leaseMonitor.start?.();
  try {
    extracted = await extractBundle(input.bundleBytes, input.executionRoot);
    const runControlPlaneOperation = controlPlaneDrainRunner(
      input.leaseMonitor,
      extracted.definition.network_lock.lease_duration_sec * 1000,
      input.controlPlaneDrain,
    );
    let run = await ensureRunStarted(input, now);
    let attempts: readonly Versioned<NodeAttempt>[] = [];
    if (input.invocation.value.mode !== "NEW") {
      attempts = await runControlPlaneOperation(() =>
        input.repository.getAttempts(input.run.value.run_id),
      );
      const adjudications = await adjudicateOrphanRunningAttempts({
        runId: input.run.value.run_id,
        invocationId: input.invocation.value.invocation_id,
        repository: input.repository,
        jobLogReader: input.jobLogReader ?? missingJobLogReader,
        confirmWrite: () => confirmOrdinaryWrite(input.leaseMonitor),
        now: () => now().toISOString(),
        attempts,
      });
      if (adjudications.length > 0) {
        const byId = new Map(
          adjudications.map((item) => [item.attemptId, item]),
        );
        attempts = attempts.map((attempt) => {
          const adjudicated = byId.get(attempt.value.node_attempt_id);
          return adjudicated === undefined
            ? attempt
            : {
                value: {
                  ...attempt.value,
                  status: adjudicated.status,
                  result_code: adjudicated.resultCode,
                },
                revision: attempt.revision + 1,
              };
        });
      }
      adjudicationReason = orphanAdjudicationReason(adjudications);
      await finalizeAbandonedInvocations({
        runId: input.run.value.run_id,
        invocationId: input.invocation.value.invocation_id,
        repository: input.repository,
        confirmWrite: () => confirmOrdinaryWrite(input.leaseMonitor),
        now: () => now().toISOString(),
      });
    }
    const states = stateMap(
      await input.repository.getNodeStates(input.run.value.run_id),
    );
    const excluded = await prepareResumeStates(
      input,
      extracted.definition,
      states,
      preserved,
      blocked,
      now,
      attempts,
    );
    const retryBrakeNodeIds = [...blocked].filter((nodeId) =>
      states.get(nodeId)?.value.status_reason?.startsWith("RETRY_BRAKE:"),
    );
    const brakeReasons = retryBrakeNodeIds
      .map((nodeId) => states.get(nodeId)?.value.status_reason)
      .filter((reason) => reason?.startsWith("RETRY_BRAKE:"));
    if (brakeReasons.length > 0)
      adjudicationReason = [adjudicationReason, ...brakeReasons]
        .filter((value) => value !== undefined)
        .join("; ");

    const order = stableTopologicalSort(extracted.definition.nodes).order;
    const nodes = new Map(
      extracted.definition.nodes.map((node) => [node.id, node]),
    );
    for (const nodeId of order) {
      const node = nodes.get(nodeId)!;
      let state = requiredState(states, nodeId);
      if (
        input.invocation.value.mode === "RERUN_FROM" &&
        !selected.has(nodeId)
      ) {
        if (state.value.status === "SUCCESS") {
          preserved.add(nodeId);
          results.set(nodeId, nodeResult(nodeId, "PRESERVED", state));
        } else {
          results.set(nodeId, nodeResult(nodeId, "EXCLUDED", state));
        }
        continue;
      }
      if (state.value.status === "SUCCESS") {
        preserved.add(nodeId);
        results.set(nodeId, nodeResult(nodeId, "PRESERVED", state));
        continue;
      }
      if (excluded.has(nodeId) && !isDescendantThatMustBlock(nodeId, state)) {
        blocked.add(nodeId);
        results.set(nodeId, nodeResult(nodeId, "EXCLUDED", state));
        continue;
      }

      const dependencies = node.depends_on.map((id) =>
        requiredState(states, id),
      );
      const failedDependencies = dependencies
        .filter(({ value }) =>
          ["FAILED", "BLOCKED", "CANCELLED", "UNKNOWN"].includes(value.status),
        )
        .map(({ value }) => value.node_id);
      if (failedDependencies.length > 0 || excluded.has(nodeId)) {
        if (!(await confirmOrdinaryWrite(input.leaseMonitor))) {
          reconciliationRequired = true;
          throw new SchedulerLeaseInterruptedError(true);
        }
        state = await writeNodeState(input.repository, state, {
          status: "BLOCKED",
          blocked_by: failedDependencies,
          status_reason: "ALL_SUCCESS_NOT_SATISFIED",
          finished_at: now().toISOString(),
          updated_at: now().toISOString(),
        });
        states.set(nodeId, state);
        blocked.add(nodeId);
        results.set(nodeId, nodeResult(nodeId, "BLOCKED", state));
        run = await updateAggregate(
          input,
          run,
          states,
          now,
          runControlPlaneOperation,
        );
        aggregateStatus = run.value.status;
        continue;
      }
      if (
        dependencies.some(
          ({ value }) =>
            value.status === "WAITING" || value.status === "RUNNING",
        )
      ) {
        selected.add(nodeId);
        results.set(nodeId, nodeResult(nodeId, "DEFERRED", state));
        continue;
      }
      if (state.value.status !== "WAITING") {
        blocked.add(nodeId);
        results.set(nodeId, nodeResult(nodeId, "EXCLUDED", state));
        continue;
      }
      selected.add(nodeId);
      const cancelRequest = await runControlPlaneOperation(() =>
        input.repository.getCancelRequest(input.run.value.run_id),
      );
      if (isCancelHold(cancelRequest)) {
        let effective: Versioned<CancelRequest> | null = cancelRequest;
        if (cancelRequest.value.state === "REQUESTED") {
          try {
            effective = await runControlPlaneOperation(() =>
              input.repository.updateCancelRequest(
                input.run.value.run_id,
                cancelRequest.revision,
                {
                  ...cancelRequest.value,
                  state: "ACCEPTED",
                  accepted_at: now().toISOString(),
                },
              ),
            );
          } catch (error) {
            if (
              !(error instanceof RepositoryError) ||
              error.code !== "REVISION_CONFLICT"
            )
              throw error;
            effective = await runControlPlaneOperation(() =>
              input.repository.getCancelRequest(input.run.value.run_id),
            );
          }
        }
        if (isCancelHold(effective)) {
          results.set(nodeId, nodeResult(nodeId, "DEFERRED", state));
          closeInput = finalization(
            "CANCELLED",
            "STOP_REQUESTED",
            selected,
            preserved,
            blocked,
            `cancel request CANCEL:${input.run.value.run_id} accepted`,
          );
          break;
        }
      }
      if (!input.leaseMonitor.canStartNewNode()) {
        results.set(nodeId, nodeResult(nodeId, "DEFERRED", state));
        break;
      }
      if (!(await confirmOrdinaryWrite(input.leaseMonitor))) {
        reconciliationRequired = true;
        throw new SchedulerLeaseInterruptedError(true);
      }

      const attemptId = `attempt_${uuid()}`;
      const attempt = await input.repository.createAttempt({
        node_state: state,
        node_attempt_id: attemptId,
        invocation_id: input.invocation.value.invocation_id,
      });
      const startedAt = now().toISOString();
      state = await writeNodeState(input.repository, state, {
        status: "RUNNING",
        latest_attempt_no: attempt.value.attempt_no,
        active_attempt_id: attemptId,
        blocked_by: [],
        status_reason: null,
        started_at: startedAt,
        finished_at: null,
        updated_at: startedAt,
      });
      states.set(nodeId, state);

      const outcome = await input.attemptExecutor.execute({
        attempt,
        nodeState: state,
        sqlPath: extracted.sqlPaths.get(nodeId)!,
        profile: input.profile,
        configPath: input.configPath,
        asOf: input.run.value.as_of ?? input.run.value.created_at,
        correlationId: input.run.value.run_id,
        attemptId,
        expectedJobId: node.job_id,
        executionStartedAt: startedAt,
        authorizeResultPersistence: async () => {
          if (input.leaseMonitor.canPersistResults()) return true;
          return input.leaseMonitor.confirmLeaseForFinalWrite();
        },
        runControlPlaneOperation,
      });
      state = outcome.nodeState;
      states.set(nodeId, state);
      results.set(
        nodeId,
        nodeResult(
          nodeId,
          outcome.nodeState.value.status === "WAITING"
            ? "DEFERRED"
            : "EXECUTED",
          outcome.nodeState,
          outcome.attempt.value.attempt_no,
          outcome.attempt.value.result_code,
        ),
      );
      run = await updateAggregate(
        input,
        run,
        states,
        now,
        runControlPlaneOperation,
      );
      aggregateStatus = run.value.status;
      if (input.leaseMonitor.requiresNetworkLeaseInterruptedFinalization()) {
        closeInput = finalization(
          "CANCELLED",
          "NETWORK_LEASE_INTERRUPTED",
          selected,
          preserved,
          blocked,
          adjudicationReason,
        );
        break;
      }
    }

    if (closeInput === null) {
      run = await updateAggregate(
        input,
        run,
        states,
        now,
        runControlPlaneOperation,
      );
      aggregateStatus = run.value.status;
      const terminal = invocationOutcome(aggregateStatus);
      closeInput = finalization(
        terminal.status,
        terminal.resultCode,
        selected,
        preserved,
        blocked,
        adjudicationReason,
      );
    }
    input.leaseMonitor.stop?.();
    await input.close(closeInput);
    return {
      nodeResults: order.map(
        (nodeId) =>
          results.get(nodeId) ??
          nodeResult(nodeId, "DEFERRED", requiredState(states, nodeId)),
      ),
      aggregateStatus,
      invocationStatus: closeInput.status,
      invocationResultCode: closeInput.resultCode,
      selectedNodeIds: [...selected],
      preservedNodeIds: [...preserved],
      blockedNodeIds: [...blocked],
      retryBrakeNodeIds,
      reconciliationRequired,
    };
  } catch (error) {
    if (closeInput === null) {
      const leaseLost =
        (error instanceof SchedulerLeaseInterruptedError &&
          error.reconciliationRequired) ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "NETWORK_LEASE_INTERRUPTED");
      closeInput = leaseLost
        ? {
            ...finalization(
              "CANCELLED",
              "NETWORK_LEASE_INTERRUPTED",
              selected,
              preserved,
              blocked,
              adjudicationReason,
            ),
            persistInvocation: false,
          }
        : finalization(
            "FAILED",
            "SCHEDULER_FAILED",
            selected,
            preserved,
            blocked,
            adjudicationReason,
          );
      try {
        input.leaseMonitor.stop?.();
        await input.close(closeInput);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "scheduler and close failed",
          {
            cause: closeError,
          },
        );
      }
    }
    throw error;
  } finally {
    input.leaseMonitor.stop?.();
    if (extracted !== null)
      await rm(extracted.directory, { recursive: true, force: true });
  }
}

async function prepareResumeStates(
  input: SequentialSchedulerInput,
  definition: NetworkDefinition,
  states: Map<string, Versioned<NodeState>>,
  preserved: Set<string>,
  blocked: Set<string>,
  now: () => Date,
  attempts: readonly Versioned<NodeAttempt>[],
): Promise<Set<string>> {
  const excludedRoots = new Set<string>();
  for (const node of definition.nodes) {
    let state = requiredState(states, node.id);
    if (state.value.status === "SUCCESS") {
      preserved.add(node.id);
      continue;
    }
    if (state.value.status === "UNKNOWN") excludedRoots.add(node.id);
    if (
      (state.value.status === "FAILED" || state.value.status === "CANCELLED") &&
      !state.value.idempotent
    ) {
      excludedRoots.add(node.id);
    }
    const resetBlocked =
      input.invocation.value.mode === "RESUME" &&
      state.value.status === "BLOCKED";
    const resetRetryable =
      input.invocation.value.mode === "RESUME" &&
      (state.value.status === "FAILED" || state.value.status === "CANCELLED") &&
      state.value.idempotent;
    if (resetRetryable) {
      const brake = retryBrakeForNode(attempts, node.id);
      if (brake !== null) {
        if (!(await confirmOrdinaryWrite(input.leaseMonitor)))
          throw new SchedulerLeaseInterruptedError(true);
        state = await writeNodeState(input.repository, state, {
          status_reason: `RETRY_BRAKE:${brake.failureKind}x${brake.count}`,
          updated_at: now().toISOString(),
        });
        states.set(node.id, state);
        excludedRoots.add(node.id);
        blocked.add(node.id);
        continue;
      }
    }
    if (resetBlocked || resetRetryable) {
      if (!(await confirmOrdinaryWrite(input.leaseMonitor)))
        throw new SchedulerLeaseInterruptedError(true);
      state = await writeNodeState(input.repository, state, {
        status: "WAITING",
        active_attempt_id: null,
        blocked_by: [],
        status_reason: null,
        finished_at: null,
        updated_at: now().toISOString(),
      });
      states.set(node.id, state);
    }
  }
  const excluded = descendantsIncludingRoots(definition, excludedRoots);
  for (const id of excludedRoots) blocked.add(id);
  return excluded;
}

export function retryBrakeForNode(
  attempts: readonly Versioned<NodeAttempt>[],
  nodeId: string,
): { failureKind: string; count: number } | null {
  const history = attempts
    .filter(({ value }) => value.node_id === nodeId)
    .slice()
    .sort((left, right) => right.value.attempt_no - left.value.attempt_no);
  let failureKind: string | null = null;
  let count = 0;
  for (const { value } of history) {
    if (value.status === "CANCELLED" && value.result_code === "PREPARE_FAILED")
      continue;
    if (value.status !== "FAILED") break;
    const current = value.result_code.trim();
    if (current === "") break;
    failureKind ??= current;
    if (current !== failureKind) break;
    count += 1;
  }
  return failureKind !== null && count >= 3 ? { failureKind, count } : null;
}

function descendantsIncludingRoots(
  definition: NetworkDefinition,
  roots: ReadonlySet<string>,
): Set<string> {
  const result = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of definition.nodes) {
      if (
        !result.has(node.id) &&
        node.depends_on.some((dependency) => result.has(dependency))
      ) {
        result.add(node.id);
        changed = true;
      }
    }
  }
  return result;
}

function isDescendantThatMustBlock(
  nodeId: string,
  state: Versioned<NodeState>,
): boolean {
  return state.value.node_id === nodeId && state.value.status === "WAITING";
}

async function ensureRunStarted(
  input: SequentialSchedulerInput,
  now: () => Date,
): Promise<Versioned<NetworkRun>> {
  if (input.run.value.started_at !== null) return input.run;
  if (!(await confirmOrdinaryWrite(input.leaseMonitor)))
    throw new SchedulerLeaseInterruptedError(true);
  const at = now().toISOString();
  return input.repository.updateRunAggregate(
    input.run.value.run_id,
    input.run.revision,
    { status: "RUNNING", started_at: at, finished_at: null, updated_at: at },
  );
}

async function updateAggregate(
  input: SequentialSchedulerInput,
  run: Versioned<NetworkRun>,
  states: Map<string, Versioned<NodeState>>,
  now: () => Date,
  runControlPlaneOperation: <T>(operation: () => Promise<T>) => Promise<T> = (
    operation,
  ) => operation(),
): Promise<Versioned<NetworkRun>> {
  if (!(await confirmAggregateWrite(input.leaseMonitor)))
    throw new SchedulerLeaseInterruptedError(true);
  const status = computeRunAggregateStatus(
    [...states.values()].map(({ value }) => value.status),
    run.value.started_at,
  );
  const at = now().toISOString();
  return runControlPlaneOperation(() =>
    input.repository.updateRunAggregate(run.value.run_id, run.revision, {
      status,
      started_at: run.value.started_at,
      finished_at: isTerminalAggregate(status) ? at : null,
      updated_at: at,
    }),
  );
}

function controlPlaneDrainRunner(
  monitor: SchedulerLeaseMonitor,
  maxDurationMs: number,
  options: SequentialSchedulerInput["controlPlaneDrain"],
): <T>(operation: () => Promise<T>) => Promise<T> {
  const nowMs = options?.nowMs ?? Date.now;
  const retryDelayMs = options?.retryDelayMs ?? 2_000;
  const sleep =
    options?.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let deadline: number | null = null;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    try {
      return await operation();
    } catch (error) {
      if (!isKintoneTransportFailure(error)) throw error;
      lastError = error;
      deadline ??= nowMs() + maxDurationMs;
      monitor.markControlPlaneUnreachable?.();
    }
    while (nowMs() < deadline) {
      const remaining = deadline - nowMs();
      await sleep(Math.min(retryDelayMs, Math.max(0, remaining)));
      if (nowMs() >= deadline) break;
      if (!(await monitor.confirmLeaseForFinalWrite())) continue;
      try {
        return await operation();
      } catch (error) {
        if (!isKintoneTransportFailure(error)) throw error;
        lastError = error;
        monitor.markControlPlaneUnreachable?.();
      }
    }
    throw new SchedulerLeaseInterruptedError(true, { cause: lastError });
  };
}

function isKintoneTransportFailure(error: unknown): boolean {
  if (error instanceof KintoneTransportError) return true;
  if (error instanceof RepositoryError) {
    if (error.code !== "AMBIGUOUS_WRITE" && error.code !== "REMOTE_ERROR")
      return false;
    return isKintoneTransportFailure(error.causeDetail);
  }
  if (error instanceof AggregateError)
    return error.errors.some(isKintoneTransportFailure);
  if (typeof error === "object" && error !== null && "cause" in error)
    return isKintoneTransportFailure(error.cause);
  return false;
}

async function confirmOrdinaryWrite(
  monitor: SchedulerLeaseMonitor,
): Promise<boolean> {
  if (!monitor.canStartNewNode()) return false;
  return monitor.tick === undefined ? true : monitor.tick();
}

async function confirmAggregateWrite(
  monitor: SchedulerLeaseMonitor,
): Promise<boolean> {
  if (!monitor.canPersistResults()) return false;
  if (monitor.requiresNetworkLeaseInterruptedFinalization()) return true;
  return monitor.tick === undefined ? true : monitor.tick();
}

async function writeNodeState(
  repository: PersistenceRepository,
  current: Versioned<NodeState>,
  update: Partial<NodeState>,
): Promise<Versioned<NodeState>> {
  return repository.upsertNodeState({
    expected_revision: current.revision,
    value: { ...current.value, ...update },
  });
}

function invocationOutcome(status: NetworkRunStatus): {
  status: Exclude<RunInvocationStatus, "RUNNING">;
  resultCode: string;
} {
  switch (status) {
    case "SUCCESS":
      return { status: "SUCCESS", resultCode: "OK" };
    case "UNKNOWN":
      return { status: "UNKNOWN", resultCode: "NODE_RESULT_UNKNOWN" };
    case "FAILED":
      return { status: "FAILED", resultCode: "NODE_FAILED_OR_BLOCKED" };
    case "CANCELLED":
      return { status: "CANCELLED", resultCode: "NODE_CANCELLED" };
    case "CREATED":
    case "RUNNING":
      return { status: "CANCELLED", resultCode: "NODES_DEFERRED" };
  }
}

function finalization(
  status: Exclude<RunInvocationStatus, "RUNNING">,
  resultCode: string,
  selected: ReadonlySet<string>,
  preserved: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
  reason?: string,
): SchedulerCloseInput {
  return {
    status,
    resultCode,
    selectedNodeIds: [...selected],
    preservedNodeIds: [...preserved],
    blockedNodeIds: [...blocked],
    ...(reason === undefined ? {} : { reason }),
  };
}

const missingJobLogReader: Pick<JobLogReader, "findAttemptResult"> = {
  async findAttemptResult(): Promise<never> {
    throw new Error(
      "job log reader is required to adjudicate orphan RUNNING attempts",
    );
  },
};

function isTerminalAggregate(status: NetworkRunStatus): boolean {
  return status !== "CREATED" && status !== "RUNNING";
}

function stateMap(
  states: readonly Versioned<NodeState>[],
): Map<string, Versioned<NodeState>> {
  return new Map(states.map((state) => [state.value.node_id, state]));
}

function requiredState(
  states: ReadonlyMap<string, Versioned<NodeState>>,
  nodeId: string,
): Versioned<NodeState> {
  const state = states.get(nodeId);
  if (state === undefined) throw new Error(`Node State '${nodeId}' is missing`);
  return state;
}

function nodeResult(
  nodeId: string,
  disposition: SchedulerNodeDisposition,
  state: Versioned<NodeState>,
  attemptNo: number | null = null,
  resultCode: string | null = state.value.status_reason,
): SchedulerNodeResult {
  return {
    nodeId,
    disposition,
    status: state.value.status,
    attemptNo,
    resultCode,
  };
}

async function extractBundle(
  bundleBytes: Uint8Array,
  executionRoot?: string,
): Promise<{
  directory: string;
  definition: NetworkDefinition;
  sqlPaths: Map<string, string>;
}> {
  const verified = verifyBundle(bundleBytes);
  const entries = new Map(
    readStoreZip(bundleBytes).map((entry) => [entry.name, entry.data]),
  );
  const networkBytes = entries.get("network.yaml");
  if (networkBytes === undefined) throw new Error("bundle has no network.yaml");
  const loaded = loadNetworkDefinitionSource(networkBytes.toString("utf8"));
  if (loaded.definition === undefined || loaded.errors.length > 0)
    throw new Error("bundle network definition is invalid");
  const directory = await mkdtemp(
    join(resolve(executionRoot ?? tmpdir()), "ksql-flownet-run-"),
  );
  const sqlPaths = new Map<string, string>();
  try {
    for (const file of verified.manifest.files) {
      if (file.nodeId === undefined) continue;
      if (!/^jobs\/[A-Za-z0-9._-]+\.sql$/u.test(file.path))
        throw new Error(`unsafe bundle SQL path '${file.path}'`);
      const bytes = entries.get(file.path);
      if (bytes === undefined)
        throw new Error(`bundle SQL '${file.path}' is missing`);
      const path = join(directory, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: "wx" });
      sqlPaths.set(file.nodeId, resolve(path));
    }
    for (const node of loaded.definition.nodes)
      if (!sqlPaths.has(node.id))
        throw new Error(`bundle SQL for node '${node.id}' is missing`);
    return { directory, definition: loaded.definition, sqlPaths };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
