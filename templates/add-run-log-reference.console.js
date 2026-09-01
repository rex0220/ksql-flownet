/* global confirm, console, kintone, prompt, setTimeout */

/**
 * 実行管理アプリのNETWORK_RUN詳細画面へ、JOBログの関連レコード一覧を追加する(ブラウザConsole用)。
 * 紐付け: 自アプリ run_id = JOBログアプリ correlation_id。表示専用(レコードデータへの書込みなし)。
 * 閲覧にはJOBログアプリの閲覧権限が必要(編集権限は不要・付与しない)。
 */
(async () => {
  "use strict";

  const FIELD_CODE = "related_job_logs";

  const stateInput = prompt("実行管理アプリのIDを入力してください。");
  if (stateInput === null) return void console.warn("中止しました。");
  const logInput = prompt("JOBログアプリのIDを入力してください。");
  if (logInput === null) return void console.warn("中止しました。");
  const app = stateInput.trim();
  const logApp = logInput.trim();
  if (!/^[1-9]\d*$/.test(app) || !/^[1-9]\d*$/.test(logApp)) {
    return void console.error("アプリIDは正の整数で入力してください。");
  }

  const api = (endpoint, method, body) =>
    kintone.api(kintone.api.url(`/k/v1${endpoint}.json`, true), method, body);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let step = "事前確認";
  try {
    const fields = await api("/preview/app/form/fields", "GET", { app });
    if (!fields.properties?.run_id) {
      throw new Error(
        "run_idフィールドがありません(実行管理アプリのIDを確認)。",
      );
    }
    // 既にフィールドがある場合(前回デプロイ前中断を含む)は追加をスキップしデプロイへ進む
    const alreadyAdded = Object.hasOwn(fields.properties, FIELD_CODE);
    if (!alreadyAdded) {
      const logFields = await api("/preview/app/form/fields", "GET", {
        app: logApp,
      });
      for (const code of [
        "correlation_id",
        "job_id",
        "status",
        "error_message",
      ]) {
        if (!Object.hasOwn(logFields.properties, code)) {
          throw new Error(`JOBログアプリに ${code} がありません(IDを確認)。`);
        }
      }

      step = "フィールド追加";
      await api("/preview/app/form/fields", "POST", {
        app,
        properties: {
          [FIELD_CODE]: {
            type: "REFERENCE_TABLE",
            code: FIELD_CODE,
            label: "関連JOBログ(このRunの実行ログ — エラー全文はここ)",
            referenceTable: {
              relatedApp: { app: logApp },
              condition: { field: "run_id", relatedField: "correlation_id" },
              displayFields: [
                "job_id",
                "status",
                "error_message",
                "started_at",
                "finished_at",
                "execution_id",
              ],
              sort: "$id desc",
              size: "10",
            },
          },
        },
      });
    } else {
      console.log(`${FIELD_CODE} はpreviewに追加済み — デプロイへ進みます。`);
    }

    // REFERENCE_TABLEは追加時にkintoneが自動でレイアウトへ配置する(2026-09-01実機:
    // 明示追記すると重複エラー)。レイアウトに無い場合だけ末尾へ追記する。
    step = "レイアウト設定";
    const current = await api("/preview/app/form/layout", "GET", { app });
    const inLayout = current.layout.some(
      (row) =>
        Array.isArray(row.fields) &&
        row.fields.some((field) => field.code === FIELD_CODE),
    );
    if (!inLayout) {
      await api("/preview/app/form/layout", "PUT", {
        app,
        layout: [
          ...current.layout,
          {
            type: "ROW",
            fields: [{ type: "REFERENCE_TABLE", code: FIELD_CODE }],
          },
        ],
      });
    }

    step = "デプロイ確認";
    if (!confirm("関連JOBログの一覧をデプロイしますか？")) {
      console.warn("previewの変更を画面から中止してください。");
      return;
    }
    step = "デプロイ";
    await api("/preview/app/deploy", "POST", { apps: [{ app }] });
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const status = await api("/preview/app/deploy", "GET", { apps: [app] });
      const state = status.apps?.[0]?.status;
      if (state === "SUCCESS") {
        console.log("関連JOBログの追加が完了しました。");
        return;
      }
      if (state === "FAIL" || state === "CANCEL")
        throw new Error(`デプロイが${state}で終了しました。`);
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  } catch (error) {
    console.error(`失敗した処理: ${step}`);
    console.error(error instanceof Error ? error.message : String(error));
    if (error && typeof error === "object" && !(error instanceof Error)) {
      console.error(JSON.stringify(error, null, 2));
    }
    console.error("previewに変更が残った場合は画面から中止してください。");
  }
})();
