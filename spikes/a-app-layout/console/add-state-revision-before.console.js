/**
 * FN-05 / D-09追補: 既存の2app監査履歴アプリと1app統合アプリへ
 * state_revision_beforeを冪等に追加する。kintoneポータルのConsoleで実行する。
 */
(async () => {
  "use strict";

  const TARGET_APP_NAMES = ["FlowNet 監査履歴 Spike", "FlowNet 統合 Spike"];
  const FIELD_CODE = "state_revision_before";
  const FIELD = {
    type: "NUMBER",
    code: FIELD_CODE,
    label: "State Revision Before",
    required: false,
  };

  function errorText(error) {
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  if (typeof kintone === "undefined" || typeof kintone.api !== "function") {
    console.error(
      "kintone.api が見つかりません。kintoneポータルで実行してください。",
    );
    return;
  }

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

  function containsField(row, code) {
    return (
      row.type === "ROW" && row.fields?.some((field) => field.code === code)
    );
  }

  function isNodeAttemptLabel(row) {
    return (
      row.type === "ROW" &&
      row.fields?.some(
        (field) =>
          field.type === "LABEL" &&
          String(field.label ?? "").replace(/^■\s*/, "") === "Node Attempt",
      )
    );
  }

  function isFieldInNodeAttempt(layout) {
    const labelIndex = layout.findIndex(isNodeAttemptLabel);
    if (labelIndex < 0) return false;
    for (let index = labelIndex + 1; index < layout.length; index += 1) {
      const row = layout[index];
      if (
        row.type === "ROW" &&
        row.fields?.some(
          (field) => field.type === "HR" || field.type === "LABEL",
        )
      ) {
        return false;
      }
      if (containsField(row, FIELD_CODE)) return true;
    }
    return false;
  }

  function mergeIntoNodeAttempt(layout) {
    const withoutField = layout
      .map((row) => {
        if (row.type !== "ROW") return row;
        return {
          ...row,
          fields: row.fields.filter((field) => field.code !== FIELD_CODE),
        };
      })
      .filter((row) => row.type !== "ROW" || row.fields.length > 0);
    const labelIndex = withoutField.findIndex(isNodeAttemptLabel);
    if (labelIndex < 0) {
      throw new Error(
        "フォーム上の Node Attempt セクションを検出できませんでした。",
      );
    }
    let insertionIndex = withoutField.length;
    for (let index = labelIndex + 1; index < withoutField.length; index += 1) {
      const row = withoutField[index];
      if (
        row.type === "ROW" &&
        row.fields?.some(
          (field) => field.type === "HR" || field.type === "LABEL",
        )
      ) {
        insertionIndex = index;
        break;
      }
    }
    withoutField.splice(insertionIndex, 0, {
      type: "ROW",
      fields: [{ type: "NUMBER", code: FIELD_CODE }],
    });
    return withoutField;
  }

  let step = "対象アプリ確認";
  try {
    const targets = [];
    for (const name of TARGET_APP_NAMES) {
      const response = await api("/apps", "GET", { name });
      const matches = (response.apps ?? []).filter((app) => app.name === name);
      if (matches.length !== 1) {
        throw new Error(`${name} の一致件数が ${matches.length} 件です。`);
      }
      targets.push({ name, app: String(matches[0].appId) });
    }
    console.table(
      targets.map(({ name, app }) => ({ アプリ名: name, アプリID: app })),
    );

    const changedApps = [];
    for (const target of targets) {
      step = `フィールド確認: ${target.name}`;
      const fieldsResponse = await api("/preview/app/form/fields", "GET", {
        app: target.app,
      });
      const fieldExists = Object.hasOwn(
        fieldsResponse.properties ?? {},
        FIELD_CODE,
      );
      if (!fieldExists) {
        step = `フィールド追加: ${target.name}`;
        const response = await api("/preview/app/form/fields", "POST", {
          app: target.app,
          properties: { [FIELD_CODE]: FIELD },
        });
        console.log(
          `${target.name}: ${FIELD_CODE} を追加 (revision ${response.revision})`,
        );
      } else {
        console.log(`${target.name}: ${FIELD_CODE} は追加済みです。`);
      }

      step = `レイアウト確認: ${target.name}`;
      const layoutResponse = await api("/preview/app/form/layout", "GET", {
        app: target.app,
      });
      if (!Array.isArray(layoutResponse.layout)) {
        throw new Error(`${target.name}: layout配列がありません。`);
      }
      const alreadyPlaced = isFieldInNodeAttempt(layoutResponse.layout);
      if (!fieldExists || !alreadyPlaced) {
        step = `レイアウト更新: ${target.name}`;
        const response = await api("/preview/app/form/layout", "PUT", {
          app: target.app,
          layout: mergeIntoNodeAttempt(layoutResponse.layout),
        });
        console.log(
          `${target.name}: Node Attempt末尾へ配置 (revision ${response.revision})`,
        );
        changedApps.push(target);
      } else {
        console.log(`${target.name}: Node Attemptへの配置も確認済みです。`);
      }
    }

    if (changedApps.length === 0) {
      console.log(
        "%c追補済みのため変更はありません。",
        "color:green;font-weight:bold",
      );
      return;
    }

    step = "デプロイ確認";
    if (
      !confirm(
        `${changedApps.length}アプリの追補設定をデプロイします。よろしいですか？\n` +
          "キャンセルした場合はpreviewの変更を画面から中止してください。",
      )
    ) {
      console.warn("デプロイを中止しました。変更はpreview状態です。");
      return;
    }

    step = "デプロイ要求";
    await api("/preview/app/deploy", "POST", {
      apps: changedApps.map(({ app }) => ({ app })),
    });
    console.log("デプロイを要求しました。反映完了を待ちます…");

    step = "デプロイ完了待ち";
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const response = await api("/preview/app/deploy", "GET", {
        apps: changedApps.map(({ app }) => app),
      });
      const statuses = response.apps ?? [];
      console.log(
        `確認 ${attempt}/60: ${statuses.map((item) => `${item.app}:${item.status}`).join(", ")}`,
      );
      if (
        statuses.some(
          (item) => item.status === "FAIL" || item.status === "CANCEL",
        )
      ) {
        throw new Error("デプロイが異常終了しました。");
      }
      if (
        statuses.length === changedApps.length &&
        statuses.every((item) => item.status === "SUCCESS")
      ) {
        console.log("%c追補完了", "color:green;font-weight:bold");
        return;
      }
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  } catch (error) {
    console.error(`%c失敗したステップ: ${step}`, "color:red;font-weight:bold");
    console.error(errorText(error));
    console.error(
      "previewに変更が残った場合は、対象アプリの管理画面から変更を中止してください。",
    );
  }
})();
