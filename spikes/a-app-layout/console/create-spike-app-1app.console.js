/**
 * Spike A の1アプリ案を新規作成する（ブラウザ Console 用）
 *
 * 使い方:
 *   1. kintone にアプリ作成・管理権限のあるアカウントでログインする
 *   2. 作成先スペースのポータル（/k/#/space/<spaceId>）を開く
 *   3. ブラウザの開発者ツール → Console にこのファイルの内容を丸ごと貼り付けて実行する
 *   4. フィールド追加後の確認ダイアログで内容を確認し、OK を押してデプロイする
 *
 * 安全性:
 *   - 同名アプリが存在する場合は、既存アプリを変更せずに中止する
 *   - 作成する新規アプリ以外の設定・フィールド・レコードは変更しない
 *   - デプロイ前に confirm で停止する。キャンセルした場合は preview にだけ変更が残るため、
 *     kintone のアプリ管理画面から「変更を中止」して後始末できる
 *   - APIトークンや秘密情報は生成・取得・表示しない
 *
 * 設計の正: ../app-design-1app.md
 */
(async () => {
  // URL から自動判定できない場合だけ、作成先のスペース ID を指定する。
  const SPACE_ID_OVERRIDE = null; // 例: 123
  const APP_NAME = "FlowNet 統合 Spike";
  const TOKEN_ENVIRONMENT_VARIABLE = "KSQL_SPIKE_TOKEN_INTEGRATED";

  function options(values) {
    return Object.fromEntries(
      values.map((value, index) => [
        value,
        { label: value, index: String(index) },
      ]),
    );
  }

  function text(code, label, required = false, unique = false) {
    return { type: "SINGLE_LINE_TEXT", code, label, required, unique };
  }

  function multiline(code, label, required = false) {
    return { type: "MULTI_LINE_TEXT", code, label, required };
  }

  function number(code, label, required = false) {
    return { type: "NUMBER", code, label, required };
  }

  function datetime(code, label, required = false) {
    return { type: "DATETIME", code, label, required, defaultNowValue: false };
  }

  function dropdown(code, label, values, required = false) {
    return {
      type: "DROP_DOWN",
      code,
      label,
      required,
      options: options(values),
    };
  }

  function file(code, label, required = false) {
    return { type: "FILE", code, label, required };
  }

  // app-design-1app.md の「record type別許可値union」。個別レコードでの
  // 許可値検証は設計書どおりアプリ外schema/repositoryで行う。
  const STATUSES = [
    "CREATED",
    "WAITING",
    "RUNNING",
    "SUCCESS",
    "FAILED",
    "BLOCKED",
    "SKIPPED",
    "CANCELLED",
    "UNKNOWN",
  ];

  // 「条件付き」はkintoneアプリ全体の必須にできないため required:false とし、
  // 設計書どおりrecord type別にアプリ外schema/repositoryで検証する。
  const FIELDS = Object.fromEntries(
    [
      text("record_key", "レコード一意キー", true, true),
      dropdown(
        "record_type",
        "レコード種別",
        [
          "NETWORK_RUN",
          "RUN_INVOCATION",
          "NODE_STATE",
          "NODE_ATTEMPT",
          "ATTEMPT_RESOLUTION",
          "NETWORK_LOCK",
          "OPERATION_AUDIT",
        ],
        true,
      ),
      text("run_id", "Network Run ID"),
      text("network_id", "Network ID"),
      text("business_key", "Business Key"),
      number("max_active_runs", "Max Active Runs"),
      dropdown("status", "Status", STATUSES),
      dropdown("lifecycle_status", "Lifecycle Status", ["ACTIVE", "ARCHIVED"]),
      dropdown("resume_allowed", "Resume Allowed", ["true", "false"]),
      datetime("as_of", "As Of"),
      number("definition_schema_version", "Definition Schema Version"),
      text("definition_sha256", "Definition SHA-256"),
      text("source_bundle_sha256", "Source Bundle SHA-256"),
      file("source_bundle_attachment", "Source Bundle Attachment"),
      multiline("resolved_profile_snapshot", "Resolved Profile Snapshot"),
      text("resolved_profile_sha256", "Resolved Profile SHA-256"),
      text("ksql_flow_version", "kSQL-Flow Version"),
      text("engine_version", "Engine Version"),
      number("dialect", "Dialect"),
      datetime("created_at", "Created At"),
      datetime("started_at", "Started At"),
      datetime("finished_at", "Finished At"),
      datetime("updated_at", "Updated At"),
      text("invocation_id", "Invocation ID"),
      dropdown("mode", "Mode", ["NEW", "RESUME", "RERUN_FROM"]),
      text("requested_by", "Requested By"),
      text("host", "Host"),
      text("result_code", "Result Code"),
      multiline("selected_node_ids", "Selected Node IDs"),
      multiline("preserved_node_ids", "Preserved Node IDs"),
      multiline("blocked_node_ids", "Blocked Node IDs"),
      multiline("reason", "Reason"),
      text("node_state_id", "Node State ID"),
      text("node_state_key", "Canonical Node State Key", false, true),
      text("node_id", "Node ID"),
      text("job_id", "Job ID"),
      number("latest_attempt_no", "Latest Attempt No"),
      text("active_attempt_id", "Active Attempt ID"),
      number("revision", "Revision Snapshot"),
      dropdown("idempotent", "Idempotent", ["true", "false"]),
      dropdown("trigger_rule", "Trigger Rule", ["all_success"]),
      multiline("blocked_by", "Blocked By"),
      multiline("status_reason", "Status Reason"),
      text("node_attempt_id", "Node Attempt ID", false, true),
      text("attempt_key", "Canonical Attempt Key", false, true),
      number("attempt_no", "Attempt No"),
      datetime("execution_started_at", "Orchestrator Execution Started At"),
      datetime("runner_execution_started_at", "Runner Execution Started At"),
      text("execution_id", "kSQL-Flow Execution ID"),
      number("duration_sec", "Duration Sec"),
      multiline("error_message", "Safe Error Message"),
      number("read_count", "Read Count"),
      number("written_count", "Written Count"),
      number("last_successful_chunk_no", "Last Successful Chunk No"),
      text("last_written_key", "Last Written Key"),
      dropdown("event_type", "Event Type", ["ATTEMPT_RESOLVED"]),
      text("attempt_id", "Resolved Attempt ID"),
      dropdown("resolved_outcome", "Resolved Outcome", [
        "SUCCESS",
        "FAILED",
        "CANCELLED",
      ]),
      text("evidence_ref", "Evidence Reference"),
      text("service_principal", "Service Principal"),
      text("approved_by", "Approved By"),
      datetime("resolved_at", "Resolved At"),
      text("lock_key", "Network Lock Key", false, true),
      text("profile", "Profile"),
      text("owner_invocation_id", "Owner Invocation ID"),
      text("lease_token", "Lease Token"),
      datetime("lease_expires_at", "Lease Expires At"),
      datetime("heartbeat_at", "Heartbeat At"),
    ].map((field) => [field.code, field]),
  );

  function detectSpaceId() {
    const match = location.href.match(
      /\/k\/(?:guest\/\d+\/)?#\/space\/(\d+)(?:\/|$|\?)/,
    );
    return SPACE_ID_OVERRIDE ?? match?.[1] ?? null;
  }

  function appUrl(appId) {
    const guestId = location.pathname.match(/\/k\/guest\/(\d+)\//)?.[1];
    return guestId
      ? `${location.origin}/k/guest/${guestId}/${appId}/`
      : `${location.origin}/k/${appId}/`;
  }

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
      "kintone.api が見つかりません。作成先スペースのkintoneポータルで実行してください。",
    );
    return;
  }

  const api = async (endpoint, method, body) => {
    try {
      // kintone.api.url(..., true) により要求トークン付与とゲストスペースURLをkintone側へ任せる。
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
  let step = "事前確認";
  let createdApp = null;

  try {
    const spaceId = detectSpaceId();
    if (!spaceId) {
      throw new Error(
        "URLからスペースIDを判定できませんでした。/k/#/space/<id> を開くか、SPACE_ID_OVERRIDEへ指定してください。",
      );
    }
    console.log(`%c作成先スペースID: ${spaceId}`, "font-weight:bold");

    step = "同名アプリの存在確認";
    // 実際の呼出先は GET /k/v1/apps.json?name=...。部分一致応答から同名だけを判定する。
    const appSearch = await api("/apps", "GET", { name: APP_NAME });
    const existingApps = (appSearch.apps ?? []).filter(
      (app) => app.name === APP_NAME,
    );
    if (existingApps.length > 0) {
      console.error("同名アプリが既に存在するため、何も作成せず中止します。");
      console.table(
        existingApps.map((app) => ({
          アプリID: app.appId,
          アプリ名: app.name,
        })),
      );
      return;
    }

    step = "スペース情報の取得";
    const space = await api("/space", "GET", { id: spaceId });
    if (!space.defaultThread) {
      throw new Error(
        "GET /k/v1/space.json の応答に defaultThread がありません。",
      );
    }
    console.log(`既定スレッドID: ${space.defaultThread}`);

    step = `アプリ作成: ${APP_NAME}`;
    const created = await api("/preview/app", "POST", {
      name: APP_NAME,
      space: spaceId,
      thread: space.defaultThread,
    });
    createdApp = String(created.app);
    console.log(`新規アプリをpreviewへ作成: ${APP_NAME} (app ${createdApp})`);

    step = `フィールド追加: ${APP_NAME}`;
    const fieldResponse = await api("/preview/app/form/fields", "POST", {
      app: createdApp,
      properties: FIELDS,
    });
    console.log(
      `全${Object.keys(FIELDS).length}フィールドを追加 (revision ${fieldResponse.revision})`,
    );
    console.table([
      {
        アプリID: createdApp,
        アプリ名: APP_NAME,
        フィールド数: Object.keys(FIELDS).length,
      },
    ]);

    step = "デプロイ確認";
    if (
      !confirm(
        `上記アプリをデプロイ（設定を反映）します。よろしいですか？\n` +
          "キャンセルした場合はkintone画面からpreviewの変更を中止してください。",
      )
    ) {
      console.warn("デプロイを中止しました。作成内容はpreview状態です。");
      console.warn(
        "kintoneのアプリ管理画面で対象アプリを開き、「変更を中止」してください。",
      );
      return;
    }

    step = "デプロイ要求";
    await api("/preview/app/deploy", "POST", { apps: [{ app: createdApp }] });
    console.log("デプロイを要求しました。反映完了を待ちます…");

    step = "デプロイ完了待ち";
    let deployed = false;
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const response = await api("/preview/app/deploy", "GET", {
        apps: [createdApp],
      });
      const status = response.apps?.[0]?.status;
      console.log(`確認 ${attempt}/60: ${createdApp}:${status ?? "応答なし"}`);
      if (status === "FAIL" || status === "CANCEL") {
        throw new Error(`デプロイが ${status} で異常終了しました。`);
      }
      if (status === "SUCCESS") {
        deployed = true;
        break;
      }
    }
    if (!deployed)
      throw new Error("120秒以内にデプロイ完了を確認できませんでした。");

    console.log("%c作成完了", "color:green;font-weight:bold");
    console.table([
      { アプリID: createdApp, アプリ名: APP_NAME, URL: appUrl(createdApp) },
    ]);
    console.log("%c次にやること", "font-weight:bold");
    console.log(
      `- ${APP_NAME} (app ${createdApp}) の画面でAPIトークンを手動生成し、${TOKEN_ENVIRONMENT_VARIABLE} に設定する。`,
    );
    console.log(
      "  APIトークンはREST APIでは生成できません。値をConsoleやリポジトリへ貼り付けないでください。",
    );
    console.log(
      "- 作成したアプリIDを spikes/a-app-layout/measurements.md の環境欄へ記録する。",
    );
  } catch (error) {
    console.error(`%c失敗したステップ: ${step}`, "color:red;font-weight:bold");
    console.error(errorText(error));
    if (createdApp) {
      console.error(`作成済みpreviewアプリ: ${APP_NAME} (app ${createdApp})`);
      console.error(
        "後始末: kintoneのアプリ管理画面で対象アプリを開き、未反映の設定について「変更を中止」してください。",
      );
      console.error(
        "アプリ自体の削除が必要な場合は、対象ID・名前を確認してkintone画面から手動で行ってください。",
      );
    }
  }
})();
