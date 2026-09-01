import {
  assembleActivityInputs,
  parseCancelRecord,
  parseInvocationRecord,
  parseLockRecord,
  parseRunRecord,
  type ActivityRun,
} from "./activity-input.js";
import { deriveRunActivity } from "./activity-entry.js";
import { validateAuditAppId } from "./config-validation.js";
import {
  readAllByChunks,
  readAllByKeyset,
  type FetchRecords,
} from "./kintone-reader.js";
import { requiredText, type KintoneRecord } from "./kintone-record.js";
import {
  ACTION_TEXT,
  type ActivityRowViewModel,
  type BoardViewModel,
} from "./render.js";

const RUN_FIELDS = [
  "$id",
  "record_type",
  "run_id",
  "business_key",
  "status",
  "started_at",
] as const;
const LOCK_FIELDS = [
  "$id",
  "record_type",
  "status",
  "owner_invocation_id",
  "status_reason",
  "heartbeat_at",
  "lease_expires_at",
  "revision",
] as const;
const CANCEL_FIELDS = [
  "$id",
  "record_type",
  "record_key",
  "run_id",
  "status_reason",
] as const;
const INVOCATION_FIELDS = [
  "$id",
  "record_type",
  "invocation_id",
  "run_id",
] as const;

export interface LoadedRun extends ActivityRun {
  readonly businessKey: string;
}

export interface ActivityLoadDependencies {
  readonly fetchRecords: FetchRecords;
  readonly stateAppId: number | string;
  readonly auditAppId: string;
  readonly nowMs?: () => number;
}

interface CancelResult {
  readonly states: ReadonlyMap<string, "REQUESTED" | "ACCEPTED" | "RELEASED">;
  readonly evidence: ReadonlyMap<string, string>;
  readonly errors: ReadonlyMap<string, string>;
}

function parseLoadedRun(record: KintoneRecord): LoadedRun {
  return {
    ...parseRunRecord(record),
    businessKey: requiredText(record, "business_key"),
  };
}

function parseCancels(
  records: readonly KintoneRecord[],
  runIds: ReadonlySet<string>,
): CancelResult {
  const states = new Map<string, "REQUESTED" | "ACCEPTED" | "RELEASED">();
  const evidence = new Map<string, string>();
  const errors = new Map<string, string>();
  for (const record of records) {
    const runId = requiredText(record, "run_id");
    if (!runIds.has(runId)) {
      throw new Error(
        "CANCEL_REQUESTが対象外のRunを参照しています。CLI statusで確認してください。",
      );
    }
    if (states.has(runId) || errors.has(runId)) {
      states.delete(runId);
      evidence.delete(runId);
      errors.set(
        runId,
        "CANCEL_REQUESTが重複しています。CLI statusで確認してください。",
      );
      continue;
    }
    try {
      const state = parseCancelRecord(record, runId);
      states.set(runId, state);
      evidence.set(runId, `Cancel #${requiredText(record, "$id")} / ${state}`);
    } catch {
      errors.set(
        runId,
        "CANCEL_REQUESTの構造が不正です。CLI statusで確認してください。",
      );
    }
  }
  return { states, evidence, errors };
}

async function readSupportingRecords(
  dependencies: ActivityLoadDependencies,
  runs: readonly LoadedRun[],
  nowMs: number,
  requireEveryOwnerInRunSet: boolean,
): Promise<readonly ActivityRowViewModel[]> {
  const locks = (
    await readAllByKeyset(dependencies.fetchRecords, {
      app: dependencies.stateAppId,
      baseQuery: 'record_type in ("NETWORK_LOCK") and status in ("RUNNING")',
      fields: LOCK_FIELDS,
    })
  ).map(parseLockRecord);

  const runIds = runs.map((run) => run.runId);
  const cancelRecords = await readAllByChunks(dependencies.fetchRecords, {
    app: dependencies.stateAppId,
    baseQuery: 'record_type in ("CANCEL_REQUEST")',
    field: "run_id",
    values: runIds,
    fields: CANCEL_FIELDS,
  });
  const cancel = parseCancels(cancelRecords, new Set(runIds));

  const ownerIds = [...new Set(locks.map((lock) => lock.owner_invocation_id))];
  const allOwnerInvocations =
    ownerIds.length === 0
      ? []
      : (
          await readAllByChunks(dependencies.fetchRecords, {
            app: dependencies.auditAppId,
            baseQuery: 'record_type in ("RUN_INVOCATION")',
            field: "invocation_id",
            values: ownerIds,
            fields: INVOCATION_FIELDS,
          })
        ).map(parseInvocationRecord);
  const invocationIds = new Set<string>();
  for (const invocation of allOwnerInvocations) {
    if (invocationIds.has(invocation.invocationId)) {
      throw new Error("owner RUN_INVOCATIONが重複しています。");
    }
    invocationIds.add(invocation.invocationId);
  }
  const targetRunIds = new Set(runs.map((run) => run.runId));
  const ownerInvocations = requireEveryOwnerInRunSet
    ? allOwnerInvocations
    : allOwnerInvocations.filter((invocation) =>
        targetRunIds.has(invocation.runId),
      );
  const targetOwnerIds = new Set(
    ownerInvocations.map((invocation) => invocation.invocationId),
  );
  const relevantLocks = requireEveryOwnerInRunSet
    ? locks
    : locks.filter((lock) => targetOwnerIds.has(lock.owner_invocation_id));

  const inputs = assembleActivityInputs({
    runs,
    locks: relevantLocks,
    ownerInvocations,
    cancelStates: cancel.states,
    nowMs,
  });
  const lockByOwner = new Map(
    relevantLocks.map((lock) => [lock.owner_invocation_id, lock] as const),
  );
  const ownerByRun = new Map(
    ownerInvocations.map(
      (invocation) => [invocation.runId, invocation.invocationId] as const,
    ),
  );

  return runs.map((run) => {
    const input = inputs.get(run.runId);
    if (input === undefined) throw new Error("Runの導出入力がありません。");
    const rowError = cancel.errors.get(run.runId) ?? null;
    const activity = rowError === null ? deriveRunActivity(input) : null;
    let evidence = "根拠なし";
    if (activity === "LIVE") {
      const ownerId = ownerByRun.get(run.runId);
      const lock = ownerId === undefined ? undefined : lockByOwner.get(ownerId);
      if (ownerId !== undefined && lock !== undefined) {
        evidence = `owner ${ownerId} / lease ${lock.lease_expires_at}`;
      }
    } else if (activity === "STOPPED") {
      evidence = cancel.evidence.get(run.runId) ?? "Cancel要求あり";
    }
    return {
      runId: run.runId,
      businessKey: run.businessKey,
      status: run.status,
      startedAt: run.startedAt,
      activity,
      evidence,
      actionText: activity === null ? "" : ACTION_TEXT[activity],
      judgedAt: nowMs,
      error: rowError,
    };
  });
}

function errorModel(message: string): BoardViewModel {
  return { state: "error", rows: [], judgedAt: null, error: message };
}

export async function loadBoard(
  dependencies: ActivityLoadDependencies,
): Promise<BoardViewModel> {
  const config = validateAuditAppId(dependencies.auditAppId);
  if (!config.valid || config.value === null) {
    return errorModel(
      `${config.message ?? "設定が不正です。"} プラグイン設定を確認してください。`,
    );
  }
  const nowMs = (dependencies.nowMs ?? Date.now)();
  try {
    const runs = (
      await readAllByKeyset(dependencies.fetchRecords, {
        app: dependencies.stateAppId,
        baseQuery:
          'record_type in ("NETWORK_RUN") and status not in ("SUCCESS", "FAILED", "CANCELLED", "UNKNOWN")',
        fields: RUN_FIELDS,
      })
    ).map(parseLoadedRun);
    if (runs.length === 0) {
      return { state: "ready", rows: [], judgedAt: nowMs, error: null };
    }
    const rows = await readSupportingRecords(
      { ...dependencies, auditAppId: config.value },
      runs,
      nowMs,
      true,
    );
    return { state: "ready", rows, judgedAt: nowMs, error: null };
  } catch {
    return errorModel(
      "Run状況を安全に判定できません。閲覧権限・アプリ設定を確認し、CLI statusを正として確認してください。",
    );
  }
}

export async function loadRowsForRuns(
  dependencies: ActivityLoadDependencies,
  runs: readonly LoadedRun[],
  nowMs: number,
): Promise<readonly ActivityRowViewModel[]> {
  const config = validateAuditAppId(dependencies.auditAppId);
  if (!config.valid || config.value === null) {
    throw new Error(config.message ?? "監査履歴アプリIDが不正です。");
  }
  return readSupportingRecords(
    { ...dependencies, auditAppId: config.value },
    runs,
    nowMs,
    false,
  );
}

export interface BoardControllerView {
  loading(): void;
  render(model: BoardViewModel, reload: () => void): void;
}

export class BoardController {
  private generation = 0;

  public constructor(
    private readonly loader: () => Promise<BoardViewModel>,
    private readonly view: BoardControllerView,
  ) {}

  public reload(): void {
    const generation = ++this.generation;
    this.view.loading();
    void this.loader().then((model) => {
      if (generation !== this.generation) return;
      this.view.render(model, () => this.reload());
    });
  }

  public invalidate(): void {
    this.generation += 1;
  }
}
