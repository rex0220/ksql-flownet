import { parseRunRecord } from "./activity-input.js";
import {
  loadRowsForRuns,
  type ActivityLoadDependencies,
  type LoadedRun,
} from "./board-controller.js";
import { requiredText, type KintoneRecord } from "./kintone-record.js";
import type { DetailViewModel } from "./render.js";

const TERMINAL_STATUSES = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);

export async function loadDetail(
  dependencies: ActivityLoadDependencies,
  record: KintoneRecord,
): Promise<DetailViewModel> {
  try {
    const run = parseRunRecord(record);
    if (TERMINAL_STATUSES.has(run.status)) return { state: "terminal" };
    const nowMs = (dependencies.nowMs ?? Date.now)();
    const loadedRun: LoadedRun = {
      ...run,
      businessKey: requiredText(record, "business_key"),
    };
    const rows = await loadRowsForRuns(dependencies, [loadedRun], nowMs);
    const row = rows[0];
    if (row === undefined) throw new Error("Runの表示モデルがありません。");
    return { state: "ready", row };
  } catch {
    return {
      state: "error",
      error:
        "Run activityを安全に判定できません。閲覧権限・アプリ設定を確認し、CLI statusを正として確認してください。",
    };
  }
}
