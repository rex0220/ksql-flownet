/* global confirm, console, kintone, prompt, setTimeout */

/**
 * 既存のkSQL-FlowNet実行管理・監査履歴アプリについて、フォームの並びを維持したまま
 * 対象フィールドの表示サイズだけを更新する（ブラウザ Console 用）。
 *
 * 対象アプリIDは実行時のpromptで入力する。フィールドの追加・削除・並び替えは行わない。
 * デプロイ前にconfirmで停止し、APIトークンや秘密情報は取得・表示しない。
 */
(async () => {
  "use strict";

  const FIELD_SIZES = {
    record_key: { width: "620" },
    result_code: { width: "340" },
    event_type: { width: "340" },
    lock_key: { width: "620" },
    attempt_key: { width: "620" },
    run_id: { width: "460" },
    node_attempt_id: { width: "460" },
    invocation_id: { width: "460" },
    attempt_id: { width: "460" },
    owner_invocation_id: { width: "460" },
    lease_token: { width: "460" },
    execution_id: { width: "460" },
    event_id: { width: "460" },
    business_key: { width: "340" },
    network_id: { width: "340" },
    node_id: { width: "340" },
    job_id: { width: "340" },
    definition_sha256: { width: "620" },
    source_bundle_sha256: { width: "620" },
    resolved_profile_sha256: { width: "620" },
    status_reason: { width: "340", innerHeight: "120" },
    evidence_ref: { width: "340" },
    reason: { width: "620", innerHeight: "120" },
    resolved_profile_snapshot: { width: "620", innerHeight: "120" },
    error_message: { width: "620", innerHeight: "120" },
    log_detail: { width: "620", innerHeight: "120" },
    blocked_by: { width: "460", innerHeight: "120" },
    selected_node_ids: { width: "460", innerHeight: "120" },
    preserved_node_ids: { width: "460", innerHeight: "120" },
    blocked_node_ids: { width: "460", innerHeight: "120" },
  };

  function errorText(error) {
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  function inputAppId(label) {
    const value = prompt(`${label}のアプリIDを入力してください。`);
    if (value === null) return null;
    const normalized = value.trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : undefined;
  }

  function applySizes(layout) {
    const changedCodes = [];

    function resizeField(field) {
      const desired =
        field.type === "LABEL"
          ? { width: "300" }
          : field.code
            ? FIELD_SIZES[field.code]
            : undefined;
      if (!desired) return field;
      const needsChange = Object.entries(desired).some(
        ([key, value]) => field.size?.[key] !== value,
      );
      if (!needsChange) return field;
      changedCodes.push(field.code ?? `LABEL:${field.elementId ?? "?"}`);
      return { ...field, size: { ...(field.size ?? {}), ...desired } };
    }

    function resizeItems(items) {
      return items.map((item) => {
        if (item.type === "ROW" && Array.isArray(item.fields)) {
          return { ...item, fields: item.fields.map(resizeField) };
        }
        if (item.type === "GROUP" && Array.isArray(item.layout)) {
          return { ...item, layout: resizeItems(item.layout) };
        }
        return item;
      });
    }

    return { layout: resizeItems(layout), changedCodes };
  }

  if (typeof kintone === "undefined" || typeof kintone.api !== "function") {
    console.error(
      "kintone.api が見つかりません。対象環境のkintoneポータルで実行してください。",
    );
    return;
  }

  const executionApp = inputAppId("kSQL-FlowNet 実行管理");
  if (executionApp === null) {
    console.warn("入力をキャンセルしたため、何も変更せず中止しました。");
    return;
  }
  if (executionApp === undefined) {
    console.error("実行管理のアプリIDは正の整数で入力してください。");
    return;
  }

  const auditApp = inputAppId("kSQL-FlowNet 監査履歴");
  if (auditApp === null) {
    console.warn("入力をキャンセルしたため、何も変更せず中止しました。");
    return;
  }
  if (auditApp === undefined) {
    console.error("監査履歴のアプリIDは正の整数で入力してください。");
    return;
  }
  if (executionApp === auditApp) {
    console.error("実行管理と監査履歴には異なるアプリIDを指定してください。");
    return;
  }

  const targets = [
    { name: "kSQL-FlowNet 実行管理", app: executionApp },
    { name: "kSQL-FlowNet 監査履歴", app: auditApp },
  ];

  const api = async (endpoint, method, body) => {
    try {
      return await kintone.api(
        kintone.api.url(`/k/v1${endpoint}.json`, true),
        method,
        body ?? {},
      );
    } catch (error) {
      throw new Error(
        `${method} /k/v1${endpoint}.json -> ${errorText(error)}`,
        { cause: error },
      );
    }
  };

  const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  let step = "レイアウト取得";
  const changedApps = [];

  try {
    console.table(
      targets.map(({ name, app }) => ({ アプリ名: name, アプリID: app })),
    );

    for (const target of targets) {
      step = `レイアウト取得: ${target.name}`;
      const response = await api("/app/form/layout", "GET", {
        app: target.app,
      });
      if (!Array.isArray(response.layout)) {
        throw new Error(`${target.name}: layout配列がありません。`);
      }

      const adjusted = applySizes(response.layout);
      if (adjusted.changedCodes.length === 0) {
        console.log(
          `${target.name}: 対象フィールドは指定サイズへ調整済みです。`,
        );
        continue;
      }

      step = `レイアウト更新: ${target.name}`;
      const update = await api("/preview/app/form/layout", "PUT", {
        app: target.app,
        layout: adjusted.layout,
      });
      changedApps.push({ ...target, changedCodes: adjusted.changedCodes });
      console.log(
        `${target.name}: ${adjusted.changedCodes.length}フィールドのsizeを更新 (revision ${update.revision})`,
      );
    }

    if (changedApps.length === 0) {
      console.log("%c変更はありません。", "color:green;font-weight:bold");
      return;
    }

    console.table(
      changedApps.map(({ name, app, changedCodes }) => ({
        アプリ名: name,
        アプリID: app,
        変更フィールド数: changedCodes.length,
        変更フィールド: changedCodes.join(", "),
      })),
    );

    step = "デプロイ確認";
    if (
      !confirm(
        `上記${changedApps.length}アプリのレイアウト幅調整をデプロイします。よろしいですか？\n` +
          "キャンセルした場合はkintone画面からpreviewの変更を中止してください。",
      )
    ) {
      console.warn("デプロイを中止しました。変更はpreview状態です。");
      console.warn(
        "kintoneのアプリ管理画面で対象アプリを開き、「変更を中止」してください。",
      );
      return;
    }

    step = "デプロイ要求";
    await api("/preview/app/deploy", "POST", {
      apps: changedApps.map(({ app }) => ({ app })),
    });
    console.log("デプロイを要求しました。反映完了を待ちます…");

    step = "デプロイ完了待ち";
    const appIds = changedApps.map(({ app }) => app);
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const response = await api("/preview/app/deploy", "GET", {
        apps: appIds,
      });
      const statuses = response.apps ?? [];
      console.log(
        `確認 ${attempt}/60: ${statuses.map((app) => `${app.app}:${app.status}`).join(", ")}`,
      );
      if (
        statuses.some((app) => app.status === "FAIL" || app.status === "CANCEL")
      ) {
        throw new Error(
          `デプロイが異常終了しました: ${JSON.stringify(statuses)}`,
        );
      }
      if (
        statuses.length === appIds.length &&
        statuses.every((app) => app.status === "SUCCESS")
      ) {
        console.log("%cレイアウト幅の調整完了", "color:green;font-weight:bold");
        return;
      }
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  } catch (error) {
    console.error(`%c失敗したステップ: ${step}`, "color:red;font-weight:bold");
    console.error(errorText(error));
    if (changedApps.length > 0) {
      console.error(
        "previewに変更が残った場合は、対象アプリの管理画面から「変更を中止」してください。",
      );
    }
  }
})();
