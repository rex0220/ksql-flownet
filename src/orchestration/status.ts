import type {
  NetworkRun,
  NodeAttempt,
  NodeState,
  RunInvocation,
} from "../domain/persistence-model.js";
import type {
  NetworkLockStatus,
  NetworkLockStatusReader,
} from "../persistence/network-lock-reader.js";
import { KINTONE_DATETIME_TRUNCATION_MS } from "../persistence/kintone/design-notes.js";
import { RepositoryError } from "../persistence/repository.js";
import type {
  StatusReadRepository,
  Versioned,
} from "../persistence/repository.js";
import { detectReconciliation } from "./reconciliation.js";

export interface StatusInput {
  readonly networkId: string;
  readonly profile: string;
  readonly runId?: string;
  readonly businessKey?: string;
}

export interface StatusDependencies {
  readonly repository: StatusReadRepository;
  readonly lockReader: NetworkLockStatusReader;
  readonly now?: () => Date;
}

export interface StatusOutput {
  readonly network_id: string;
  readonly profile: string;
  readonly lock:
    (NetworkLockStatus & { readonly stale_candidate: boolean }) | null;
  readonly runs: readonly RunStatusOutput[];
}

export interface RunSummaryOutput {
  readonly run_id: string;
  readonly business_key: string;
  readonly status: NetworkRun["status"];
  readonly resume_allowed: boolean;
  readonly lifecycle_status: NetworkRun["lifecycle_status"];
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly updated_at: string;
}

export interface RunStatusOutput extends RunSummaryOutput {
  readonly invocations?: readonly InvocationOutput[];
  readonly node_states?: readonly NodeStateOutput[];
  readonly reconciliation?: {
    readonly inconsistencies: readonly {
      readonly code: string;
      readonly node_id?: string;
      readonly detail: string;
      readonly attempt_ids?: readonly string[];
    }[];
  };
  readonly recovery_identifiers?: {
    readonly resolve_node: readonly {
      readonly run_id: string;
      readonly node_id: string;
    }[];
    readonly force_unlock_network: {
      readonly network_id: string;
      readonly profile: string;
      readonly expected_owner_invocation_id: string;
    } | null;
    readonly run_network: { readonly resume_run: string };
  };
}

interface InvocationOutput {
  readonly invocation_id: string;
  readonly mode: RunInvocation["mode"];
  readonly status: RunInvocation["status"];
  readonly result_code: string;
}

interface ActiveAttemptOutput {
  readonly node_attempt_id: string;
  readonly attempt_no: number;
  readonly status: NodeAttempt["status"];
}

interface NodeStateOutput {
  readonly node_id: string;
  readonly status: NodeState["status"];
  readonly status_reason: string | null;
  readonly idempotent: boolean;
  readonly latest_attempt_no: number;
  readonly active_attempt_id: string | null;
  readonly active_attempt: ActiveAttemptOutput | null;
}

function summary(run: NetworkRun): RunSummaryOutput {
  return {
    run_id: run.run_id,
    business_key: run.business_key,
    status: run.status,
    resume_allowed: run.resume_allowed,
    lifecycle_status: run.lifecycle_status,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    updated_at: run.updated_at,
  };
}

function requireMatchingRun(
  run: Versioned<NetworkRun>,
  input: StatusInput,
): Versioned<NetworkRun> {
  if (
    run.value.network_id !== input.networkId ||
    run.value.resolved_profile_snapshot.profile !== input.profile
  ) {
    throw new RepositoryError(
      "RECORD_NOT_FOUND",
      "the selected Run does not belong to the requested network and profile",
    );
  }
  return run;
}

async function detail(
  run: Versioned<NetworkRun>,
  lock: StatusOutput["lock"],
  repository: StatusReadRepository,
): Promise<RunStatusOutput> {
  const runId = run.value.run_id;
  const [invocations, states, attempts, reconciliation] = await Promise.all([
    repository.getInvocations(runId),
    repository.getNodeStates(runId),
    repository.getAttempts(runId),
    detectReconciliation(repository, runId),
  ]);
  const attemptsById = new Map(
    attempts.map((attempt) => [attempt.value.node_attempt_id, attempt.value]),
  );
  return {
    ...summary(run.value),
    invocations: invocations.map(({ value }) => ({
      invocation_id: value.invocation_id,
      mode: value.mode,
      status: value.status,
      result_code: value.result_code,
    })),
    node_states: states.map(({ value }) => {
      const active =
        value.active_attempt_id === null
          ? undefined
          : attemptsById.get(value.active_attempt_id);
      return {
        node_id: value.node_id,
        status: value.status,
        status_reason: value.status_reason,
        idempotent: value.idempotent,
        latest_attempt_no: value.latest_attempt_no,
        active_attempt_id: value.active_attempt_id,
        active_attempt:
          active === undefined
            ? null
            : {
                node_attempt_id: active.node_attempt_id,
                attempt_no: active.attempt_no,
                status: active.status,
              },
      };
    }),
    reconciliation: {
      inconsistencies: reconciliation.inconsistencies.map((item) => ({
        code: item.code,
        ...(item.nodeId === undefined ? {} : { node_id: item.nodeId }),
        detail: item.detail,
        ...(item.attemptIds === undefined
          ? {}
          : { attempt_ids: item.attemptIds }),
      })),
    },
    recovery_identifiers: {
      resolve_node: states
        .filter(
          ({ value }) =>
            value.status === "UNKNOWN" ||
            (value.status === "FAILED" && !value.idempotent),
        )
        .map(({ value }) => ({ run_id: runId, node_id: value.node_id })),
      force_unlock_network:
        lock === null
          ? null
          : {
              network_id: run.value.network_id,
              profile: run.value.resolved_profile_snapshot.profile,
              expected_owner_invocation_id: lock.owner_invocation_id,
            },
      run_network: { resume_run: runId },
    },
  };
}

export async function inspectStatus(
  input: StatusInput,
  dependencies: StatusDependencies,
): Promise<StatusOutput> {
  const currentTime = (dependencies.now ?? (() => new Date()))().getTime();
  const lockValue = await dependencies.lockReader.getNetworkLock(
    input.profile,
    input.networkId,
  );
  const lock =
    lockValue === null
      ? null
      : {
          record_id: lockValue.record_id,
          owner_invocation_id: lockValue.owner_invocation_id,
          owner_instance_id: lockValue.owner_instance_id,
          heartbeat_at: lockValue.heartbeat_at,
          lease_expires_at: lockValue.lease_expires_at,
          // The persisted lease expiry may be truncated by up to 59 seconds, so add the upper bound before marking it stale.
          stale_candidate:
            currentTime >
            Date.parse(lockValue.lease_expires_at) +
              KINTONE_DATETIME_TRUNCATION_MS,
          revision: lockValue.revision,
        };

  if (input.runId !== undefined || input.businessKey !== undefined) {
    const found =
      input.runId !== undefined
        ? await dependencies.repository.getRun(input.runId)
        : await dependencies.repository.getRunByBusinessKey(
            input.profile,
            input.networkId,
            input.businessKey!,
          );
    if (found === null) {
      throw new RepositoryError("RECORD_NOT_FOUND", "Run was not found");
    }
    const run = requireMatchingRun(found, input);
    return {
      network_id: input.networkId,
      profile: input.profile,
      lock,
      runs: [await detail(run, lock, dependencies.repository)],
    };
  }

  const runs = await dependencies.repository.listRuns(
    input.profile,
    input.networkId,
  );
  return {
    network_id: input.networkId,
    profile: input.profile,
    lock,
    runs: runs.map(({ value }) => summary(value)),
  };
}
