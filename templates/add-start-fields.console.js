/* global confirm, console, kintone, prompt, setTimeout */

/**
 * 既存の「kSQL-FlowNet 操作要求」アプリへSTART要求用の3欄を追補する
 * ブラウザConsole用スクリプト。previewへ存在する差分だけを適用する。
 */
(async () => {
  "use strict";

  const input = prompt("操作要求アプリのIDを入力してください。");
  if (input === null) return void console.warn("中止しました。");
  const app = input.trim();
  if (!/^[1-9]\d*$/u.test(app)) {
    return void console.error("アプリIDは正の整数で入力してください。");
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errorText = (error) =>
    error instanceof Error
      ? `${error.name}: ${error.message}${error.cause === undefined ? "" : `; cause=${JSON.stringify(error.cause)}`}`
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
        { cause: error },
      );
    }
  };
  const additions = {
    network_id: {
      type: "SINGLE_LINE_TEXT",
      code: "network_id",
      label: "Network ID",
      required: false,
    },
    business_key: {
      type: "SINGLE_LINE_TEXT",
      code: "business_key",
      label: "Business Key",
      required: false,
    },
    scheduled_for: {
      type: "DATETIME",
      code: "scheduled_for",
      label: "対象日時",
      required: false,
      defaultNowValue: false,
    },
  };
  const newCodes = Object.keys(additions);
  const targetViews = new Set(["01_未処理要求", "02_拒否された要求"]);
  const insertViewFields = (fields) => {
    const result = [...fields];
    let position = Math.max(result.indexOf("run_id") + 1, 0);
    for (const code of newCodes) {
      if (result.includes(code)) continue;
      result.splice(position, 0, code);
      position += 1;
    }
    return result;
  };

  let step = "事前確認";
  try {
    const fieldsResponse = await api("/preview/app/form/fields", "GET", {
      app,
    });
    const fields = fieldsResponse.properties ?? {};
    if (!fields.request_type || fields.request_type.type !== "DROP_DOWN") {
      throw new Error(
        "request_typeドロップダウンがありません(操作要求アプリのIDを確認)。",
      );
    }
    if (!fields.run_id || fields.run_id.type !== "SINGLE_LINE_TEXT") {
      throw new Error(
        "run_id文字列(1行)がありません(操作要求アプリのIDを確認)。",
      );
    }
    for (const [code, definition] of Object.entries(additions)) {
      if (fields[code] && fields[code].type !== definition.type) {
        throw new Error(
          `${code} は存在しますが型が ${definition.type} ではありません。`,
        );
      }
    }

    const fieldUpdates = {};
    if (!Object.hasOwn(fields.request_type.options ?? {}, "START")) {
      const indexes = Object.values(fields.request_type.options ?? {})
        .map(({ index }) => Number(index))
        .filter(Number.isFinite);
      fieldUpdates.request_type = {
        ...fields.request_type,
        options: {
          ...fields.request_type.options,
          START: {
            label: "START",
            index: String(Math.max(-1, ...indexes) + 1),
          },
        },
      };
    }
    if (fields.run_id.required === true) {
      fieldUpdates.run_id = { ...fields.run_id, required: false };
    }
    if (Object.keys(fieldUpdates).length > 0) {
      step = "既存フィールド更新";
      await api("/preview/app/form/fields", "PUT", {
        app,
        properties: fieldUpdates,
      });
    }

    const missingFields = Object.fromEntries(
      Object.entries(additions).filter(
        ([code]) => !Object.hasOwn(fields, code),
      ),
    );
    if (Object.keys(missingFields).length > 0) {
      step = "新規フィールド追加";
      await api("/preview/app/form/fields", "POST", {
        app,
        properties: missingFields,
      });
    }

    step = "レイアウト設定";
    const layoutResponse = await api("/preview/app/form/layout", "GET", {
      app,
    });
    const layoutCodes = new Set(
      (layoutResponse.layout ?? []).flatMap((row) =>
        Array.isArray(row.fields) ? row.fields.map(({ code }) => code) : [],
      ),
    );
    const missingLayoutCodes = newCodes.filter(
      (code) => !layoutCodes.has(code),
    );
    if (missingLayoutCodes.length > 0) {
      await api("/preview/app/form/layout", "PUT", {
        app,
        layout: [
          ...(layoutResponse.layout ?? []),
          {
            type: "ROW",
            fields: missingLayoutCodes.map((code) => ({
              type: additions[code].type,
              code,
              size: {
                width:
                  code === "scheduled_for"
                    ? "260"
                    : code === "business_key"
                      ? "380"
                      : "300",
              },
            })),
          },
        ],
      });
    }

    step = "一覧設定";
    const viewsResponse = await api("/preview/app/views", "GET", { app });
    const views = viewsResponse.views ?? {};
    for (const name of targetViews) {
      if (!views[name] || views[name].type !== "LIST") {
        throw new Error(`対象一覧 ${name} がありません。`);
      }
    }
    let viewsChanged = false;
    const updatedViews = Object.fromEntries(
      Object.entries(views).map(([key, view]) => {
        if (view.builtinType) {
          return [key, { type: view.type, index: view.index }];
        }
        const settings = Object.fromEntries(
          Object.entries(view).filter(
            ([property]) => property !== "id" && property !== "builtinType",
          ),
        );
        if (!targetViews.has(key)) return [key, settings];
        const viewFields = insertViewFields(settings.fields ?? []);
        if (viewFields.length !== (settings.fields ?? []).length)
          viewsChanged = true;
        return [key, { ...settings, name: key, fields: viewFields }];
      }),
    );
    if (viewsChanged) {
      await api("/preview/app/views", "PUT", {
        app,
        views: updatedViews,
        revision: viewsResponse.revision,
      });
    }

    step = "デプロイ確認";
    if (
      !confirm("START選択肢・3欄・レイアウト・一覧の差分をデプロイしますか？")
    ) {
      console.warn(
        "previewの変更は未デプロイです。再実行すると適用済み差分をスキップします。",
      );
      return;
    }
    step = "デプロイ";
    await api("/preview/app/deploy", "POST", { apps: [{ app }] });
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const status = await api("/preview/app/deploy", "GET", { apps: [app] });
      const state = status.apps?.[0]?.status;
      if (state === "SUCCESS") {
        console.log("START要求用フィールド追補のデプロイが完了しました。");
        return;
      }
      if (state === "FAIL" || state === "CANCEL") {
        throw new Error(`デプロイが${state}で終了しました。`);
      }
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  } catch (error) {
    console.error(`失敗した処理: ${step}`);
    console.error(errorText(error));
    console.error("previewに残った差分は再実行時に検出してスキップされます。");
  }
})();
