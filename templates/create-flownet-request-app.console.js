/* global confirm, console, kintone, location */

/**
 * kSQL-FlowNet 操作要求アプリを新規作成する（ブラウザ Console 用）。
 * 同名アプリが存在する場合は何も変更せず中止する。
 * APIトークンや実アプリIDをソースへ埋め込まない。
 */
(async () => {
  "use strict";

  const APP_NAME = "kSQL-FlowNet 操作要求";
  const SPACE_ID_OVERRIDE = null; // URLから判定できない場合だけ数値を指定する。

  const options = (values) =>
    Object.fromEntries(
      values.map((value, index) => [
        value,
        { label: value, index: String(index) },
      ]),
    );
  const text = (code, label, required = false) => ({
    type: "SINGLE_LINE_TEXT",
    code,
    label,
    required,
  });
  const multiline = (code, label, required = false) => ({
    type: "MULTI_LINE_TEXT",
    code,
    label,
    required,
  });
  const datetime = (code, label) => ({
    type: "DATETIME",
    code,
    label,
    required: false,
    defaultNowValue: false,
  });
  const dropdown = (code, label, values, required, defaultValue) => ({
    type: "DROP_DOWN",
    code,
    label,
    required,
    options: options(values),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  });

  const fields = Object.fromEntries(
    [
      dropdown("request_type", "要求種別", ["RERUN", "STOP", "RELEASE"], true),
      text("run_id", "Run ID", true),
      text("rerun_from_node", "リラン開始ノード"),
      multiline("reason", "理由", true),
      dropdown(
        "request_state",
        "要求状態",
        ["REQUESTED", "ACCEPTED", "DONE", "REJECTED"],
        true,
        "REQUESTED",
      ),
      datetime("claimed_at", "受理日時"),
      text("claimed_host", "受理ホスト"),
      datetime("claim_heartbeat_at", "受理heartbeat日時"),
      text("result_code", "結果コード"),
      multiline("result_message", "結果メッセージ"),
    ].map((field) => [field.code, field]),
  );

  const layout = [
    {
      type: "ROW",
      fields: [
        { type: "DROP_DOWN", code: "request_type", size: { width: "180" } },
        { type: "SINGLE_LINE_TEXT", code: "run_id", size: { width: "460" } },
      ],
    },
    {
      type: "ROW",
      fields: [
        {
          type: "SINGLE_LINE_TEXT",
          code: "rerun_from_node",
          size: { width: "340" },
        },
      ],
    },
    {
      type: "ROW",
      fields: [
        {
          type: "MULTI_LINE_TEXT",
          code: "reason",
          size: { width: "620", innerHeight: "120" },
        },
      ],
    },
    {
      type: "ROW",
      fields: [{ type: "HR", elementId: "hr_machine" }],
    },
    {
      type: "ROW",
      fields: [
        { type: "DROP_DOWN", code: "request_state", size: { width: "180" } },
        { type: "DATETIME", code: "claimed_at", size: { width: "260" } },
        {
          type: "SINGLE_LINE_TEXT",
          code: "claimed_host",
          size: { width: "260" },
        },
      ],
    },
    {
      type: "ROW",
      fields: [
        {
          type: "DATETIME",
          code: "claim_heartbeat_at",
          size: { width: "260" },
        },
        {
          type: "SINGLE_LINE_TEXT",
          code: "result_code",
          size: { width: "260" },
        },
      ],
    },
    {
      type: "ROW",
      fields: [
        {
          type: "MULTI_LINE_TEXT",
          code: "result_message",
          size: { width: "620", innerHeight: "120" },
        },
      ],
    },
  ];

  // indexは全一覧で一意にし、表示順と同じ0始まりの連番に固定する。
  const views = {
    "01_未処理要求": {
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
      // 一覧のsortはクエリAPIと異なり$idや複数キーを受け付けない(2026-09-01実機)
      sort: "作成日時 asc",
      index: "0",
    },
    "02_拒否された要求": {
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

  // kintone.apiの失敗はErrorではなく{code,id,message,errors}のplain objectで届くため、
  // 詳細をJSONで出す(String()では[object Object]になり原因調査が不能 — 2026-09-01実機)
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
      throw new Error(
        `${method} /k/v1${endpoint}.json -> ${errorText(error)}`,
        {
          cause: error,
        },
      );
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
    if (!confirm("操作要求アプリをデプロイしますか？")) {
      console.warn("previewの変更をアプリ管理画面から中止してください。");
      return;
    }
    step = "デプロイ要求";
    await api("/preview/app/deploy", "POST", { apps: [{ app }] });
    console.log(
      "デプロイを要求しました。ACLとAPIトークン権限を手順書どおり設定してください。",
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
