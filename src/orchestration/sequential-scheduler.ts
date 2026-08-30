import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readStoreZip, verifyBundle } from "../bundle/index.js";
import { stableTopologicalSort } from "../dag/topological-sort.js";
import { loadNetworkDefinitionSource } from "../domain/load-network.js";
import type { NetworkDefinition } from "../domain/network-definition.js";
import type {
  NetworkRun,
  NetworkRunStatus,
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
import type {
  PersistenceRepository,
  Versioned,
} from "../persistence/repository.js";

export interface SchedulerLeaseMonitor {
  canStartNewNode(): boolean;
  canPersistResults(): boolean;
  confirmLeaseForFinalWrite(): Promise<boolean>;
  requiresNetworkLeaseInterruptedFinalization(): boolean;
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
  readonly persistInvocation?: boolean;
}

export interface SequentialSchedulerInput {
  readonly run: Versioned<NetworkRun>;
  readonly invocation: Versioned<RunInvocation>;
  readonly bundleBytes: Uint8Array;
  readonly repository: PersistenceRepository;
  readonly attemptExecutor: SchedulerAttemptExecutor;
  readonly leaseMonitor: SchedulerLeaseMonitor;
  readonly profile: string;
  readonly configPath: string;
  readonly executionRoot?: string;
  readonly close: (input: SchedulerCloseInput) => Promise<void>;
  readonly now?: () => Date;
  readonly uuid?: () => string;
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
  readonly reconciliationRequired: boolean;
}

export class SchedulerLeaseInterruptedError extends Error {
  readonly code = "NETWORK_LEASE_INTERRUPTED";

  constructor(readonly reconciliationRequired: boolean) {
    super(
      reconciliationRequired
        ? "network lease could not be confirmed; execution evidence requires reconciliation"
        : "network lease was interrupted",
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

  input.leaseMonitor.start?.();
  try {
    extracted = await extractBundle(input.bundleBytes, input.executionRoot);
    let run = await ensureRunStarted(input, now);
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
    );

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
        run = await updateAggregate(input, run, states, now);
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
      run = await updateAggregate(input, run, states, now);
      aggregateStatus = run.value.status;
      if (input.leaseMonitor.requiresNetworkLeaseInterruptedFinalization()) {
        closeInput = finalization(
          "CANCELLED",
          "NETWORK_LEASE_INTERRUPTED",
          selected,
          preserved,
          blocked,
        );
        break;
      }
    }

    if (closeInput === null) {
      run = await updateAggregate(input, run, states, now);
      aggregateStatus = run.value.status;
      const terminal = invocationOutcome(aggregateStatus);
      closeInput = finalization(
        terminal.status,
        terminal.resultCode,
        selected,
        preserved,
        blocked,
      );
    }
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
            ),
            persistInvocation: false,
          }
        : finalization(
            "FAILED",
            "SCHEDULER_FAILED",
            selected,
            preserved,
            blocked,
          );
      try {
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
): Promise<Versioned<NetworkRun>> {
  if (!(await confirmAggregateWrite(input.leaseMonitor)))
    throw new SchedulerLeaseInterruptedError(true);
  const status = computeRunAggregateStatus(
    [...states.values()].map(({ value }) => value.status),
    run.value.started_at,
  );
  const at = now().toISOString();
  return input.repository.updateRunAggregate(run.value.run_id, run.revision, {
    status,
    started_at: run.value.started_at,
    finished_at: isTerminalAggregate(status) ? at : null,
    updated_at: at,
  });
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
): SchedulerCloseInput {
  return {
    status,
    resultCode,
    selectedNodeIds: [...selected],
    preservedNodeIds: [...preserved],
    blockedNodeIds: [...blocked],
  };
}

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
