/* global console, kintone */

/**
 * create-flownet-request-app.console.js が「一覧設定」で失敗した場合の再開用スクリプト。
 * 作成済みのpreviewアプリへ一覧2件を設定し、デプロイまで行う(アプリを作り直さない)。
 * 失敗時はkintoneのエラー詳細(code/message/errors)をJSONで表示する。
 */
(async () => {
  "use strict";

  const APP_ID = 0; // ★previewアプリのID(作成失敗時のConsole出力に表示された番号)へ書き換える

  const api = (endpoint, method, body) =>
    kintone.api(kintone.api.url(`/k/v1${endpoint}.json`, true), method, body);

  const views = {
    "01_未処理要求": {
      name: "01_未処理要求",
      type: "LIST",
      fields: [
        "レコード番号",
        "request_type",
        "run_id",
        "rerun_from_node",
        "reason",
        "request_state",
        "作成者",
        "作成日時",
      ],
      filterCond: 'request_state in ("REQUESTED", "ACCEPTED")',
      sort: "作成日時 asc",
      index: "0",
    },
    "02_拒否された要求": {
      name: "02_拒否された要求",
      type: "LIST",
      fields: [
        "レコード番号",
        "request_type",
        "run_id",
        "reason",
        "result_code",
        "result_message",
        "作成者",
        "作成日時",
      ],
      filterCond: 'request_state in ("REJECTED")',
      sort: "作成日時 desc",
      index: "1",
    },
  };

  if (!Number.isInteger(APP_ID) || APP_ID <= 0) {
    console.error("APP_IDを作成済みpreviewアプリの番号へ書き換えてください。");
    return;
  }
  try {
    await api("/preview/app/views", "PUT", { app: APP_ID, views });
    console.log("一覧設定: 成功");
  } catch (error) {
    console.error("一覧設定で失敗。kintoneエラー詳細:");
    console.error(JSON.stringify(error, null, 2));
    return;
  }
  try {
    await api("/preview/app/deploy", "POST", { apps: [{ app: APP_ID }] });
    console.log(`デプロイ開始: アプリ ${APP_ID}。数十秒後に運用開始されます。`);
  } catch (error) {
    console.error("デプロイで失敗。kintoneエラー詳細:");
    console.error(JSON.stringify(error, null, 2));
  }
})();
