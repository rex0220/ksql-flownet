/* global confirm, console, kintone, prompt, setTimeout */

/** 既存の実行管理アプリへ確認ボード用の一覧を冪等に追加する。 */
(async () => {
  "use strict";

  const TRIAGE_VIEWS = [
    {
      name: "01_要対応ノード",
      type: "LIST",
      fields: [
        "node_id",
        "job_id",
        "status",
        "status_reason",
        "blocked_by",
        "run_id",
        "latest_attempt_no",
        "updated_at",
      ],
      filterCond:
        'record_type in ("NODE_STATE") and status in ("FAILED","UNKNOWN","BLOCKED")',
      sort: "updated_at desc",
      index: "0",
    },
    {
      name: "02_未完了Run",
      type: "LIST",
      fields: [
        "run_id",
        "network_id",
        "business_key",
        "status",
        "started_at",
        "updated_at",
      ],
      filterCond:
        'record_type in ("NETWORK_RUN") and status not in ("SUCCESS")',
      sort: "updated_at desc",
      index: "1",
    },
    {
      name: "03_停止要求",
      type: "LIST",
      fields: ["record_key", "run_id", "status_reason", "更新日時"],
      filterCond: 'record_type in ("CANCEL_REQUEST")',
      sort: "更新日時 desc",
      index: "2",
    },
  ];

  const input = prompt("kSQL-FlowNet 実行管理アプリのIDを入力してください。");
  if (input === null) {
    console.warn("入力をキャンセルしたため、何も変更せず中止しました。");
    return;
  }
  const app = input.trim();
  if (!/^[1-9]\d*$/.test(app)) {
    console.error("アプリIDは正の整数で入力してください。");
    return;
  }
  if (typeof kintone === "undefined" || typeof kintone.api !== "function") {
    console.error("kintoneポータルのConsoleで実行してください。");
    return;
  }
  const api = (endpoint, method, body) =>
    kintone.api(kintone.api.url(`/k/v1${endpoint}.json`, true), method, body);
  const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  try {
    const viewsResponse = await api("/preview/app/views", "GET", { app });
    const existingViews = viewsResponse.views;
    if (!existingViews || typeof existingViews !== "object")
      throw new Error("preview一覧設定の応答にviewsがありません。");

    const additions = TRIAGE_VIEWS.filter(
      ({ name }) => !Object.hasOwn(existingViews, name),
    );
    if (additions.length === 0) {
      console.log("確認ボード用の3一覧は追加済みです。変更はありません。");
      return;
    }

    const fieldsResponse = await api("/preview/app/form/fields", "GET", {
      app,
    });
    const properties = fieldsResponse.properties;
    if (!properties || typeof properties !== "object")
      throw new Error("previewフィールド設定の応答にpropertiesがありません。");
    const requiredFieldCodes = new Set([
      "record_type",
      "status",
      ...additions.flatMap(({ fields }) => fields),
    ]);
    const missingFieldCodes = [...requiredFieldCodes].filter(
      (code) => !Object.hasOwn(properties, code),
    );
    if (missingFieldCodes.length > 0) {
      throw new Error(
        `一覧に必要なフィールドがありません: ${missingFieldCodes.join(", ")}`,
      );
    }

    const viewsForUpdate = Object.fromEntries(
      Object.entries(existingViews).map(([name, view]) => {
        if (view.builtinType) {
          return [name, { type: view.type, index: view.index }];
        }
        const settings = Object.fromEntries(
          Object.entries(view).filter(
            ([key]) => key !== "id" && key !== "builtinType",
          ),
        );
        return [name, settings];
      }),
    );
    const mergedViews = {
      ...Object.fromEntries(additions.map((view) => [view.name, view])),
      ...viewsForUpdate,
    };
    const response = await api("/preview/app/views", "PUT", {
      app,
      views: mergedViews,
      revision: viewsResponse.revision,
    });
    console.table(
      additions.map(({ name, filterCond, sort, index }) => ({
        アプリID: app,
        追加一覧: name,
        絞り込み: filterCond,
        ソート: sort,
        index,
      })),
    );
    console.log(
      `一覧設定をpreviewへ追加しました (revision ${response.revision})。`,
    );
    if (!confirm("上記変更をデプロイします。よろしいですか？")) {
      console.warn(
        "デプロイを中止しました。previewの変更を画面から中止してください。",
      );
      return;
    }
    await api("/preview/app/deploy", "POST", { apps: [{ app }] });
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const status = await api("/preview/app/deploy", "GET", { apps: [app] });
      const state = status.apps?.[0]?.status;
      if (state === "SUCCESS") {
        console.log("確認ボード用一覧の追加が完了しました。");
        return;
      }
      if (state === "FAIL" || state === "CANCEL")
        throw new Error(`デプロイが${state}で終了しました。`);
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "previewに変更が残った場合は画面から変更を中止してください。",
    );
  }
})();
