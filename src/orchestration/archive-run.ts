import { randomUUID } from "node:crypto";
import type {
  NetworkRun,
  OperationAudit,
  RunArchivedOperationAudit,
} from "../domain/persistence-model.js";
import {
  RepositoryError,
  type PersistenceRepository,
  type Versioned,
} from "../persistence/repository.js";
import type { NetworkLockReference } from "../persistence/network-lock.js";

export type ArchiveRejectedCode =
  | "LOCK_CONFLICT"
  | "LOCK_UNAVAILABLE"
  | "LEASE_INTERRUPTED"
  | "RUN_READ_FAILED"
  | "RUN_STATUS_NOT_CLOSABLE"
  | "RUN_UNKNOWN_NOT_CLOSABLE"
  | "RUN_NOT_TERMINAL"
  | "RUN_ON_HOLD"
  | "RUN_LIVE"
  | "ARCHIVE_WRITE_FAILED";
export type ArchivePendingCode =
  "ARCHIVE_AUDIT_FAILED" | "AUDIT_CONFLICT" | "LEASE_INTERRUPTED_AFTER_ARCHIVE";
type Base = {
  readonly run_id: string;
  readonly event_id: string;
  readonly lock_released: boolean;
};
export type ArchiveRunOutcome =
  | (Base & {
      readonly outcome: "ARCHIVED";
      readonly run_revision: number;
      readonly audit: "RECORDED";
    })
  | (Base & {
      readonly outcome: "ARCHIVED";
      readonly run_revision: number;
      readonly audit: "PENDING";
      readonly code: ArchivePendingCode;
    })
  | (Base & {
      readonly outcome: "ALREADY_ARCHIVED";
      readonly run_revision: number;
    })
  | (Base & {
      readonly outcome: "UNCONFIRMED";
      readonly run_revision: null;
      readonly code: "ARCHIVE_UNCONFIRMED";
    })
  | (Base & {
      readonly outcome: "REJECTED";
      readonly run_revision: number | null;
      readonly code: ArchiveRejectedCode;
    });
type BeforeRelease = ArchiveRunOutcome extends infer T
  ? T extends Base
    ? Omit<T, "lock_released">
    : never
  : never;

export interface ArchiveLockManager {
  acquire(): Promise<NetworkLockReference>;
  release(reference: NetworkLockReference): Promise<unknown>;
}
export interface ArchiveLeaseMonitor {
  start(): void;
  stop(): void;
  tick(): Promise<boolean>;
}
export interface ArchiveRunInput {
  repository: PersistenceRepository;
  lockManagerFactory: (owner: string) => ArchiveLockManager;
  leaseMonitorFactory: (
    manager: ArchiveLockManager,
    reference: NetworkLockReference,
  ) => ArchiveLeaseMonitor;
  runId: string;
  requestedBy: string;
  reason: string;
  servicePrincipal: string;
  now?: () => Date;
  uuid?: () => string;
}

const hold = (
  value: Awaited<ReturnType<PersistenceRepository["getCancelRequest"]>>,
) => value?.value.state === "REQUESTED" || value?.value.state === "ACCEPTED";
const sameAudit = (
  left: OperationAudit,
  right: RunArchivedOperationAudit,
): boolean =>
  left.event_id === right.event_id &&
  left.event_type === "RUN_ARCHIVED" &&
  left.run_id === right.run_id &&
  left.previous_status === right.previous_status &&
  left.run_revision_before === right.run_revision_before;

export async function archiveRun(
  input: ArchiveRunInput,
): Promise<ArchiveRunOutcome> {
  const eventId = `archive_${(input.uuid ?? randomUUID)()}`;
  const base = { run_id: input.runId, event_id: eventId };
  const manager = input.lockManagerFactory(eventId);
  let reference: NetworkLockReference;
  try {
    reference = await manager.acquire();
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "LOCK_CONFLICT"
        ? "LOCK_CONFLICT"
        : "LOCK_UNAVAILABLE";
    return {
      ...base,
      outcome: "REJECTED",
      run_revision: null,
      code,
      lock_released: true,
    };
  }
  const monitor = input.leaseMonitorFactory(manager, reference);
  let result: BeforeRelease;
  let cleaned = false;
  try {
    monitor.start();
    let run: Versioned<NetworkRun>;
    try {
      run = await input.repository.getRun(input.runId);
    } catch {
      result = {
        ...base,
        outcome: "REJECTED",
        run_revision: null,
        code: "RUN_READ_FAILED",
      };
      return await finish();
    }
    if (run.value.lifecycle_status === "ARCHIVED") {
      result = {
        ...base,
        outcome: "ALREADY_ARCHIVED",
        run_revision: run.revision,
      };
      return await finish();
    }
    const code =
      run.value.status === "SUCCESS"
        ? "RUN_STATUS_NOT_CLOSABLE"
        : run.value.status === "UNKNOWN"
          ? "RUN_UNKNOWN_NOT_CLOSABLE"
          : run.value.status === "CREATED" || run.value.status === "RUNNING"
            ? "RUN_NOT_TERMINAL"
            : null;
    if (code !== null) {
      result = {
        ...base,
        outcome: "REJECTED",
        run_revision: run.revision,
        code,
      };
      return await finish();
    }
    try {
      if (hold(await input.repository.getCancelRequest(input.runId))) {
        result = {
          ...base,
          outcome: "REJECTED",
          run_revision: run.revision,
          code: "RUN_ON_HOLD",
        };
        return await finish();
      }
    } catch {
      result = {
        ...base,
        outcome: "REJECTED",
        run_revision: run.revision,
        code: "RUN_READ_FAILED",
      };
      return await finish();
    }
    // RUN_LIVE(G-02: lock owner が当該 Run の Invocation に属し lease 生存)は
    // ポーラーの一次審査で判定する。ここでは Network ロックを保持しているため
    // 生存中の Invocation は存在し得ない。Invocation レコードの RUNNING 残骸
    // (クラッシュ後の未 finalize)は reconciliation の対象であり、CLOSE を阻まない。
    if (!(await monitor.tick())) {
      result = {
        ...base,
        outcome: "REJECTED",
        run_revision: run.revision,
        code: "LEASE_INTERRUPTED",
      };
      return await finish();
    }

    let archived: Versioned<NetworkRun> | null = null;
    let already = false;
    try {
      archived = await input.repository.archiveRun(
        input.runId,
        run.revision,
        (input.now ?? (() => new Date()))().toISOString(),
      );
    } catch (first) {
      const ambiguous =
        first instanceof RepositoryError && first.code === "AMBIGUOUS_WRITE";
      const conflict =
        first instanceof RepositoryError && first.code === "REVISION_CONFLICT";
      let reread: Versioned<NetworkRun>;
      try {
        reread = await input.repository.getRun(input.runId);
      } catch {
        result = {
          ...base,
          outcome: "UNCONFIRMED",
          run_revision: null,
          code: "ARCHIVE_UNCONFIRMED",
        };
        return await finish();
      }
      if (reread.value.lifecycle_status === "ARCHIVED") {
        archived = reread;
        already = conflict;
      } else if (conflict) {
        result = {
          ...base,
          outcome: "UNCONFIRMED",
          run_revision: null,
          code: "ARCHIVE_UNCONFIRMED",
        };
        return await finish();
      } else if (!ambiguous) {
        result = {
          ...base,
          outcome: "REJECTED",
          run_revision: reread.revision,
          code: "ARCHIVE_WRITE_FAILED",
        };
        return await finish();
      } else {
        if (!(await monitor.tick())) {
          result = {
            ...base,
            outcome: "REJECTED",
            run_revision: reread.revision,
            code: "LEASE_INTERRUPTED",
          };
          return await finish();
        }
        try {
          archived = await input.repository.archiveRun(
            input.runId,
            reread.revision,
            (input.now ?? (() => new Date()))().toISOString(),
          );
        } catch {
          try {
            const final = await input.repository.getRun(input.runId);
            if (final.value.lifecycle_status === "ARCHIVED") archived = final;
            else {
              result = {
                ...base,
                outcome: "REJECTED",
                run_revision: final.revision,
                code: "ARCHIVE_WRITE_FAILED",
              };
              return await finish();
            }
          } catch {
            result = {
              ...base,
              outcome: "UNCONFIRMED",
              run_revision: null,
              code: "ARCHIVE_UNCONFIRMED",
            };
            return await finish();
          }
        }
      }
    }
    if (already) {
      result = {
        ...base,
        outcome: "ALREADY_ARCHIVED",
        run_revision: archived!.revision,
      };
      return await finish();
    }
    if (!(await monitor.tick())) {
      result = {
        ...base,
        outcome: "ARCHIVED",
        run_revision: archived!.revision,
        audit: "PENDING",
        code: "LEASE_INTERRUPTED_AFTER_ARCHIVE",
      };
      return await finish();
    }
    const audit: RunArchivedOperationAudit = {
      event_id: eventId as `archive_${string}`,
      event_type: "RUN_ARCHIVED",
      run_id: input.runId,
      result_code: "RUN_ARCHIVED",
      requested_by: input.requestedBy,
      reason: input.reason,
      archived_at: archived!.value.updated_at,
      previous_status: run.value.status as "FAILED" | "CANCELLED",
      run_revision_before: run.revision,
      service_principal: input.servicePrincipal,
    };
    try {
      await input.repository.appendOperationAudit(audit);
      result = {
        ...base,
        outcome: "ARCHIVED",
        run_revision: archived!.revision,
        audit: "RECORDED",
      };
    } catch (error) {
      if (error instanceof RepositoryError && error.code === "AUDIT_CONFLICT")
        result = {
          ...base,
          outcome: "ARCHIVED",
          run_revision: archived!.revision,
          audit: "PENDING",
          code: "AUDIT_CONFLICT",
        };
      else if (
        error instanceof RepositoryError &&
        error.code === "AMBIGUOUS_WRITE"
      ) {
        try {
          const found =
            await input.repository.getOperationAuditByEventId(eventId);
          if (found !== null && sameAudit(found.value, audit))
            result = {
              ...base,
              outcome: "ARCHIVED",
              run_revision: archived!.revision,
              audit: "RECORDED",
            };
          else if (found !== null)
            result = {
              ...base,
              outcome: "ARCHIVED",
              run_revision: archived!.revision,
              audit: "PENDING",
              code: "AUDIT_CONFLICT",
            };
          else {
            try {
              await input.repository.appendOperationAudit(audit);
              result = {
                ...base,
                outcome: "ARCHIVED",
                run_revision: archived!.revision,
                audit: "RECORDED",
              };
            } catch {
              result = {
                ...base,
                outcome: "ARCHIVED",
                run_revision: archived!.revision,
                audit: "PENDING",
                code: "ARCHIVE_AUDIT_FAILED",
              };
            }
          }
        } catch {
          result = {
            ...base,
            outcome: "ARCHIVED",
            run_revision: archived!.revision,
            audit: "PENDING",
            code: "ARCHIVE_AUDIT_FAILED",
          };
        }
      } else
        result = {
          ...base,
          outcome: "ARCHIVED",
          run_revision: archived!.revision,
          audit: "PENDING",
          code: "ARCHIVE_AUDIT_FAILED",
        };
    }
    return await finish();
  } finally {
    if (!cleaned) {
      monitor.stop();
      try {
        await manager.release(reference);
      } catch {
        // Preserve the unexpected primary exception after attempting cleanup.
      }
    }
  }

  async function finish(): Promise<ArchiveRunOutcome> {
    monitor.stop();
    let released = true;
    try {
      await manager.release(reference);
    } catch {
      released = false;
    }
    cleaned = true;
    return { ...result, lock_released: released } as ArchiveRunOutcome;
  }
}
