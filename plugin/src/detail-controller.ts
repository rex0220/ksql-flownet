import {
  parseRunActionAttributes,
  parseRunRecord,
  type RunActionAttributes,
} from "./activity-input.js";
import { decideBoardAction } from "./board-action.js";
import { loadErrorSummaries } from "./error-summary.js";
import {
  loadRowsForRuns,
  type ActivityLoadDependencies,
  type LoadedRun,
} from "./board-controller.js";
import { validateRequestAppId } from "./config-validation.js";
import { requiredText, type KintoneRecord } from "./kintone-record.js";
import { loadPendingRequests } from "./request-client.js";
import type {
  ActionRowViewModel,
  DetailViewModel,
  TerminalRowViewModel,
} from "./render.js";

const TERMINAL_STATUSES = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);

function requestSettings(dependencies: ActivityLoadDependencies): {
  enabled: boolean;
  appId: string | null;
} {
  const result = validateRequestAppId(dependencies.requestAppId ?? "");
  const enabled = result.valid && result.value !== null && result.value !== "";
  return { enabled, appId: enabled ? result.value : null };
}

async function withPending<T extends ActionRowViewModel>(
  dependencies: ActivityLoadDependencies,
  row: T,
  requestAppId: string | null,
): Promise<T> {
  if (requestAppId === null) return row;
  const pending = await loadPendingRequests(
    dependencies.fetchRecords,
    requestAppId,
    [row.runId],
  );
  return {
    ...row,
    action: decideBoardAction({
      status: row.status,
      activity: row.activity,
      resumeAllowed: row.resumeAllowed,
      lifecycleStatus: row.lifecycleStatus,
      pending: pending.byRunId.get(row.runId) ?? null,
      judgementError: row.action.kind === "invalid",
    }),
  };
}

export async function loadDetail(
  dependencies: ActivityLoadDependencies,
  record: KintoneRecord,
): Promise<DetailViewModel> {
  try {
    const run = parseRunRecord(record);
    const settings = requestSettings(dependencies);
    const nowMs = (dependencies.nowMs ?? Date.now)();
    if (TERMINAL_STATUSES.has(run.status)) {
      const attributes = parseRunActionAttributes(record);
      const terminalRow: TerminalRowViewModel = {
        runId: run.runId,
        recordId: requiredText(record, "$id"),
        recordUrl: `/k/${dependencies.stateAppId}/show#record=${requiredText(record, "$id")}`,
        businessKey: requiredText(record, "business_key"),
        status: run.status,
        updatedAt: attributes.updatedAt,
        activity: null,
        resumeAllowed: attributes.resumeAllowed,
        lifecycleStatus: attributes.lifecycleStatus,
        actionError: null,
        cancelDetails: null,
        errorSummary:
          run.status === "SUCCESS"
            ? { state: "ready", items: [] }
            : ((
                await loadErrorSummaries(
                  dependencies.fetchRecords,
                  dependencies.stateAppId,
                  dependencies.auditAppId,
                  [run.runId],
                  dependencies.logAppId,
                )
              ).get(run.runId) ?? { state: "unavailable" }),
        action: decideBoardAction({
          status: run.status,
          activity: null,
          resumeAllowed: attributes.resumeAllowed,
          lifecycleStatus: attributes.lifecycleStatus,
        }),
      };
      return {
        state: "ready",
        row: await withPending(dependencies, terminalRow, settings.appId),
        terminal: true,
        requestEnabled: settings.enabled,
        requestAppId: settings.appId,
        allowRerunFromNode:
          run.status === "FAILED" || run.status === "CANCELLED",
      };
    }
    let attributes: RunActionAttributes | null = null;
    try {
      attributes = parseRunActionAttributes(record);
    } catch {
      // loadRowsForRunsが操作だけをfail-closedにする。
    }
    const loadedRun: LoadedRun = {
      ...run,
      businessKey: requiredText(record, "business_key"),
      recordId: requiredText(record, "$id"),
      actionAttributes: attributes,
    };
    const rows = await loadRowsForRuns(dependencies, [loadedRun], nowMs);
    const row = rows[0];
    if (row === undefined) throw new Error("Runの表示モデルがありません。");
    return {
      state: "ready",
      row: await withPending(dependencies, row, settings.appId),
      terminal: false,
      requestEnabled: settings.enabled,
      requestAppId: settings.appId,
      allowRerunFromNode: false,
    };
  } catch {
    return {
      state: "error",
      error:
        "Run activityを安全に判定できません。閲覧権限・アプリ設定を確認し、CLI statusを正として確認してください。",
    };
  }
}
