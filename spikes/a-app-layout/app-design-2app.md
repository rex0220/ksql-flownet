# アプリ作成依頼書: FlowNet 2アプリ案

## 依頼概要

FDR D-08の第一候補を検証するため、次の2アプリを新設してください。既存の実行ログアプリ（4249）はkSQL-Flow所有のまま残し、統合・Job Lock直接更新を行いません。作成後のapp IDを本書の空欄へ記録してください。

| 仮アプリ名             | app ID     | 用途                                                       |
| ---------------------- | ---------- | ---------------------------------------------------------- |
| FlowNet 実行管理 Spike | 作成後記入 | Network Run、Node State、実行bundle、Network Lock候補      |
| FlowNet 監査履歴 Spike | 作成後記入 | Run Invocation、Node Attempt、Attempt Resolution、運用監査 |

各アプリはレコード種別を`record_type`で区別する。JSON object／arrayはkintoneの複合型へ暗黙展開せず、秘密を除去したcanonical JSON文字列として複数行文字列へ保存する。日時はUTC ISO 8601相当の日時フィールドを使う。`node_state_key`と`attempt_key`はcanonical値を格納する単一フィールドに重複禁止を設定する。

## FlowNet 実行管理 Spike

### 共通・Network Lock候補

| フィールドコード    | 表示名              | kintone型      | 対象record type           | 必須     | 重複禁止 | 備考                                                        |
| ------------------- | ------------------- | -------------- | ------------------------- | -------- | -------- | ----------------------------------------------------------- |
| record_key          | レコード一意キー    | 文字列（1行）  | 全種別                    | Yes      | Yes      | `RUN:<run_id>`、`STATE:<node_state_key>`、`LOCK:<lock_key>` |
| record_type         | レコード種別        | ドロップダウン | 全種別                    | Yes      | No       | `NETWORK_RUN` / `NODE_STATE` / `NETWORK_LOCK`               |
| run_id              | Network Run ID      | 文字列（1行）  | Network Run / Node State  | Yes      | No       | JSON例の`run_id`                                            |
| lock_key            | Network Lock Key    | 文字列（1行）  | Network Lock              | 条件付き | Yes      | canonical `N1:...`                                          |
| profile             | Profile             | 文字列（1行）  | Network Lock              | 条件付き | No       | `prod`等。秘密は保存しない                                  |
| owner_invocation_id | Owner Invocation ID | 文字列（1行）  | Network Lock              | 条件付き | No       | current holder                                              |
| lease_token         | Lease Token         | 文字列（1行）  | Network Lock              | 条件付き | No       | fencing token。ACLで閲覧を制限                              |
| lease_expires_at    | Lease Expires At    | 日時           | Network Lock              | 条件付き | No       | stale候補判定用                                             |
| heartbeat_at        | Heartbeat At        | 日時           | Network Lock              | No       | No       | 最終heartbeat                                               |
| revision            | Revision Snapshot   | 数値           | Node State / Network Lock | Yes      | No       | kintone `$revision`と照合する業務側値                       |

### Network Run（仕様§6.1）

| フィールドコード          | 表示名                    | kintone型        | 必須 | 重複禁止 | 備考                                                                                                                                                                 |
| ------------------------- | ------------------------- | ---------------- | ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| network_id                | Network ID                | 文字列（1行）    | Yes  | No       | JSON例どおり                                                                                                                                                         |
| business_key              | Business Key              | 文字列（1行）    | Yes  | No       | `network_id`と組み合わせた一意性は`record_key`側で裁定                                                                                                               |
| max_active_runs           | Max Active Runs           | 数値             | Yes  | No       | 整数、1以上                                                                                                                                                          |
| status                    | Status                    | ドロップダウン   | Yes  | No       | Run/State/Lockの許可値union。record type別にアプリ側検証                                                                                                             |
| as_of                     | As Of                     | 日時             | No   | No       | offset情報が必要なら別途canonical文字列化を検討                                                                                                                      |
| definition_schema_version | Definition Schema Version | 数値             | Yes  | No       | 整数                                                                                                                                                                 |
| definition_sha256         | Definition SHA-256        | 文字列（1行）    | Yes  | No       | `sha256:...`                                                                                                                                                         |
| source_bundle_sha256      | Source Bundle SHA-256     | 文字列（1行）    | Yes  | No       | 添付の検証値                                                                                                                                                         |
| source_bundle_attachment  | Source Bundle Attachment  | 添付ファイル     | Yes  | No       | JSON例のファイル名を添付として保持                                                                                                                                   |
| resolved_profile_snapshot | Resolved Profile Snapshot | 文字列（複数行） | Yes  | No       | canonical JSON。`profile`,`base_url`,`guest_space_id`,`timezone`,`apps`,`limits.max_api_calls`,`limits.max_read_rows`,`limits.batch_timeout_sec`を含み秘密を含めない |
| resolved_profile_sha256   | Resolved Profile SHA-256  | 文字列（1行）    | Yes  | No       | canonical JSON hash                                                                                                                                                  |
| ksql_flow_version         | kSQL-Flow Version         | 文字列（1行）    | Yes  | No       | 実行時version                                                                                                                                                        |
| engine_version            | Engine Version            | 文字列（1行）    | Yes  | No       | 実行時version                                                                                                                                                        |
| dialect                   | Dialect                   | 数値             | Yes  | No       | 整数                                                                                                                                                                 |
| created_at                | Created At                | 日時             | Yes  | No       | UTC                                                                                                                                                                  |
| started_at                | Started At                | 日時             | No   | No       | Network Run / Node Stateで共用                                                                                                                                       |
| finished_at               | Finished At               | 日時             | No   | No       | Network Run / Node Stateで共用                                                                                                                                       |
| updated_at                | Updated At                | 日時             | Yes  | No       | Network Run / Node Stateで共用                                                                                                                                       |

### Node State（仕様§6.3）

| フィールドコード  | 表示名                   | kintone型        | 必須 | 重複禁止 | 備考                                                                   |
| ----------------- | ------------------------ | ---------------- | ---- | -------- | ---------------------------------------------------------------------- |
| node_state_id     | Node State ID            | 文字列（1行）    | Yes  | No       | JSON例どおり                                                           |
| node_state_key    | Canonical Node State Key | 文字列（1行）    | Yes  | **Yes**  | `run_id + node_id`から生成する`S1:...`。単一フィールドを最終裁定に使う |
| node_id           | Node ID                  | 文字列（1行）    | Yes  | No       | DAG上の識別子                                                          |
| job_id            | Job ID                   | 文字列（1行）    | Yes  | No       | SQL論理job ID                                                          |
| latest_attempt_no | Latest Attempt No        | 数値             | Yes  | No       | 0以上の整数                                                            |
| active_attempt_id | Active Attempt ID        | 文字列（1行）    | No   | No       | null可                                                                 |
| idempotent        | Idempotent               | チェックボックス | Yes  | No       | booleanを単一optionで表現。実装で厳密変換                              |
| trigger_rule      | Trigger Rule             | ドロップダウン   | Yes  | No       | Phase 1は`all_success`                                                 |
| blocked_by        | Blocked By               | 文字列（複数行） | Yes  | No       | node ID arrayのcanonical JSON                                          |
| status_reason     | Status Reason            | 文字列（複数行） | No   | No       | null可。秘密・顧客値を含めない                                         |

`run_id`、`status`、`revision`、`started_at`、`finished_at`、`updated_at`は共通表の同名フィールドを使用する。Node Stateはサブテーブルにしない。

## FlowNet 監査履歴 Spike

### 共通

| フィールドコード | 表示名           | kintone型      | 対象record type      | 必須 | 重複禁止 | 備考                                                                         |
| ---------------- | ---------------- | -------------- | -------------------- | ---- | -------- | ---------------------------------------------------------------------------- |
| record_key       | レコード一意キー | 文字列（1行）  | 全種別               | Yes  | Yes      | typeとIDから生成                                                             |
| record_type      | レコード種別     | ドロップダウン | 全種別               | Yes  | No       | `RUN_INVOCATION` / `NODE_ATTEMPT` / `ATTEMPT_RESOLUTION` / `OPERATION_AUDIT` |
| run_id           | Network Run ID   | 文字列（1行）  | Invocation / Attempt | Yes  | No       | 実行管理appとの相関                                                          |
| started_at       | Started At       | 日時           | Invocation           | Yes  | No       | UTC                                                                          |
| finished_at      | Finished At      | 日時           | Invocation / Attempt | No   | No       | UTC、実行中null                                                              |
| status           | Status           | ドロップダウン | Invocation / Attempt | Yes  | No       | record type別許可値                                                          |
| result_code      | Result Code      | 文字列（1行）  | Invocation / Attempt | Yes  | No       | 安定codeまたは監査code                                                       |

### Run Invocation（仕様§6.2）

| フィールドコード   | 表示名             | kintone型        | 必須 | 重複禁止 | 備考                                                                           |
| ------------------ | ------------------ | ---------------- | ---- | -------- | ------------------------------------------------------------------------------ |
| invocation_id      | Invocation ID      | 文字列（1行）    | Yes  | No       | Attemptも同じfieldを相関に使うため、Invocation自体の一意性は`record_key`で裁定 |
| mode               | Mode               | ドロップダウン   | Yes  | No       | `NEW` / `RESUME` / `RERUN_FROM`                                                |
| requested_by       | Requested By       | 文字列（1行）    | Yes  | No       | 認証された起動主体                                                             |
| host               | Host               | 文字列（1行）    | Yes  | No       | 秘密を含めないruntime識別                                                      |
| selected_node_ids  | Selected Node IDs  | 文字列（複数行） | Yes  | No       | canonical JSON array                                                           |
| preserved_node_ids | Preserved Node IDs | 文字列（複数行） | Yes  | No       | canonical JSON array                                                           |
| blocked_node_ids   | Blocked Node IDs   | 文字列（複数行） | Yes  | No       | canonical JSON array                                                           |
| reason             | Reason             | 文字列（複数行） | Yes  | No       | 顧客値・秘密を含めない                                                         |

### Node Attempt（仕様§6.4）

| フィールドコード            | 表示名                            | kintone型        | 必須 | 重複禁止 | 備考                                                                                |
| --------------------------- | --------------------------------- | ---------------- | ---- | -------- | ----------------------------------------------------------------------------------- |
| node_attempt_id             | Node Attempt ID                   | 文字列（1行）    | Yes  | Yes      | JSON例どおり                                                                        |
| attempt_key                 | Canonical Attempt Key             | 文字列（1行）    | Yes  | **Yes**  | `run_id + node_id + attempt_no`から生成する`A1:...`。単一フィールドを最終裁定に使う |
| node_id                     | Node ID                           | 文字列（1行）    | Yes  | No       | DAG上の識別子                                                                       |
| job_id                      | Job ID                            | 文字列（1行）    | Yes  | No       | SQL論理job ID                                                                       |
| invocation_id               | Invocation ID                     | 文字列（1行）    | Yes  | No       | Run Invocation相関                                                                  |
| attempt_no                  | Attempt No                        | 数値             | Yes  | No       | 1以上の整数                                                                         |
| execution_started_at        | Orchestrator Execution Started At | 日時             | No   | No       | kSQL-Flow呼出し許可時刻。SQL開始証拠ではない                                        |
| runner_execution_started_at | Runner Execution Started At       | 日時             | No   | No       | 耐久`EXECUTION_STARTED`確認時刻                                                     |
| execution_id                | kSQL-Flow Execution ID            | 文字列（1行）    | No   | No       | app 4249との相関                                                                    |
| duration_sec                | Duration Sec                      | 数値             | No   | No       | 0以上                                                                               |
| error_message               | Safe Error Message                | 文字列（複数行） | No   | No       | 安全化済み、stack・response本文なし                                                 |
| read_count                  | Read Count                        | 数値             | Yes  | No       | 0以上の整数                                                                         |
| written_count               | Written Count                     | 数値             | Yes  | No       | 0以上の整数                                                                         |
| last_successful_chunk_no    | Last Successful Chunk No          | 数値             | No   | No       | 診断情報、resume cursorではない                                                     |
| last_written_key            | Last Written Key                  | 文字列（1行）    | No   | No       | 診断情報、秘密を含めない                                                            |

### Attempt Resolution（FDR D-04 JSON例）

| フィールドコード  | 表示名              | kintone型      | 必須     | 重複禁止 | 備考                                                  |
| ----------------- | ------------------- | -------------- | -------- | -------- | ----------------------------------------------------- |
| event_type        | Event Type          | ドロップダウン | Yes      | No       | `ATTEMPT_RESOLVED`、手動完遂・補償eventは確定時に追加 |
| attempt_id        | Resolved Attempt ID | 文字列（1行）  | Yes      | No       | 元Attemptは上書きしない                               |
| resolved_outcome  | Resolved Outcome    | ドロップダウン | Yes      | No       | `SUCCESS` / `FAILED` / `CANCELLED`                    |
| evidence_ref      | Evidence Reference  | 文字列（1行）  | Yes      | No       | 管理された証拠への参照。秘密を埋め込まない            |
| service_principal | Service Principal   | 文字列（1行）  | Yes      | No       | 認証環境から取得                                      |
| requested_by      | Requested By        | 文字列（1行）  | Yes      | No       | 自由記述の自己申告だけで確定しない                    |
| approved_by       | Approved By         | 文字列（1行）  | 条件付き | No       | 非冪等SUCCESS解決では別主体を必須化                   |
| resolved_at       | Resolved At         | 日時           | Yes      | No       | UTC                                                   |

## 必要ACL

| 主体                        | 実行管理app                                  | 監査履歴app                             | 既存app 4249                                   |
| --------------------------- | -------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| FlowNet service principal   | 閲覧・追加・revision付き更新・bundle添付操作 | 閲覧・追加、Attempt lifecycleの限定更新 | 相関・開始証跡の閲覧のみ。Job Lock直接更新不可 |
| kSQL-Flow service principal | 原則なし                                     | 原則なし                                | 既存どおり実行ログ・Job Lockを所有             |
| Operator                    | 閲覧、承認済みNetwork回復操作                | 閲覧、解決依頼event追加                 | 閲覧。Job recoveryはkSQL-Flow契約経由          |
| Approver / Auditor          | 閲覧                                         | 閲覧、独立承認event                     | 閲覧                                           |
| 一般利用者                  | なし                                         | なし                                    | 既存方針どおり                                 |

API tokenは必要最小appだけへ発行し、値をリポジトリへ保存しない。Node Attemptのterminal確定後とAttempt Resolutionは通常編集不可にし、操作はservice principalと監査付きCLIへ限定する。
