/* global confirm, console, kintone, prompt, setTimeout */

/**
 * 実行管理アプリのNETWORK_RUN詳細画面へ、監査履歴・操作要求・JOBログの
 * 関連レコード一覧を追加する(ブラウザConsole用)。既存フィールドは変更しない。
 */
(async () => {
  "use strict";

  const prompts = [
    ["実行管理アプリ", "実行管理アプリのIDを入力してください。"],
    ["監査履歴アプリ", "監査履歴アプリのIDを入力してください。"],
    ["操作要求アプリ", "操作要求アプリのIDを入力してください。"],
    ["JOBログアプリ", "JOBログアプリのIDを入力してください。"],
  ];
  const ids = [];
  for (const [, message] of prompts) {
    const input = prompt(message);
    if (input === null) return void console.warn("中止しました。");
    const value = input.trim();
    if (!/^[1-9]\d*$/.test(value)) {
      return void console.error("アプリIDは正の整数で入力してください。");
    }
    ids.push(value);
  }
  const [app, auditApp, requestApp, logApp] = ids;

  const api = (endpoint, method, body) =>
    kintone.api(kintone.api.url(`/k/v1${endpoint}.json`, true), method, body);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const definitions = {
    related_audit_events: {
      sourceApp: auditApp,
      sourceLabel: "監査履歴アプリ",
      requiredFields: [
        "run_id",
        "record_type",
        "node_id",
        "status",
        "result_code",
        "requested_by",
        "invocation_id",
      ],
      property: {
        type: "REFERENCE_TABLE",
        code: "related_audit_events",
        label: "関連監査イベント",
        referenceTable: {
          relatedApp: { app: auditApp },
          condition: { field: "run_id", relatedField: "run_id" },
          displayFields: [
            "record_type",
            "node_id",
            "status",
            "result_code",
            "requested_by",
            "invocation_id",
          ],
          sort: "$id desc",
          size: "10",
        },
      },
    },
    related_requests: {
      sourceApp: requestApp,
      sourceLabel: "操作要求アプリ",
      requiredFields: [
        "run_id",
        "request_type",
        "request_state",
        "result_code",
        "reason",
        "作成日時",
      ],
      property: {
        type: "REFERENCE_TABLE",
        code: "related_requests",
        label: "関連操作要求",
        referenceTable: {
          relatedApp: { app: requestApp },
          condition: { field: "run_id", relatedField: "run_id" },
          displayFields: [
            "request_type",
            "request_state",
            "result_code",
            "reason",
            "作成日時",
          ],
          sort: "$id desc",
          size: "5",
        },
      },
    },
    // 既存の関連JOBログ定義は変更しない。
    related_job_logs: {
      sourceApp: logApp,
      sourceLabel: "JOBログアプリ",
      requiredFields: [
        "correlation_id",
        "job_id",
        "status",
        "error_message",
        "started_at",
        "finished_at",
        "execution_id",
      ],
      property: {
        type: "REFERENCE_TABLE",
        code: "related_job_logs",
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
  };

  let step = "事前確認";
  try {
    const fields = await api("/preview/app/form/fields", "GET", { app });
    if (!fields.properties?.run_id) {
      throw new Error(
        "run_idフィールドがありません(実行管理アプリのIDを確認)。",
      );
    }
    const missing = Object.entries(definitions).filter(
      ([code]) => !Object.hasOwn(fields.properties, code),
    );
    for (const [code] of Object.entries(definitions)) {
      if (!missing.some(([missingCode]) => missingCode === code)) {
        console.log(`${code} はpreviewに追加済み — 定義を変更しません。`);
      }
    }

    const sourceFields = new Map();
    for (const [, definition] of missing) {
      if (!sourceFields.has(definition.sourceApp)) {
        sourceFields.set(
          definition.sourceApp,
          await api("/preview/app/form/fields", "GET", {
            app: definition.sourceApp,
          }),
        );
      }
      const properties = sourceFields.get(definition.sourceApp).properties;
      for (const code of definition.requiredFields) {
        if (!Object.hasOwn(properties, code)) {
          throw new Error(
            `${definition.sourceLabel}に ${code} がありません(IDを確認)。`,
          );
        }
      }
    }

    if (missing.length > 0) {
      step = "フィールド追加";
      await api("/preview/app/form/fields", "POST", {
        app,
        properties: Object.fromEntries(
          missing.map(([code, definition]) => [code, definition.property]),
        ),
      });
    }

    // REFERENCE_TABLEは追加時にkintoneが自動でレイアウトへ配置する(2026-09-01実機:
    // 明示追記すると重複エラー)。未デプロイ状態からの再開時も、無いものだけを追記する。
    step = "レイアウト設定";
    const current = await api("/preview/app/form/layout", "GET", { app });
    const codesInLayout = new Set(
      current.layout.flatMap((row) =>
        Array.isArray(row.fields) ? row.fields.map((field) => field.code) : [],
      ),
    );
    const missingRows = Object.keys(definitions)
      .filter((code) => !codesInLayout.has(code))
      .map((code) => ({
        type: "ROW",
        fields: [{ type: "REFERENCE_TABLE", code }],
      }));
    if (missingRows.length > 0) {
      await api("/preview/app/form/layout", "PUT", {
        app,
        layout: [...current.layout, ...missingRows],
      });
    }

    step = "デプロイ確認";
    if (!confirm("3種の関連レコード一覧をデプロイしますか？")) {
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
        console.log("3種の関連レコード一覧の追加が完了しました。");
        return;
      }
      if (state === "FAIL" || state === "CANCEL") {
        throw new Error(`デプロイが${state}で終了しました。`);
      }
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
