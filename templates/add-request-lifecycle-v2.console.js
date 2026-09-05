/* global confirm, console, kintone, prompt, setTimeout */

/**
 * 既存の「kSQL-FlowNet 操作要求」アプリへrequest lifecycle v2を追補する
 * ブラウザConsole用スクリプト。previewへ存在する差分だけを適用する。
 *
 * フィールドアクセス権: APIトークン経由の書込は影響を受けない
 * (2026-09-05 E2E要求アプリで実機確認 — everyone閲覧のみ適用後もポーラーが書込可)。
 * 念のためACL適用後にポーラーの `poll-requests --check` と1件の要求処理で
 * 書込可能なことを確認し、書けなければ本ステップを取り消す(`revert-acl`)。
 */
(async () => {
  "use strict";

  const firstInput = prompt(
    "操作要求アプリのIDを入力してください。ACLを取り消す場合は revert-acl と入力してください。",
  );
  if (firstInput === null) return void console.warn("中止しました。");
  const revertAcl = firstInput.trim() === "revert-acl";
  const appInput = revertAcl
    ? prompt("ACLを取り消す操作要求アプリのIDを入力してください。")
    : firstInput;
  if (appInput === null) return void console.warn("中止しました。");
  const app = appInput.trim();
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

  // 機械6フィールド: everyone閲覧のみ。cancel_requested: 作成者だけ編集可(上の行が優先)、他は閲覧のみ。
  const everyoneRead = {
    accessibility: "READ",
    entity: { type: "GROUP", code: "everyone" },
  };
  const aclTargets = {
    request_state: [everyoneRead],
    claimed_at: [everyoneRead],
    claimed_host: [everyoneRead],
    claim_heartbeat_at: [everyoneRead],
    result_code: [everyoneRead],
    result_message: [everyoneRead],
    cancel_requested: [
      {
        accessibility: "WRITE",
        entity: { type: "FIELD_ENTITY", code: "作成者" },
      },
      everyoneRead,
    ],
  };
  const replaceAclTargets = (rights) => [
    ...rights.filter(({ code }) => !Object.hasOwn(aclTargets, code)),
    ...Object.entries(aclTargets).map(([code, entities]) => ({
      code,
      entities: entities.map((entity) => ({ ...entity })),
    })),
  ];
  const removeAclTargets = (rights) =>
    rights.filter(({ code }) => !Object.hasOwn(aclTargets, code));

  // アプリ設定APIはpreview(動作テスト環境)へ書き、デプロイで運用環境へ反映される。
  const deployAndWait = async () => {
    await api("/preview/app/deploy", "POST", { apps: [{ app }] });
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const status = await api("/preview/app/deploy", "GET", {
        apps: [app],
      });
      const state = status.apps?.[0]?.status;
      if (state === "SUCCESS") return;
      if (state === "FAIL" || state === "CANCEL") {
        throw new Error(`デプロイが${state}で終了しました。`);
      }
    }
    throw new Error("120秒以内にデプロイ完了を確認できませんでした。");
  };

  const updateAcl = async (operation) => {
    const current = await api("/preview/field/acl", "GET", { app });
    const rights = current.rights ?? [];
    const nextRights =
      operation === "revert"
        ? removeAclTargets(rights)
        : replaceAclTargets(rights);
    if (JSON.stringify(rights) === JSON.stringify(nextRights)) {
      console.log("フィールドアクセス権に変更はありません。");
      return false;
    }
    await api("/preview/field/acl", "PUT", {
      app,
      rights: nextRights,
      revision: current.revision,
    });
    await deployAndWait();
    return true;
  };

  let step = "事前確認";
  try {
    if (revertAcl) {
      step = "ACL取り消し確認";
      if (
        !confirm(
          "request lifecycle v2で設定した7フィールドのアクセス権を削除しますか？",
        )
      ) {
        return void console.warn("ACLの取り消しを中止しました。");
      }
      step = "ACL取り消し";
      const reverted = await updateAcl("revert");
      console.log(
        reverted
          ? "request lifecycle v2のACL対象7フィールドから権限設定を削除しデプロイしました。"
          : "取り消す権限設定はありません。",
      );
      return;
    }

    const additions = {
      cancel_requested: {
        type: "CHECK_BOX",
        code: "cancel_requested",
        label: "取消",
        options: { 取消: { label: "取消", index: "0" } },
        required: false,
      },
    };
    const fieldsResponse = await api("/preview/app/form/fields", "GET", {
      app,
    });
    const fields = fieldsResponse.properties ?? {};
    for (const code of ["request_type", "request_state"]) {
      if (!fields[code] || fields[code].type !== "DROP_DOWN") {
        throw new Error(
          `${code}ドロップダウンがありません(操作要求アプリのIDを確認)。`,
        );
      }
    }
    if (!fields.reason || fields.reason.type !== "MULTI_LINE_TEXT") {
      throw new Error(
        "reason文字列(複数行)がありません(操作要求アプリのIDを確認)。",
      );
    }
    if (
      fields.cancel_requested &&
      fields.cancel_requested.type !== "CHECK_BOX"
    ) {
      throw new Error(
        "cancel_requested は存在しますがCHECK_BOXではありません。",
      );
    }

    let previewChanged = false;
    const appendOption = (field, label) => {
      if (Object.hasOwn(field.options ?? {}, label)) return field;
      const indexes = Object.values(field.options ?? {})
        .map(({ index }) => Number(index))
        .filter(Number.isFinite);
      return {
        ...field,
        options: {
          ...field.options,
          [label]: {
            label,
            index: String(Math.max(-1, ...indexes) + 1),
          },
        },
      };
    };
    const fieldUpdates = {};
    const requestType = appendOption(fields.request_type, "CLOSE");
    if (requestType !== fields.request_type)
      fieldUpdates.request_type = requestType;
    const requestState = appendOption(fields.request_state, "CANCELLED");
    if (requestState !== fields.request_state)
      fieldUpdates.request_state = requestState;
    if (Object.keys(fieldUpdates).length > 0) {
      step = "既存フィールド更新";
      await api("/preview/app/form/fields", "PUT", {
        app,
        properties: fieldUpdates,
      });
      previewChanged = true;
    }
    if (!fields.cancel_requested) {
      step = "新規フィールド追加";
      await api("/preview/app/form/fields", "POST", {
        app,
        properties: additions,
      });
      previewChanged = true;
    }

    step = "レイアウト設定";
    const layoutResponse = await api("/preview/app/form/layout", "GET", {
      app,
    });
    const layout = layoutResponse.layout ?? [];
    const layoutCodes = new Set(
      layout.flatMap((row) =>
        Array.isArray(row.fields) ? row.fields.map(({ code }) => code) : [],
      ),
    );
    if (!layoutCodes.has("cancel_requested")) {
      const reasonIndex = layout.findIndex(
        ({ fields: rowFields }) =>
          Array.isArray(rowFields) &&
          rowFields.some(({ code }) => code === "reason"),
      );
      if (reasonIndex < 0) throw new Error("layoutにreasonがありません。");
      const nextLayout = [...layout];
      nextLayout.splice(reasonIndex + 1, 0, {
        type: "ROW",
        fields: [
          {
            type: "CHECK_BOX",
            code: "cancel_requested",
            size: { width: "180" },
          },
        ],
      });
      await api("/preview/app/form/layout", "PUT", {
        app,
        layout: nextLayout,
      });
      previewChanged = true;
    }

    step = "一覧設定";
    const viewsResponse = await api("/preview/app/views", "GET", { app });
    const views = viewsResponse.views ?? {};
    const pending = views["01_未処理要求"];
    if (!pending || pending.type !== "LIST") {
      throw new Error("対象一覧 01_未処理要求 がありません。");
    }
    const pendingFields = [...(pending.fields ?? [])];
    if (!pendingFields.includes("cancel_requested")) {
      const stateIndex = pendingFields.indexOf("request_state");
      pendingFields.splice(
        stateIndex < 0 ? pendingFields.length : stateIndex + 1,
        0,
        "cancel_requested",
      );
    }
    const cancelledFields = pendingFields.includes("result_code")
      ? pendingFields
      : [...pendingFields, "result_code"];
    const indexes = Object.values(views)
      .map(({ index }) => Number(index))
      .filter(Number.isFinite);
    const cancelledIndex =
      views["03_取消済み"]?.index ?? String(Math.max(-1, ...indexes) + 1);
    const toViewSettings = (name, view) => {
      if (view.builtinType) return { type: view.type, index: view.index };
      return {
        ...Object.fromEntries(
          Object.entries(view).filter(
            ([property]) => property !== "id" && property !== "builtinType",
          ),
        ),
        name,
      };
    };
    const updatedViews = Object.fromEntries(
      Object.entries(views).map(([name, view]) => [
        name,
        toViewSettings(name, view),
      ]),
    );
    updatedViews["01_未処理要求"] = {
      ...updatedViews["01_未処理要求"],
      fields: pendingFields,
    };
    updatedViews["03_取消済み"] = {
      name: "03_取消済み",
      type: "LIST",
      fields: cancelledFields,
      filterCond: 'request_state in ("CANCELLED")',
      sort: "更新日時 desc",
      index: cancelledIndex,
    };
    const currentComparable = Object.fromEntries(
      Object.entries(views).map(([name, view]) => [
        name,
        toViewSettings(name, view),
      ]),
    );
    if (JSON.stringify(currentComparable) !== JSON.stringify(updatedViews)) {
      await api("/preview/app/views", "PUT", {
        app,
        views: updatedViews,
        revision: viewsResponse.revision,
      });
      previewChanged = true;
    }

    if (previewChanged) {
      step = "デプロイ確認";
      if (
        !confirm(
          "CLOSE/CANCELLED・取消欄・レイアウト・一覧の差分をデプロイしますか？",
        )
      ) {
        console.warn(
          "previewの変更は未デプロイです。再実行すると適用済み差分をスキップします。",
        );
        return;
      }
      step = "デプロイ";
      await deployAndWait();
      console.log("request lifecycle v2のpreview差分をデプロイしました。");
    } else {
      console.log("previewに適用する差分はありません。");
    }

    console.warn(
      "APIトークン経由の書込はフィールドアクセス権の影響を受けません(2026-09-05実機確認)。念のためACL適用後にポーラーの poll-requests --check と1件の要求処理で書込可能なことを確認してください。書けなければ本ステップを取り消してください(READ→権限削除)。",
    );
    step = "ACL適用確認";
    if (
      !confirm(
        "別ステップとして、機械6フィールドをeveryone READ、cancel_requestedを作成者WRITE+everyone READにしますか？",
      )
    ) {
      return void console.warn("ACLは適用していません。");
    }
    step = "ACL適用";
    const aclApplied = await updateAcl("apply");
    console.log(
      aclApplied
        ? "ACLを適用しデプロイしました。必ず poll-requests --check と1件の要求処理を実行し、ポーラーが書込可能なことを確認してください。書けなければ revert-acl を実行してください。"
        : "ACLは適用済みです。",
    );
  } catch (error) {
    console.error(`失敗した処理: ${step}`);
    console.error(errorText(error));
    if (!revertAcl) {
      console.error(
        "previewに残った差分は再実行時に検出してスキップされます。",
      );
    }
  }
})();
