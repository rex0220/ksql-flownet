/* global confirm, console, kintone, prompt, setTimeout */

/**
 * kSQL-Flow JOBログアプリの相関フィールド 5 種を Everyone = 閲覧のみ にする
 * ブラウザ Console 用スクリプト(kSQL-FlowNet 同梱)。
 *
 * 対象: correlation_id / attempt_id / execution_id / job_id / runner_execution_started_at
 * 理由: kSQL-FlowNet が Attempt と JOBログを照合する相関 ID と、SQL 開始の耐久証跡。
 *       人が画面から編集できると監査・復旧判断の根拠が崩れる。
 *       API トークン(kSQL-Flow ランナー)の書込はフィールドアクセス権の影響を受けない。
 *
 * 使い方: アプリ管理権限のあるアカウントで JOBログアプリを開き、Console へ丸ごと貼り付けて実行し、
 *         アプリ ID を入力する。preview へ適用 → confirm → デプロイ → 運用環境で検証する。
 * 冪等: 対象 5 フィールドが既に Everyone=閲覧のみ なら何も変更しない。他フィールドの設定は保持する。
 */
(async () => {
  "use strict";

  const input = prompt("kSQL-Flow JOBログアプリのIDを入力してください。");
  if (input === null) return void console.warn("中止しました。");
  const app = input.trim();
  if (!/^[1-9]\d*$/u.test(app)) {
    return void console.error("アプリIDは正の整数で入力してください。");
  }

  const TARGET_FIELDS = [
    "correlation_id",
    "attempt_id",
    "execution_id",
    "job_id",
    "runner_execution_started_at",
  ];
  const everyoneRead = {
    accessibility: "READ",
    entity: { type: "GROUP", code: "everyone" },
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errorText = (error) =>
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : JSON.stringify(error);
  const api = async (endpoint, method, body = {}) => {
    try {
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
  const deployAndWait = async () => {
    await api("/preview/app/deploy", "POST", { apps: [{ app }] });
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const status = await api("/preview/app/deploy", "GET", { apps: [app] });
      const state = status.apps?.[0]?.status;
      if (state === "SUCCESS") return;
      if (state === "FAIL" || state === "CANCEL") {
        throw new Error(`デプロイが${state}で終了しました。`);
      }
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  };
  const isEveryoneReadOnly = (right) =>
    right !== undefined &&
    right.entities.length === 1 &&
    right.entities[0].accessibility === "READ" &&
    right.entities[0].entity.type === "GROUP" &&
    right.entities[0].entity.code === "everyone";

  let step = "フィールド確認";
  try {
    const form = await api("/preview/app/form/fields", "GET", { app });
    const missing = TARGET_FIELDS.filter(
      (code) => !Object.hasOwn(form.properties ?? {}, code),
    );
    if (missing.length > 0) {
      return void console.error(
        `相関フィールドが不足しています: ${missing.join(", ")}。JOBログアプリは kSQL-Flow template v0.4 以降(相関フィールド付き)が必要です。`,
      );
    }

    step = "アクセス権取得";
    const current = await api("/preview/field/acl", "GET", { app });
    const rights = current.rights ?? [];
    const byCode = new Map(rights.map((right) => [right.code, right]));
    const toChange = TARGET_FIELDS.filter(
      (code) => !isEveryoneReadOnly(byCode.get(code)),
    );
    if (toChange.length === 0) {
      return void console.log(
        "相関フィールド5種は既に Everyone=閲覧のみ です。変更はありません。",
      );
    }
    const nextRights = [
      ...rights.filter(({ code }) => !TARGET_FIELDS.includes(code)),
      ...TARGET_FIELDS.map((code) => ({
        code,
        entities: [{ ...everyoneRead, entity: { ...everyoneRead.entity } }],
      })),
    ];
    console.log("Everyone=閲覧のみ にするフィールド:", toChange.join(", "));
    console.log(
      "他フィールドの設定は保持します。kSQL-Flow ランナー(APIトークン)の書込は影響を受けません。",
    );

    step = "確認";
    if (
      !confirm(
        `JOBログアプリ ${app} の相関フィールド ${toChange.length} 件を Everyone=閲覧のみ にしてデプロイします。よろしいですか？`,
      )
    ) {
      return void console.warn("中止しました。previewに変更はありません。");
    }

    step = "アクセス権適用";
    await api("/preview/field/acl", "PUT", {
      app,
      rights: nextRights,
      revision: current.revision,
    });
    step = "デプロイ";
    await deployAndWait();

    step = "検証";
    const live = await api("/field/acl", "GET", { app });
    const liveByCode = new Map((live.rights ?? []).map((r) => [r.code, r]));
    const ng = TARGET_FIELDS.filter(
      (code) => !isEveryoneReadOnly(liveByCode.get(code)),
    );
    if (ng.length > 0) {
      return void console.error(
        `デプロイ後の検証で不一致: ${ng.join(", ")}。アプリ設定画面でフィールドのアクセス権を確認してください。`,
      );
    }
    console.log(
      "完了: 相関フィールド5種は Everyone=閲覧のみ です(kSQL-Flow ランナーの書込は可能なまま)。",
    );
  } catch (error) {
    console.error(`${step}で失敗しました: ${errorText(error)}`);
    console.error(
      "previewに変更が残っている場合は、アプリ設定画面から「変更を中止」してください。アプリ管理権限のあるアカウントか確認してください。",
    );
  }
})();
