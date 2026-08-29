/**
 * Spike A の2アプリ案を新規作成する（ブラウザ Console 用）
 *
 * 使い方:
 *   1. kintone にアプリ作成・管理権限のあるアカウントでログインする
 *   2. 作成先スペースのポータル（/k/#/space/<spaceId>）を開く
 *   3. ブラウザの開発者ツール → Console にこのファイルの内容を丸ごと貼り付けて実行する
 *   4. フィールド・レイアウト・一覧設定後の確認ダイアログで内容を確認し、OK を押してデプロイする
 *
 * 安全性:
 *   - 同名アプリが1つでも存在する場合は、既存アプリを変更せずに中止する
 *   - 作成する新規アプリ以外の設定・フィールド・レコードは変更しない
 *   - デプロイ前に confirm で停止する。キャンセルした場合は preview にだけ変更が残るため、
 *     kintone のアプリ管理画面から「変更を中止」して後始末できる
 *   - APIトークンや秘密情報は生成・取得・表示しない
 *
 * 設計の正: ../app-design-2app.md
 */
(async () => {
  // URL から自動判定できない場合だけ、作成先のスペース ID を指定する。
  const SPACE_ID_OVERRIDE = null; // 例: 123

  const APP_DEFINITIONS = [
    {
      name: "FlowNet 実行管理 Spike",
      tokenEnvironmentVariable: "KSQL_SPIKE_TOKEN_EXEC",
      fields: createExecutionFields(),
      layoutSections: createExecutionLayoutSections(),
      views: createExecutionViews(),
    },
    {
      name: "FlowNet 監査履歴 Spike",
      tokenEnvironmentVariable: "KSQL_SPIKE_TOKEN_AUDIT",
      fields: createAuditFields(),
      layoutSections: createAuditLayoutSections(),
      views: createAuditViews(),
    },
  ];

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

  function toProperties(fields) {
    return Object.fromEntries(fields.map((field) => [field.code, field]));
  }

  function section(label, rows) {
    return { label, rows };
  }

  function listView(name, recordType, fields, sort, index) {
    return {
      name,
      type: "LIST",
      fields,
      filterCond: recordType ? `record_type in ("${recordType}")` : "",
      sort,
      index: String(index),
    };
  }

  function createLayout(fields, sections, currentLayout) {
    const layout = [];
    sections.forEach(({ label, rows }, sectionIndex) => {
      if (sectionIndex > 0) {
        layout.push({
          type: "ROW",
          fields: [{ type: "HR", elementId: `hr_${sectionIndex}` }],
        });
      }
      layout.push({
        type: "ROW",
        fields: [
          {
            type: "LABEL",
            label: `■ ${label}`,
            elementId: `label_${sectionIndex}`,
          },
        ],
      });
      for (const codes of rows) {
        layout.push({
          type: "ROW",
          fields: codes.map((code) => ({ type: fields[code].type, code })),
        });
      }
    });
    // 実行時に要確認: 自動生成フィールドのコードと並びはpreviewレイアウトの応答を正とする。
    // レイアウト更新APIはフォーム上の全フィールドを要求するため、設計対象外の行も保持する。
    const systemRows = currentLayout
      .filter((row) => row.type === "ROW")
      .map((row) => ({
        type: "ROW",
        fields: row.fields.filter(
          (field) => field.code && !Object.hasOwn(fields, field.code),
        ),
      }))
      .filter((row) => row.fields.length > 0);
    if (systemRows.length > 0) {
      const sectionIndex = sections.length;
      layout.push(
        {
          type: "ROW",
          fields: [{ type: "HR", elementId: `hr_${sectionIndex}` }],
        },
        {
          type: "ROW",
          fields: [
            {
              type: "LABEL",
              label: "■ System",
              elementId: `label_${sectionIndex}`,
            },
          ],
        },
        ...systemRows,
      );
    }
    return layout;
  }

  function createExecutionFields() {
    // app-design-2app.md の「Run/State/Lockの許可値union」。個別レコードでの
    // 許可値検証は設計書どおりアプリ外schema/repositoryで行う。
    const statuses = [
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

    // record_key/record_type以外の「条件付き」は、kintoneアプリ全体の
    // requiredにせず、record type別にrepository層で検証する。
    return toProperties([
      text("record_key", "レコード一意キー", true, true),
      dropdown(
        "record_type",
        "レコード種別",
        ["NETWORK_RUN", "NODE_STATE", "NETWORK_LOCK"],
        true,
      ),
      text("run_id", "Network Run ID"),
      text("lock_key", "Network Lock Key", false, true),
      text("profile", "Profile"),
      text("owner_invocation_id", "Owner Invocation ID"),
      text("lease_token", "Lease Token"),
      datetime("lease_expires_at", "Lease Expires At"),
      datetime("heartbeat_at", "Heartbeat At"),
      number("revision", "Revision Snapshot"),
      text("network_id", "Network ID"),
      text("business_key", "Business Key"),
      number("max_active_runs", "Max Active Runs"),
      dropdown("status", "Status", statuses),
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
      text("node_state_id", "Node State ID"),
      text("node_state_key", "Canonical Node State Key", false, true),
      text("node_id", "Node ID"),
      text("job_id", "Job ID"),
      number("latest_attempt_no", "Latest Attempt No"),
      text("active_attempt_id", "Active Attempt ID"),
      dropdown("idempotent", "Idempotent", ["true", "false"]),
      dropdown("trigger_rule", "Trigger Rule", ["all_success"]),
      multiline("blocked_by", "Blocked By"),
      multiline("status_reason", "Status Reason"),
    ]);
  }

  function createAuditFields() {
    // Invocation/Attemptの許可値union。record type別の検証はアプリ外で行う。
    const statuses = ["RUNNING", "SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"];

    // record_key/record_type以外はrecord type固有または一部種別だけの共用なので、
    // kintone required:falseとし、record type別にrepository層で検証する。
    return toProperties([
      text("record_key", "レコード一意キー", true, true),
      dropdown(
        "record_type",
        "レコード種別",
        [
          "RUN_INVOCATION",
          "NODE_ATTEMPT",
          "ATTEMPT_RESOLUTION",
          "OPERATION_AUDIT",
        ],
        true,
      ),
      text("run_id", "Network Run ID"),
      datetime("started_at", "Started At"),
      datetime("finished_at", "Finished At"),
      dropdown("status", "Status", statuses),
      text("result_code", "Result Code"),
      text("invocation_id", "Invocation ID"),
      dropdown("mode", "Mode", ["NEW", "RESUME", "RERUN_FROM"]),
      text("requested_by", "Requested By"),
      text("host", "Host"),
      multiline("selected_node_ids", "Selected Node IDs"),
      multiline("preserved_node_ids", "Preserved Node IDs"),
      multiline("blocked_node_ids", "Blocked Node IDs"),
      multiline("reason", "Reason"),
      text("node_attempt_id", "Node Attempt ID", false, true),
      text("attempt_key", "Canonical Attempt Key", false, true),
      text("node_id", "Node ID"),
      text("job_id", "Job ID"),
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
    ]);
  }

  function createExecutionLayoutSections() {
    return [
      section("Common", [["record_key", "record_type"]]),
      section("Network Run", [
        ["run_id", "network_id", "business_key"],
        ["max_active_runs", "status", "lifecycle_status"],
        ["resume_allowed", "as_of", "definition_schema_version"],
        ["definition_sha256", "source_bundle_sha256"],
        ["source_bundle_attachment"],
        ["resolved_profile_snapshot"],
        ["resolved_profile_sha256"],
        ["ksql_flow_version", "engine_version", "dialect"],
        ["created_at", "started_at", "finished_at"],
        ["updated_at"],
      ]),
      section("Node State", [
        ["revision"],
        ["node_state_id", "node_state_key"],
        ["node_id", "job_id"],
        ["latest_attempt_no", "active_attempt_id"],
        ["idempotent", "trigger_rule"],
        ["blocked_by"],
        ["status_reason"],
      ]),
      section("Network Lock", [
        ["lock_key", "profile"],
        ["owner_invocation_id", "lease_token"],
        ["lease_expires_at", "heartbeat_at"],
      ]),
    ];
  }

  function createAuditLayoutSections() {
    return [
      section("Common", [["record_key", "record_type"]]),
      section("Run Invocation", [
        ["run_id", "started_at", "finished_at"],
        ["status", "result_code"],
        ["invocation_id", "mode"],
        ["requested_by", "host"],
        ["selected_node_ids"],
        ["preserved_node_ids"],
        ["blocked_node_ids"],
        ["reason"],
      ]),
      section("Node Attempt", [
        ["node_attempt_id", "attempt_key"],
        ["node_id", "job_id", "attempt_no"],
        ["execution_started_at", "runner_execution_started_at"],
        ["execution_id", "duration_sec"],
        ["error_message"],
        ["read_count", "written_count", "last_successful_chunk_no"],
        ["last_written_key"],
      ]),
      section("Attempt Resolution", [
        ["event_type", "attempt_id", "resolved_outcome"],
        ["evidence_ref", "service_principal"],
        ["approved_by", "resolved_at"],
      ]),
      // Operation Audit 固有フィールドはない。共有フィールドは最初に該当する上記セクションへ置く。
      section("Operation Audit", []),
    ];
  }

  function createExecutionViews() {
    return [
      listView(
        "Network Run",
        "NETWORK_RUN",
        [
          "record_key",
          "run_id",
          "network_id",
          "business_key",
          "status",
          "lifecycle_status",
          "resume_allowed",
          "max_active_runs",
          "started_at",
          "finished_at",
          "updated_at",
        ],
        "updated_at desc",
        0,
      ),
      listView(
        "Node State",
        "NODE_STATE",
        [
          "record_key",
          "run_id",
          "node_state_key",
          "node_id",
          "job_id",
          "status",
          "latest_attempt_no",
          "active_attempt_id",
          "revision",
          "updated_at",
        ],
        "updated_at desc",
        1,
      ),
      listView(
        "Network Lock",
        "NETWORK_LOCK",
        [
          "record_key",
          "lock_key",
          "profile",
          "owner_invocation_id",
          "status",
          "lease_expires_at",
          "heartbeat_at",
          "revision",
        ],
        "lease_expires_at desc",
        2,
      ),
      listView(
        "全レコード",
        null,
        [
          "record_key",
          "record_type",
          "run_id",
          "updated_at",
          "started_at",
          "lease_expires_at",
        ],
        "record_key desc",
        3,
      ),
    ];
  }

  function createAuditViews() {
    return [
      listView(
        "Run Invocation",
        "RUN_INVOCATION",
        [
          "record_key",
          "run_id",
          "invocation_id",
          "mode",
          "status",
          "result_code",
          "requested_by",
          "host",
          "started_at",
          "finished_at",
        ],
        "started_at desc",
        0,
      ),
      listView(
        "Node Attempt",
        "NODE_ATTEMPT",
        [
          "record_key",
          "run_id",
          "node_attempt_id",
          "attempt_key",
          "node_id",
          "job_id",
          "attempt_no",
          "status",
          "result_code",
          "runner_execution_started_at",
          "finished_at",
          "duration_sec",
        ],
        "runner_execution_started_at desc",
        1,
      ),
      listView(
        "Attempt Resolution",
        "ATTEMPT_RESOLUTION",
        [
          "record_key",
          "attempt_id",
          "resolved_outcome",
          "event_type",
          "evidence_ref",
          "service_principal",
          "requested_by",
          "approved_by",
          "resolved_at",
        ],
        "resolved_at desc",
        2,
      ),
      listView(
        "Operation Audit",
        "OPERATION_AUDIT",
        [
          "record_key",
          "event_type",
          "reason",
          "evidence_ref",
          "service_principal",
          "requested_by",
          "resolved_at",
        ],
        "resolved_at desc",
        3,
      ),
      listView(
        "全レコード",
        null,
        [
          "record_key",
          "record_type",
          "run_id",
          "started_at",
          "finished_at",
          "resolved_at",
        ],
        "record_key desc",
        4,
      ),
    ];
  }

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
  const createdApps = [];

  try {
    const spaceId = detectSpaceId();
    if (!spaceId) {
      throw new Error(
        "URLからスペースIDを判定できませんでした。/k/#/space/<id> を開くか、SPACE_ID_OVERRIDEへ指定してください。",
      );
    }

    console.log(`%c作成先スペースID: ${spaceId}`, "font-weight:bold");

    step = "同名アプリの存在確認";
    const existingApps = [];
    for (const definition of APP_DEFINITIONS) {
      // 実際の呼出先は GET /k/v1/apps.json?name=...。部分一致応答から同名だけを判定する。
      const response = await api("/apps", "GET", { name: definition.name });
      existingApps.push(
        ...(response.apps ?? []).filter((app) => app.name === definition.name),
      );
    }
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

    for (const definition of APP_DEFINITIONS) {
      step = `アプリ作成: ${definition.name}`;
      const created = await api("/preview/app", "POST", {
        name: definition.name,
        space: spaceId,
        thread: space.defaultThread,
      });
      const app = String(created.app);
      const appSummary = { ...definition, app };
      createdApps.push(appSummary);
      console.log(`新規アプリをpreviewへ作成: ${definition.name} (app ${app})`);

      step = `フィールド追加: ${definition.name}`;
      const fieldResponse = await api("/preview/app/form/fields", "POST", {
        app,
        properties: definition.fields,
      });
      console.log(
        `全${Object.keys(definition.fields).length}フィールドを追加: ${definition.name} (revision ${fieldResponse.revision})`,
      );

      step = `レイアウト設定: ${definition.name}`;
      const currentLayoutResponse = await api(
        "/preview/app/form/layout",
        "GET",
        { app },
      );
      if (!Array.isArray(currentLayoutResponse.layout)) {
        throw new Error("previewレイアウトの応答にlayout配列がありません。");
      }
      const layout = createLayout(
        definition.fields,
        definition.layoutSections,
        currentLayoutResponse.layout,
      );
      const layoutResponse = await api("/preview/app/form/layout", "PUT", {
        app,
        layout,
      });
      appSummary.configuredLayoutSectionCount = layout.filter(
        (row) => row.fields[0]?.type === "LABEL",
      ).length;
      console.log(
        `フォームレイアウトを設定: ${definition.name} (revision ${layoutResponse.revision})`,
      );

      step = `一覧設定: ${definition.name}`;
      const viewsResponse = await api("/preview/app/views", "PUT", {
        app,
        views: Object.fromEntries(
          definition.views.map((view) => [view.name, view]),
        ),
      });
      console.log(
        `全${definition.views.length}一覧を設定: ${definition.name} (revision ${viewsResponse.revision})`,
      );
    }

    console.table(
      createdApps.map((app) => ({
        アプリID: app.app,
        アプリ名: app.name,
        フィールド数: Object.keys(app.fields).length,
        レイアウトセクション数: app.configuredLayoutSectionCount,
        一覧数: app.views.length,
      })),
    );

    step = "デプロイ確認";
    if (
      !confirm(
        `上記${createdApps.length}アプリをデプロイ（設定を反映）します。よろしいですか？\n` +
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
    await api("/preview/app/deploy", "POST", {
      apps: createdApps.map(({ app }) => ({ app })),
    });
    console.log("デプロイを要求しました。反映完了を待ちます…");

    step = "デプロイ完了待ち";
    const appIds = createdApps.map(({ app }) => app);
    let deployed = false;
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await sleep(2000);
      const response = await api("/preview/app/deploy", "GET", {
        apps: appIds,
      });
      const statuses = response.apps ?? [];
      console.log(
        `確認 ${attempt}/60: ${statuses.map((app) => `${app.app}:${app.status}`).join(", ")}`,
      );
      if (
        statuses.some((app) => app.status === "FAIL" || app.status === "CANCEL")
      ) {
        throw new Error(
          `デプロイが異常終了しました: ${JSON.stringify(statuses)}`,
        );
      }
      if (
        statuses.length === appIds.length &&
        statuses.every((app) => app.status === "SUCCESS")
      ) {
        deployed = true;
        break;
      }
    }
    if (!deployed)
      throw new Error("120秒以内にデプロイ完了を確認できませんでした。");

    console.log("%c作成完了", "color:green;font-weight:bold");
    console.table(
      createdApps.map((app) => ({
        アプリID: app.app,
        アプリ名: app.name,
        URL: appUrl(app.app),
      })),
    );
    console.log("%c次にやること", "font-weight:bold");
    for (const app of createdApps) {
      console.log(
        `- ${app.name} (app ${app.app}) の画面でAPIトークンを手動生成し、${app.tokenEnvironmentVariable} に設定する。`,
      );
    }
    console.log(
      "  APIトークンはREST APIでは生成できません。値をConsoleやリポジトリへ貼り付けないでください。",
    );
    console.log(
      "- 作成したアプリIDを spikes/a-app-layout/measurements.md の環境欄へ記録する。",
    );
  } catch (error) {
    console.error(`%c失敗したステップ: ${step}`, "color:red;font-weight:bold");
    console.error(errorText(error));
    if (createdApps.length > 0) {
      console.error("作成済みpreviewアプリ:");
      console.table(
        createdApps.map((app) => ({ アプリID: app.app, アプリ名: app.name })),
      );
      console.error(
        "後始末: kintoneのアプリ管理画面で各対象アプリを開き、未反映の設定について「変更を中止」してください。",
      );
      console.error(
        "アプリ自体の削除が必要な場合は、対象ID・名前を確認してkintone画面から手動で行ってください。",
      );
    }
  }
})();
