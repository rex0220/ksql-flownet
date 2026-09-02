import {
  assembleActivityInputs,
  parseCancelActionDetails,
  parseCancelRecord,
  parseInvocationRecord,
  parseLockRecord,
  parseRunActionAttributes,
  parseRunRecord,
  type ActivityRun,
  type CancelActionDetails,
  type RunActionAttributes,
} from "./activity-input.js";
import {
  decideBoardAction,
  type PendingActionSummary,
} from "./board-action.js";
import { deriveRunActivity } from "./activity-entry.js";
import { loadErrorSummaries } from "./error-summary.js";
import {
  validateAuditAppId,
  validateRequestAppId,
} from "./config-validation.js";
import {
  readAllByChunks,
  readAllByKeyset,
  type FetchRecords,
} from "./kintone-reader.js";
import { requiredText, type KintoneRecord } from "./kintone-record.js";
import {
  loadPendingRequests,
  loadPendingStartRequests,
  loadTerminalStartRequests,
  type PendingStartRequest,
  type TerminalStartRequest,
} from "./request-client.js";
import {
  loadRecentTerminalRuns,
  loadTerminalRuns,
  type RecentTerminalRun,
} from "./terminal-run-loader.js";
import {
  ACTION_TEXT,
  type ActivityRowViewModel,
  type BoardSectionViewModel,
  type BoardViewModel,
  type TerminalRowViewModel,
} from "./render.js";

const RUN_FIELDS = [
  "$id",
  "record_type",
  "run_id",
  "business_key",
  "status",
  "started_at",
  "lifecycle_status",
  "resume_allowed",
  "updated_at",
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
  readonly recordId: string;
  readonly actionAttributes: RunActionAttributes | null;
}

export interface ActivityLoadDependencies {
  readonly fetchRecords: FetchRecords;
  readonly stateAppId: number | string;
  readonly auditAppId: string;
  readonly requestAppId?: string;
  readonly logAppId?: string;
  readonly nowMs?: () => number;
}

interface CancelResult {
  readonly states: ReadonlyMap<string, "REQUESTED" | "ACCEPTED" | "RELEASED">;
  readonly evidence: ReadonlyMap<string, string>;
  readonly details: ReadonlyMap<string, CancelActionDetails>;
  readonly detailErrors: ReadonlyMap<string, string>;
  readonly errors: ReadonlyMap<string, string>;
}

function parseLoadedRun(record: KintoneRecord): LoadedRun {
  let actionAttributes: RunActionAttributes | null = null;
  try {
    actionAttributes = parseRunActionAttributes(record);
  } catch {
    // activityは従来どおり導出し、操作だけをfail-closedにする。
  }
  return {
    ...parseRunRecord(record),
    businessKey: requiredText(record, "business_key"),
    recordId: requiredText(record, "$id"),
    actionAttributes,
  };
}

function parseCancels(
  records: readonly KintoneRecord[],
  runIds: ReadonlySet<string>,
): CancelResult {
  const states = new Map<string, "REQUESTED" | "ACCEPTED" | "RELEASED">();
  const evidence = new Map<string, string>();
  const details = new Map<string, CancelActionDetails>();
  const detailErrors = new Map<string, string>();
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
      details.delete(runId);
      detailErrors.delete(runId);
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
      try {
        details.set(runId, parseCancelActionDetails(record, runId));
      } catch {
        detailErrors.set(
          runId,
          "停止要求者または停止理由を確認できないため、解除要求を起票できません。",
        );
      }
    } catch {
      errors.set(
        runId,
        "CANCEL_REQUESTの構造が不正です。CLI statusで確認してください。",
      );
    }
  }
  return { states, evidence, details, detailErrors, errors };
}

function actionAttributes(run: LoadedRun): RunActionAttributes {
  return (
    run.actionAttributes ?? {
      lifecycleStatus: "ACTIVE",
      resumeAllowed: false,
      updatedAt: run.startedAt ?? "",
    }
  );
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
    const attributes = actionAttributes(run);
    const releaseInfoError =
      activity === "STOPPED"
        ? (cancel.detailErrors.get(run.runId) ?? null)
        : null;
    const judgementError =
      rowError !== null ||
      run.actionAttributes === null ||
      releaseInfoError !== null;
    return {
      runId: run.runId,
      recordId: run.recordId,
      recordUrl: `/k/${dependencies.stateAppId}/show#record=${run.recordId}`,
      businessKey: run.businessKey,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: attributes.updatedAt,
      activity,
      evidence,
      actionText: activity === null ? "" : ACTION_TEXT[activity],
      judgedAt: nowMs,
      error: rowError,
      actionError: releaseInfoError,
      resumeAllowed: attributes.resumeAllowed,
      lifecycleStatus: attributes.lifecycleStatus,
      cancelDetails: cancel.details.get(run.runId) ?? null,
      errorSummary: { state: "ready", items: [] },
      action: decideBoardAction({
        status: run.status,
        activity,
        resumeAllowed: attributes.resumeAllowed,
        lifecycleStatus: attributes.lifecycleStatus,
        judgementError,
      }),
    };
  });
}

function readySection<T>(rows: readonly T[]): BoardSectionViewModel<T> {
  return { state: "ready", rows, error: null };
}

function failedSection<T>(message: string): BoardSectionViewModel<T> {
  return { state: "error", rows: [], error: message };
}

async function loadActiveSection(
  dependencies: ActivityLoadDependencies,
  nowMs: number,
): Promise<BoardSectionViewModel<ActivityRowViewModel>> {
  const config = validateAuditAppId(dependencies.auditAppId);
  if (!config.valid || config.value === null) {
    return failedSection(
      `${config.message ?? "設定が不正です。"} プラグイン設定を確認してください。`,
    );
  }
  try {
    const runs = (
      await readAllByKeyset(dependencies.fetchRecords, {
        app: dependencies.stateAppId,
        baseQuery:
          'record_type in ("NETWORK_RUN") and status not in ("SUCCESS", "FAILED", "CANCELLED", "UNKNOWN")',
        fields: RUN_FIELDS,
      })
    ).map(parseLoadedRun);
    if (runs.length === 0) return readySection([]);
    return readySection(
      await readSupportingRecords(
        { ...dependencies, auditAppId: config.value },
        runs,
        nowMs,
        true,
      ),
    );
  } catch {
    return failedSection(
      "Run状況を安全に判定できません。閲覧権限・アプリ設定を確認し、CLI statusを正として確認してください。",
    );
  }
}

async function loadAttentionSection(
  dependencies: ActivityLoadDependencies,
): Promise<{
  section: BoardSectionViewModel<TerminalRowViewModel>;
  remaining: number;
}> {
  try {
    const loaded = await loadTerminalRuns(
      dependencies.fetchRecords,
      dependencies.stateAppId,
    );
    const summaries = await loadErrorSummaries(
      dependencies.fetchRecords,
      dependencies.stateAppId,
      dependencies.auditAppId,
      loaded.runs.map((run) => run.runId),
      dependencies.logAppId,
    );
    return {
      section: readySection(
        loaded.runs.map((run) => ({
          ...run,
          recordUrl: `/k/${dependencies.stateAppId}/show#record=${run.recordId}`,
          activity: null,
          actionError: null,
          cancelDetails: null,
          errorSummary: summaries.get(run.runId) ?? { state: "unavailable" },
          action: decideBoardAction({
            status: run.status,
            activity: null,
            resumeAllowed: run.resumeAllowed,
            lifecycleStatus: run.lifecycleStatus,
          }),
        })),
      ),
      remaining: loaded.remainingCount,
    };
  } catch {
    return {
      section: failedSection(
        "終了済み・対応が必要なRunを読み込めません。閲覧権限を確認してください。",
      ),
      remaining: 0,
    };
  }
}

function applyPending<T extends ActivityRowViewModel | TerminalRowViewModel>(
  rows: readonly T[],
  pending: ReadonlyMap<string, PendingActionSummary>,
): readonly T[] {
  return rows.map((row) => ({
    ...row,
    action: decideBoardAction({
      status: row.status,
      activity: row.activity,
      resumeAllowed: row.resumeAllowed,
      lifecycleStatus: row.lifecycleStatus,
      pending: pending.get(row.runId) ?? null,
      judgementError: row.action.kind === "invalid",
    }),
  }));
}

export async function loadBoard(
  dependencies: ActivityLoadDependencies,
): Promise<BoardViewModel> {
  const nowMs = (dependencies.nowMs ?? Date.now)();
  const [activeSection, attention, recentTerminalResult] = await Promise.all([
    loadActiveSection(dependencies, nowMs),
    loadAttentionSection(dependencies),
    loadRecentTerminalRuns(dependencies.fetchRecords, dependencies.stateAppId)
      .then((runs) => ({ state: "ready" as const, runs }))
      .catch(() => ({
        state: "unavailable" as const,
        runs: [] as readonly RecentTerminalRun[],
        warning:
          "最近の終了Runを取得できませんでした。閲覧権限を確認してください。",
      })),
  ]);
  const requestConfig = validateRequestAppId(dependencies.requestAppId ?? "");
  const requestEnabled =
    requestConfig.valid &&
    requestConfig.value !== null &&
    requestConfig.value !== "";
  let pendingWarning: string | null = null;
  let pendingStartCount: number | null = null;
  let pendingStartRequests: readonly PendingStartRequest[] | null = null;
  let terminalStartRequests: readonly TerminalStartRequest[] | null = null;
  let active = activeSection;
  let terminal = attention.section;
  if (requestEnabled) {
    const startPendingPromise = loadPendingStartRequests(
      dependencies.fetchRecords,
      requestConfig.value,
    );
    const startTerminalPromise = loadTerminalStartRequests(
      dependencies.fetchRecords,
      requestConfig.value,
    );
    const runIds = [
      ...(active.state === "ready" ? active.rows.map((row) => row.runId) : []),
      ...(terminal.state === "ready"
        ? terminal.rows.map((row) => row.runId)
        : []),
    ];
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length > 0) {
      const result = await loadPendingRequests(
        dependencies.fetchRecords,
        requestConfig.value,
        uniqueRunIds,
      );
      if (result.state === "unavailable") pendingWarning = result.warning;
      if (active.state === "ready") {
        active = readySection(applyPending(active.rows, result.byRunId));
      }
      if (terminal.state === "ready") {
        terminal = readySection(applyPending(terminal.rows, result.byRunId));
      }
    }
    const startPending = await startPendingPromise;
    if (startPending.state === "ready") {
      pendingStartCount = startPending.summary.count;
      pendingStartRequests = startPending.summary.requests;
    } else {
      pendingWarning =
        pendingWarning === null
          ? startPending.warning
          : `${pendingWarning} ${startPending.warning}`;
    }
    const startTerminal = await startTerminalPromise;
    if (startTerminal.state === "ready") {
      terminalStartRequests = startTerminal.requests;
    } else {
      pendingWarning =
        pendingWarning === null
          ? startTerminal.warning
          : `${pendingWarning} ${startTerminal.warning}`;
    }
  }
  if (recentTerminalResult.state === "unavailable") {
    pendingWarning =
      pendingWarning === null
        ? recentTerminalResult.warning
        : `${pendingWarning} ${recentTerminalResult.warning}`;
  }
  return {
    activeSection: active,
    attentionSection: terminal,
    attentionRemainingCount: attention.remaining,
    pendingWarning,
    pendingStartCount,
    pendingStartRequests,
    terminalStartRequests,
    recentTerminalRuns:
      recentTerminalResult.state === "ready" ? recentTerminalResult.runs : null,
    stateAppId: String(dependencies.stateAppId),
    requestEnabled,
    requestAppId: requestEnabled ? requestConfig.value : null,
    judgedAt: nowMs,
    // P2-08の外部単体利用との互換値。描画の正本はsection model。
    state: active.state,
    rows: active.rows,
    error: active.error,
  };
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
