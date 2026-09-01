/* global confirm, console, kintone, prompt, setTimeout */

/**
 * 実行管理アプリへP2-08プラグイン用のカスタマイズビュー「00_Run状況」を冪等に追加する。
 * プラグイン(kSQL-FlowNet Run Activity)のdesktop.jsがこのビューの固定rootへ描画する。
 * 各viewにはキーと同値のnameが必須(GAIA_VI03)。sortは単一キーのみ。
 */
(async () => {
  "use strict";

  const BOARD_VIEW = {
    name: "00_Run状況",
    type: "CUSTOM",
    html: '<div id="ksql-flownet-run-board" aria-live="polite"></div>',
    pager: false,
    device: "DESKTOP",
    filterCond:
      'record_type in ("NETWORK_RUN") and status not in ("SUCCESS","FAILED","CANCELLED","UNKNOWN")',
    sort: "updated_at desc",
    index: "0",
  };

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
    const fieldsResponse = await api("/preview/app/form/fields", "GET", {
      app,
    });
    const properties = fieldsResponse.properties;
    for (const code of ["record_type", "status", "run_id"]) {
      if (!properties || !Object.hasOwn(properties, code)) {
        throw new Error(
          `実行管理アプリのフィールドがありません: ${code}(アプリIDを確認してください)`,
        );
      }
    }

    const viewsResponse = await api("/preview/app/views", "GET", { app });
    const existingViews = viewsResponse.views;
    if (!existingViews || typeof existingViews !== "object")
      throw new Error("preview一覧設定の応答にviewsがありません。");
    if (Object.hasOwn(existingViews, BOARD_VIEW.name)) {
      console.log("「00_Run状況」は追加済みです。変更はありません。");
      return;
    }

    // 既存一覧のindexは1件分だけ後ろへシフトする(相対順は維持)。
    const viewsForUpdate = Object.fromEntries(
      Object.entries(existingViews).map(([name, view]) => {
        const shifted = String(Number(view.index) + 1);
        if (view.builtinType) {
          return [name, { type: view.type, index: shifted }];
        }
        const settings = Object.fromEntries(
          Object.entries(view).filter(
            ([key]) => key !== "id" && key !== "builtinType",
          ),
        );
        return [name, { ...settings, index: shifted }];
      }),
    );
    const response = await api("/preview/app/views", "PUT", {
      app,
      views: { [BOARD_VIEW.name]: BOARD_VIEW, ...viewsForUpdate },
      revision: viewsResponse.revision,
    });
    console.log(
      `カスタマイズビュー「${BOARD_VIEW.name}」をpreviewへ追加しました (revision ${response.revision})。`,
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
        console.log("「00_Run状況」の追加が完了しました。");
        return;
      }
      if (state === "FAIL" || state === "CANCEL")
        throw new Error(`デプロイが${state}で終了しました。`);
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error && typeof error === "object" && !(error instanceof Error)) {
      console.error(JSON.stringify(error, null, 2));
    }
    console.error(
      "previewに変更が残った場合は画面から変更を中止してください。",
    );
  }
})();
