/* global confirm, console, kintone, prompt, setTimeout */

/** 既存の実行管理アプリのrecord_typeへCANCEL_REQUESTを冪等に追加する。 */
(async () => {
  "use strict";

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
    const response = await api("/preview/app/form/fields", "GET", { app });
    const recordType = response.properties?.record_type;
    if (recordType?.type !== "DROP_DOWN")
      throw new Error("record_typeドロップダウンが見つかりません。");
    if (Object.hasOwn(recordType.options ?? {}, "CANCEL_REQUEST")) {
      console.log("CANCEL_REQUESTは追加済みです。変更はありません。");
      return;
    }
    const indices = Object.values(recordType.options ?? {}).map(({ index }) =>
      Number(index),
    );
    const updated = {
      ...recordType,
      options: {
        ...recordType.options,
        CANCEL_REQUEST: {
          label: "CANCEL_REQUEST",
          index: String(Math.max(-1, ...indices) + 1),
        },
      },
    };
    await api("/preview/app/form/fields", "PUT", {
      app,
      properties: { record_type: updated },
    });
    console.table([{ アプリID: app, 追加選択肢: "CANCEL_REQUEST" }]);
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
        console.log("CANCEL_REQUEST選択肢の追加が完了しました。");
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
