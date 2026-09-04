/* global confirm, console, kintone, location */

/**
 * CSV取込E2E専用のfixtureアプリ「KSQL_FLOW_TEST CSV1取込先」を新規作成する
 * （ブラウザ Console 用）。スパイク環境専用で、本番スペースでは実行しない。
 * 同名アプリが存在する場合は何も変更せず中止する。
 * APIトークンや実アプリIDをソースへ埋め込まない。
 *
 * 作成後の手作業:
 *  1. APIトークンを発行（閲覧・追加・編集・削除 — E2E cleanupに削除が必要）
 *  2. ユーザー環境変数 KSQL_CSV1_TARGET_APP_ID / KSQL_CSV1_TARGET_API_TOKEN を設定
 */
(async () => {
  "use strict";

  const APP_NAME = "KSQL_FLOW_TEST CSV1取込先";
  const SPACE_ID_OVERRIDE = null; // URLから判定できない場合だけ数値を指定する。

  const fields = {
    test_key: {
      type: "SINGLE_LINE_TEXT",
      code: "test_key",
      label: "test_key",
      required: true,
      unique: true,
    },
    test_value: {
      type: "SINGLE_LINE_TEXT",
      code: "test_value",
      label: "test_value",
      required: false,
    },
  };

  const layout = [
    {
      type: "ROW",
      fields: [
        { type: "SINGLE_LINE_TEXT", code: "test_key", size: { width: "340" } },
        {
          type: "SINGLE_LINE_TEXT",
          code: "test_value",
          size: { width: "340" },
        },
      ],
    },
  ];

  // 各viewにはキーと同値のnameが必須(GAIA_VI03 — 2026-09-01実機)。
  // 一覧のsortは$id・複数キー不可(2026-09-01実機)。
  const views = {
    "01_取込データ": {
      name: "01_取込データ",
      type: "LIST",
      fields: ["レコード番号", "test_key", "test_value", "更新日時"],
      sort: "更新日時 desc",
      index: "0",
    },
  };

  const errorText = (error) =>
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : JSON.stringify(error);
  const api = async (endpoint, method, body = {}) => {
    try {
      // kintone.api.url(..., true) により要求トークン付与とゲストスペースURLをkintone側へ任せる。
      return await kintone.api(
        kintone.api.url(`/k/v1${endpoint}.json`, true),
        method,
        body,
      );
    } catch (error) {
      throw new Error(`${method} /k/v1${endpoint}.json -> ${errorText(error)}`, {
        cause: error,
      });
    }
  };
  const detectSpaceId = () => {
    if (SPACE_ID_OVERRIDE !== null) return String(SPACE_ID_OVERRIDE);
    return location.hash.match(/#\/space\/(\d+)/)?.[1] ?? null;
  };

  let step = "事前確認";
  let app = null;
  try {
    const spaceId = detectSpaceId();
    if (spaceId === null) {
      throw new Error("作成先スペースIDをURLから判定できません。");
    }
    step = "同名アプリの存在確認";
    const existing = await api("/apps", "GET", { name: APP_NAME });
    const exactMatches = (existing.apps ?? []).filter(
      ({ name }) => name === APP_NAME,
    );
    if (exactMatches.length > 0) {
      console.error("同名アプリが既に存在するため、何も作成せず中止します。");
      console.table(exactMatches.map(({ appId, name }) => ({ appId, name })));
      return;
    }

    step = "スペース情報の取得";
    const space = await api("/space", "GET", { id: spaceId });
    if (!space.defaultThread) throw new Error("既定スレッドを取得できません。");

    step = "アプリ作成";
    const created = await api("/preview/app", "POST", {
      name: APP_NAME,
      space: spaceId,
      thread: space.defaultThread,
    });
    app = String(created.app);

    step = "フィールド追加";
    await api("/preview/app/form/fields", "POST", { app, properties: fields });
    step = "レイアウト設定";
    const current = await api("/preview/app/form/layout", "GET", { app });
    const systemRows = (current.layout ?? [])
      .filter(({ type }) => type === "ROW")
      .map(({ fields: rowFields }) => ({
        type: "ROW",
        fields: rowFields.filter(
          ({ code }) => code && !Object.hasOwn(fields, code),
        ),
      }))
      .filter(({ fields: rowFields }) => rowFields.length > 0);
    await api("/preview/app/form/layout", "PUT", {
      app,
      layout: [...layout, ...systemRows],
    });
    step = "一覧設定";
    await api("/preview/app/views", "PUT", { app, views });

    console.table([
      {
        アプリ名: APP_NAME,
        アプリID: app,
        フィールド数: Object.keys(fields).length,
        一覧数: Object.keys(views).length,
      },
    ]);
    step = "デプロイ確認";
    if (!confirm("CSV1取込先アプリをデプロイしますか？")) {
      console.warn("previewの変更をアプリ管理画面から中止してください。");
      return;
    }
    step = "デプロイ要求";
    await api("/preview/app/deploy", "POST", { apps: [{ app }] });
    console.log(
      `デプロイを要求しました。APIトークン(閲覧・追加・編集・削除)を発行し、` +
        `KSQL_CSV1_TARGET_APP_ID=${app} と KSQL_CSV1_TARGET_API_TOKEN を環境変数へ設定してください。`,
    );
  } catch (error) {
    console.error(`失敗した処理: ${step}`);
    console.error(errorText(error));
    if (app !== null) {
      console.error(
        `app ${app} のpreview変更をアプリ管理画面から中止してください。`,
      );
    }
    throw error;
  }
})();
