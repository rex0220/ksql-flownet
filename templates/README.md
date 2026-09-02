# kSQL-FlowNet app templates

kSQL-FlowNetのControl Planeで使用する機械専用の「実行管理」「監査履歴」と、人とポーラーが共有する「操作要求」の3アプリを作成・調整するConsoleスクリプトです。kSQL-Flowが所有するJOBログアプリは対象に含みません。

## リリース配布方針

リリース配布は、実行管理・監査履歴・操作要求・JOBログをまとめた**kintoneアプリテンプレート**を正とします。インポート時にアプリ間参照（関連レコード）が自動で張り替わるため、Run状況プラグインのアプリID自動検出もそのまま機能します。

本ディレクトリのConsoleスクリプト群は、既存アプリへの追補と開発環境の構築に使用します。既存の実行管理アプリへ3種の関連レコード一覧を追加する場合は、`add-run-related-lists.console.js`へ実行管理・監査履歴・操作要求・JOBログの4アプリIDを入力してください。既に存在する関連レコードフィールドは変更せず、未追加のものだけを追加します。

## バージョン対応

| 対象                             | バージョン   | 備考                                                                                                |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| レコード構成（`schema_version`） | 1            | 実行管理・監査履歴のフィールド構成                                                                  |
| テンプレート実装                 | 0.1.0        | `package.json`の`version`と対応                                                                     |
| JOBログ相関                      | kSQL-Flow M1 | `attempt_id`等を追加済み。詳細は[`docs/execution-contract-v1.md`](../docs/execution-contract-v1.md) |

## 新規アプリの作成

1. アプリ作成・管理権限のあるアカウントでkintoneへログインし、作成先スペースのポータルを開きます。
2. 開発者ツールのConsoleへ`create-flownet-apps.console.js`の内容を貼り付けて実行します。
3. 表示されたアプリ名、アプリID、フィールド数、レイアウト、一覧数を確認し、確認ダイアログでデプロイを承認します。
4. 完了後、表示されたアプリIDを環境変数へ設定し、各アプリの画面でAPIトークンを発行して環境変数へ設定します。トークン値はConsoleやリポジトリへ貼り付けないでください。

操作要求アプリは、同じスペースで`create-flownet-request-app.console.js`を実行して別に作成します。テンプレートは本番用とE2E用で共通ですが、アプリinstanceとAPIトークンは分離し、破壊的な競合・stale試験を本番要求へ混在させないでください。同名の「kSQL-FlowNet 操作要求」が存在する場合も、既存アプリを変更せず中止します。

操作要求アプリには`request_type`（`RERUN` / `STOP` / `RELEASE` / `START`）、`run_id`、`network_id`、`business_key`、`scheduled_for`、`rerun_from_node`、`reason`、`request_state`、`claimed_at`、`claimed_host`、`claim_heartbeat_at`、`result_code`、`result_message`を作成します。`network_id`と`business_key`は文字列1行、`scheduled_for`は日時です。STARTでは`run_id`を空にするためアプリ上は任意ですが、既存3種ではポーラーが引き続き必須として検証します。`request_state`の初期値は`REQUESTED`です。一覧は`01_未処理要求`（`REQUESTED`/`ACCEPTED`）と`02_拒否された要求`（`REJECTED`）の2件で、STARTの3入力欄も表示します。

[P2-11](../docs/p2-11-adhoc-start-spec.md)（START要求）のM1 schemaは本スクリプトへ反映済みです。STARTの起動可否は**三重ゲート**（①操作要求アプリのレコード追加権限 × ②VPS上のallowlistで対象networkに`app_start: true`を明示 × ③network定義の全実行対象ノードが明示的に`idempotent: true`）で決まり、`app_start`は省略時`false`です。アプリ側の設定だけでは起動できません。

同名の「kSQL-FlowNet 実行管理」または「kSQL-FlowNet 監査履歴」が存在する場合、スクリプトは既存アプリを変更せず中止します。確認ダイアログでキャンセルした場合は、各アプリの管理画面からpreviewの「変更を中止」してください。

### 本番用操作要求アプリの作成gate

1. 本番スペースで`create-flownet-request-app.console.js`を実行し、作成されたフィールド、初期値`REQUESTED`、2一覧を確認してデプロイします。途中で一覧作成が失敗した場合は、表示された状態を確認して`finish-request-app-views.console.js`で一覧だけを再開します。
2. 要求者のACLはレコード**追加・閲覧のみ**を基本とし、少なくとも`request_state`、`claimed_at`、`claimed_host`、`claim_heartbeat_at`、`result_code`、`result_message`を人に編集させない設定を推奨します。既存要求の編集・削除で再要求させず、毎回新規追加させます。
3. ポーラー専用APIトークンは**レコード閲覧・編集のみ**とし、追加・削除権限を付けません。E2E清掃用tokenとは分離し、token値を文書・Console出力・リポジトリへ残しません。
4. `01_未処理要求`（REQUESTED/ACCEPTED）と`02_拒否された要求`（REJECTED）を確認します。必要なら「REQUESTEDのまま1時間経過」を条件とするkintoneリマインダーを任意設定します。通知は補助であり、一覧確認を置き換えません。
5. 本番のアプリID、token、絶対allowlist pathを秘密環境ファイルへ設定し、cronを有効にする前に`ksql-flownet poll-requests --check`を実行します。成功するまで本番スケジュールへ接続しません。

## 既存アプリのレイアウト幅調整

既存の実行管理アプリには、先に`add-cancel-request-option.console.js`を実行して`CANCEL_REQUEST`選択肢を追加してください。

確認ボード用の3一覧を追加する場合は、`add-triage-views.console.js`を実行し、既存一覧を保持したまま内容を確認してデプロイしてください。

開発者ツールのConsoleで`adjust-flownet-app-layout.console.js`を実行し、promptへ実行管理と監査履歴のアプリIDを入力します。スクリプトは既存フィールドの`size`だけを変更し、フィールドの追加・削除・並び替えは行いません。内容を確認してからデプロイしてください。

## 「00_Run状況」カスタマイズビューの追加

`add-run-board-view.console.js`は、P2-08 Run Activityプラグインを使用する**実行管理アプリ**へ「00_Run状況」を追加します。監査履歴アプリや操作要求アプリには適用しません。先にプラグインzipをkintoneへ読み込み、対象の実行管理アプリへ追加して、監査履歴アプリIDの設定とアプリ設定の反映を完了してください。

1. アプリ管理権限のあるアカウントでkintoneへログインし、変更前の一覧設定を画面またはAPI応答で控えます。
2. 開発者ツールのConsoleへ`add-run-board-view.console.js`の内容を貼り付けて実行し、対象の実行管理アプリIDを入力します。
3. スクリプトはpreviewの全既存一覧を保持したまま、「00_Run状況」をindex 0へ1件だけ追加します。Consoleの内容を確認し、確認ダイアログでデプロイを承認します。
4. デプロイ完了後、「00_Run状況」を開き、プラグインが未終端Runを表示することを確認します。

確認を拒否した場合やエラーでpreviewに変更が残った場合は、アプリ設定画面から変更を中止します。デプロイ後に戻す場合は、控えておいた一覧設定を復元し、必要に応じてアプリからプラグインを無効化または削除します。

## 環境変数とAPIトークン権限

| アプリ                | アプリID環境変数              | APIトークン環境変数              | 本番トークン権限         |
| --------------------- | ----------------------------- | -------------------------------- | ------------------------ |
| kSQL-FlowNet 実行管理 | `KSQL_FLOWNET_STATE_APP_ID`   | `KSQL_FLOWNET_STATE_API_TOKEN`   | レコード追加・閲覧・編集 |
| kSQL-FlowNet 監査履歴 | `KSQL_FLOWNET_AUDIT_APP_ID`   | `KSQL_FLOWNET_AUDIT_API_TOKEN`   | レコード追加・閲覧・編集 |
| kSQL-FlowNet 操作要求 | `KSQL_FLOWNET_REQUEST_APP_ID` | `KSQL_FLOWNET_REQUEST_API_TOKEN` | レコード閲覧・編集       |

本番トークンにレコード削除権限は不要です。ロック解放はキークリアまたはtombstoneのUPDATE方式で行います。試験データの清掃で削除権限が必要な場合は、本番トークンと分離した別トークンを発行してください。

実行管理・監査履歴アプリのアクセス権はアプリ管理者とサービスアカウントに限定し、一般ユーザーには閲覧権限のみを付与する構成を推奨します。

操作要求アプリでは、要求者にレコード追加・閲覧を許可し、機械所有の状態・claim・結果フィールドは編集させないでください。ポーラー用トークンはレコード閲覧・編集のみ（追加・削除なし）とします。作成者・作成日時のkintoneシステムフィールドを要求者の真正性と順序の根拠に使うため、自己申告の要求者フィールドは追加しません。

## 既知の制約

- kintoneの`DATETIME`は分精度です。秒精度の実行時刻が必要な処理では、Execution ResultやJSONL側の値を使用してください。
- 一意制約を設定できる文字列フィールドは64文字までです。`record_key`などの一意キーはこの上限内で生成してください。
- kSQL-Flowのジョブロックキーには実測上限があり、各network定義で`profile名 + ":" + nodes[].job_id`を64 UTF-16単位以内にします。超過は現行`ksql-flownet validate`では検出されず、実行時に`VALIDATION_ERROR`になります。
- dropdownフィールドのクエリ条件は`in`演算子を使用します。`=`演算子は使用できません。

## 配布方式の補足(2026-08-31、kSQL-Flow側からの情報)

複数アプリを1ファイルで配布するには、kintoneの**システム管理→アプリテンプレート**でまとめて登録し、ダウンロードする経路を使用します（アプリ設定からの個別ダウンロードは1アプリのみ）。ACLはアプリテンプレートでは持ち出せないため、手順書での案内を同梱します（Q14方針のとおり）。
