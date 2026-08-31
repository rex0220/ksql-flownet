# M5 実機E2E

M5完了ゲートの実機確認用fixtureと実行スクリプトです。スクリプトは実kSQL-Flowをsubprocess起動し、FlowNetのスパイク2アプリとJOBログアプリ4249を読み戻して状態・相関を判定します。実機実行は人間が行ってください。

## 安全境界

- `fixtures/**/*.sql` は `SELECT` / `ASSERT` / `CREATE TEMP TABLE` のみです。既存アプリに対する `INSERT` / `UPDATE` / `UPSERT` / `DELETE` はありません。
- `LAPP_顧客管理`（4246）と`LAPP_案件管理`（4247）は読取専用です。
- 書込みが発生するのは、kSQL-Flow自身のJOBログ（4249）と、FlowNet永続化用の`KSQL_SPIKE_APP_EXEC` / `KSQL_SPIKE_APP_AUDIT`だけです。
- `m5-cleanup.mjs`はスパイク2アプリのM5試験レコードとM5ローカル作業ディレクトリだけを削除します。4249のレコードはkSQL-Flow所有の監査証跡なので削除しません。
- スクリプトはOS環境を子プロセスへ継承します。`KSQL_TOKEN_DEALS` / `KSQL_TOKEN_CUSTOMERS` / `KSQL_TOKEN_LOGS`は既存のkSQL-Flow設定どおりに使用されます。結果JSONでは名前に`TOKEN` / `SECRET` / `PASSWORD`を含む環境変数値を秘匿化します。

`job-longread.sql`はロック競合・kill試験用です。`$id`だけを投影して顧客管理と案件管理を各6回、合計12個のsource SELECTで読み、一時テーブルへ実体化します。最終集計とASSERT内のsubqueryを含めるとSELECT句は16個です。1 source SELECT約0.5秒という実機目安から5秒以上（目標約6秒）の競合窓を確保しつつ、読取専用かつkSQL-Flow profileの`maxReadRows` / `maxApiCalls`上限内で実行します。

## 実行前提・注意

- このリポジトリで`npm ci && npm run build`が完了していること。
- kSQL-Flow v0.7.0（M1実装済み）が`C:\Users\rex02\Projects\ksql-flow`にあること。
- configは`C:\Users\rex02\Projects\my-ksql-jobs\ksql.config.json`、profileは`prod`であること。
- 4249へ相関フィールド（`correlation_id` / `attempt_id` / `execution_id` / `job_id` / `runner_execution_started_at`）が適用済みであること。
- PowerShellから実行すること。`m5-kill-unknown.mjs`は`Get-CimInstance Win32_Process`で対象`--attempt-id`を持つkSQL-Flow子プロセスを1件に限定してkillします。
- VPSでは`poll_control` cronが5分間隔で稼働しています。ポーラーは`rerun_request`がチェックされたレコードだけをclaimします。M5 E2Eとcleanupは4249の`rerun_request`を参照・変更せず、試験レコードでも手動操作しないでください。
- ジョブ論理名はすべて`m5_`プレフィックスの専用名です。既存運用ジョブ名へ変更しないでください。
- kSQL-Flowは分散ロックの前に`process.cwd()`単位の`.ksql/lock-<profile>.json`を取得します。競合試験の2プロセスを同一cwdで起動するとローカルロック衝突（同じExit 5）となり、分散ロック裁定へ到達しません。`m5-lock-conflict.mjs`はFlowNet CLIをリポジトリroot、standalone holderをscope専用cwdから起動し、起動前assertでも両者の相違を保証します。
- `m5-lock-conflict.mjs`はstandalone holderの4249 JOBログについて、`job_id = m5_shared_read`かつ対象`attempt_id`の`RUNNING`をポーリング確認した後にだけnetworkを起動します。
- kill後に4249のRUNNINGが残ると、`prod:m5_shared_read`の`job_key`が最大3600秒ブロックされます。`m5-kill-unknown.mjs`はまず`inspect-lock`で照会し、残留時だけ`force-unlock-job --job-key prod:m5_shared_read --reason "M5 kill試験の後始末" --confirmed-by <実行者> --evidence-ref <結果JSONのfile URI> --json`を呼びます。4249を直接編集・削除してはいけません。
- kill試験の実行者名は`--confirmed-by <実行者>`または`M5_FORCE_UNLOCK_CONFIRMED_BY`で必ず指定してください。`LOCK_INSPECTION_RESULT`と、解除を実行した場合の`LOCK_RECOVERY_RESULT`は試験結果JSONへ保存されます。
- 4249への書込みはkSQL-Flowだけが行います。FlowNet/E2Eは`KSQL_TOKEN_LOGS_RO`による読取りだけで、4249へのPOST / PUT / DELETEを行いません。4249のM5レコードは削除せず、`m5_`ジョブ名と`correlation_id`（networkはFlowNet `run_id`、standaloneは`<M5 scope>_holder`）で識別して監査証跡として保持します。

必須環境変数は次のとおりです。

| 変数                     | 値・用途                                                |
| ------------------------ | ------------------------------------------------------- |
| `KSQL_SPIKE_BASE_URL`    | `https://devenxyfi.cybozu.com`                          |
| `KSQL_SPIKE_APP_EXEC`    | FlowNet state用スパイクアプリID（4246/4247/4249は禁止） |
| `KSQL_SPIKE_APP_AUDIT`   | FlowNet audit用スパイクアプリID（EXECとは別）           |
| `KSQL_SPIKE_TOKEN_EXEC`  | EXECアプリ書込トークン                                  |
| `KSQL_SPIKE_TOKEN_AUDIT` | AUDITアプリ書込トークン                                 |
| `KSQL_TOKEN_DEALS`       | kSQL-Flowが案件管理4247を読むOS環境変数                 |
| `KSQL_TOKEN_CUSTOMERS`   | kSQL-Flowが顧客管理4246を読むOS環境変数                 |
| `KSQL_TOKEN_LOGS`        | kSQL-FlowがJOBログ4249へ書くOS環境変数                  |
| `KSQL_TOKEN_LOGS_RO`     | FlowNet/E2Eが4249の開始マーカー・相関を読むトークン     |
| `KSQL_FLOW_LOG_APP_ID`   | `4249`（省略時も4249。別IDは拒否）                      |
| `KSQL_FLOW_BIN`          | kSQL-Flowを起動する実行ファイル（既定例は`node.exe`）   |
| `KSQL_FLOW_BIN_ARGS`     | kSQL-Flow契約引数より前へ渡す引数（下記参照）           |

任意環境変数です。

| 変数                           | 既定値                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| `KSQL_FLOW_CONFIG`             | `C:\Users\rex02\Projects\my-ksql-jobs\ksql.config.json`                |
| `KSQL_FLOWNET_PROFILE`         | `prod`                                                                 |
| `KSQL_FLOW_WORKDIR`            | `%TEMP%\ksql-flownet-m5-work`（この下に試験scope別ディレクトリを作成） |
| `M5_FORCE_UNLOCK_CONFIRMED_BY` | kill後のforce-unlockを確認した実行者（`--confirmed-by`指定時は省略可） |

### kSQL-Flow起動設定

現在の既定例は、ソース配置からNode版CLIを起動する次の設定です。パスにスペースが含まれても保持できるよう、`KSQL_FLOW_BIN_ARGS`はJSON配列形式にします。

```powershell
$env:KSQL_FLOW_BIN = 'node.exe'
$env:KSQL_FLOW_BIN_ARGS = '["C:\\Users\\rex02\\Projects\\ksql-flow\\dist\\cli.js"]'
```

スペースを含まない複数引数は、空白区切りでも指定できます。どちらの形式でも、これらの引数は`capabilities`、`describe-profile`、`inspect-job`、`run`などのkSQL-Flow契約引数より前へ渡されます。

```powershell
$env:KSQL_FLOW_BIN_ARGS = 'C:\ksql-flow\dist\cli.js --trace-warnings'
```

`dist-bin\ksql-flow.exe`が再ビルドされた後は、`KSQL_FLOW_BIN`へそのexeを指定し、`KSQL_FLOW_BIN_ARGS`を未設定にすればexe単体起動へ戻せます。

## fixture

| fixture                | DAG                                         | 用途                                       |
| ---------------------- | ------------------------------------------- | ------------------------------------------ |
| `network-success.yaml` | `n1_extract -> n2_aggregate -> n3_finalize` | 直列SUCCESS・相関・時刻非重複              |
| `network-midfail.yaml` | `n1_extract -> n2_fail -> n3_finalize`      | 中央の決定的`ASSERT_FAILED`と下流`BLOCKED` |
| `network-diamond.yaml` | `n1_customers`, `n2_deals` -> `n3_join`     | 複数開始点・分岐合流、独立系統継続         |
| `job-longread.sql`     | standaloneまたはdiamondのn1へ差替え         | Node lock保持、開始マーカー後kill          |

全networkは`business_key_policy.type: explicit`、lease 60秒 / heartbeat 15秒（heartbeatはleaseの1/3以下）です。`job-longread.sql`と各networkのn1は同じ`job_id: m5_shared_read`を持ち、`node_id != job_id`を明示的に通します。

## 実行順

先にfixtureのFlowNet構造検証を行います。これはkSQL-Flowを起動せず、YAML/DAG/SQLファイル存在だけを検証します。

```powershell
node dist\cli\index.js validate tests\e2e\fixtures\network-success.yaml
node dist\cli\index.js validate tests\e2e\fixtures\network-midfail.yaml
node dist\cli\index.js validate tests\e2e\fixtures\network-diamond.yaml
```

SQLの実機`validate`は実行担当者が、上記環境変数を設定後に次の形で各SQLへ実施してください（準備実装では実機接続を行いません）。

```powershell
node C:\Users\rex02\Projects\ksql-flow\dist\cli.js validate -f tests\e2e\fixtures\jobs\success-n1-extract.sql --profile prod --config C:\Users\rex02\Projects\my-ksql-jobs\ksql.config.json
```

E2Eは競合を避けるため必ず直列に実行します。kill試験だけは実行者確認値を渡します。

```powershell
node tests\e2e\m5-serial-success.mjs
node tests\e2e\m5-mid-failure.mjs
node tests\e2e\m5-resume.mjs
node tests\e2e\m5-lock-conflict.mjs
node tests\e2e\m5-kill-unknown.mjs --confirmed-by $env:USERNAME
node tests\e2e\m5-cleanup.mjs
```

各スクリプトは`tests/e2e/results/<timestamp>-<script>.json`へ秘匿済み結果を保存します。通常は各シナリオが自己清掃します。異常終了で残った場合は最後に`m5-cleanup.mjs`を実行してください。

## M5ゲート対応

| 受入             | スクリプト              | 実測する内容                                                                                                             |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1                | `m5-mid-failure.mjs`    | n2=`FAILED / ASSERT_FAILED`、n3=`BLOCKED`、Run=`FAILED`                                                                  |
| 2・3・4          | `m5-resume.mjs`         | 同一RunのRESUME、n1 preserved（Attempt追加なし）、冪等n2のattempt_no=2再失敗、n3再評価                                   |
| 直列SUCCESS      | `m5-serial-success.mjs` | 3 Node/Attempt SUCCESS、Run/Invocation SUCCESS、Attempt時刻非重複                                                        |
| JOBログ相関      | `m5-serial-success.mjs` | 4249のcorrelation/attempt/execution/job IDとFlowNet Attemptの一致                                                        |
| 複数開始点・合流 | `network-diamond.yaml`  | n1/n2独立開始、n3が両方へ依存                                                                                            |
| 10・24           | `m5-lock-conflict.mjs`  | standalone RUNNING確認後、同job_idのn1を`CANCELLED / PREPARE_FAILED`、Stateを`WAITING`、attempt番号保持。独立n2はSUCCESS |
| 23相当           | `m5-kill-unknown.mjs`   | 4249の耐久開始マーカー確認後に子プロセスkill。n1 Attempt/State=`UNKNOWN`、独立n2継続、n3 BLOCKED、Run=`UNKNOWN`          |

## 4249の識別と清掃

試験レコードは次で識別できます。

- FlowNetスパイク2アプリ: `business_key`または動的`network_id`が`M5`で始まる。関連するNode State / Attempt / Invocationは同じ`run_id`で追跡する。
- 4249: network実行は`correlation_id = FlowNet run_id`、`attempt_id = FlowNet node_attempt_id`。standalone lock holderは`correlation_id = <M5 scope>_holder`、`attempt_id = <M5 scope>_standalone`。
- ローカル: `KSQL_FLOW_WORKDIR`配下のディレクトリ名が`M5`で始まる。

`m5-cleanup.mjs`は上記FlowNetレコード、Network lock、ローカル作業ディレクトリを削除します。4249は読取専用トークンで照合し、削除APIを呼びません。4249に残るM5 JOBログは監査証跡として保持してください。

## M6ゲートE2E

M6のresume、UNKNOWN分離、非冪等Nodeの手動解決、Network lock回収、read-only status、Cloud Run停止確認のfail-closedを確認するハーネスです。上記の安全境界と実行前提・注意はM6にもそのまま適用されます。M6のジョブ論理名はすべて`m6_`プレフィックスで、SQL fixtureは参照系`SELECT`と`ASSERT`だけです。`KSQL_FLOWNET_SERVICE_PRINCIPAL`と`KSQL_FLOWNET_REQUESTED_BY`はハーネスがM6試験用主体へ設定します。

追加fixtureは次のとおりです。

| fixture                   | DAG                                          | 用途                                     |
| ------------------------- | -------------------------------------------- | ---------------------------------------- |
| `network-m6-midfail.yaml` | `n1_extract -> n2_fail -> n3_finalize`       | resume時のRun/Invocation identity        |
| `network-nonidem.yaml`    | `n1_read -> n2_nonidem -> n3_finalize`       | 非冪等SQL_ERRORと手動完遂                |
| `network-drill.yaml`      | `n1_longread`, `n2_independent` -> `n3_join` | UNKNOWN分離、30秒lease、force-unlock訓練 |

E2E実機実行はレビュー担当者がPowerShellから直列に行ってください。各シナリオはprepare、検証、結果JSON保存、試験scopeのcleanupまで自己完結します。

```powershell
node tests\e2e\m6-01-resume-identity.mjs
node tests\e2e\m6-02-unknown-isolation.mjs
node tests\e2e\m6-03-nonidem-no-auto-rerun.mjs
node tests\e2e\m6-04-force-unlock-drill.mjs
node tests\e2e\m6-05-status-readonly.mjs
node tests\e2e\m6-06-cloudrun-failclosed.mjs
```

`m6-04`は実行中のFlowNetプロセスツリーを子から親の順で停止し、30秒leaseの生存中拒否、失効、owner不一致、`local_pid`のESRCH確認、監査付き回収、statusが返した復旧識別子による裁定・解決・resumeを確認します。`m6-05`はstatus前後のstate/audit全レコードrevisionを比較します。`m6-06`は実GCP照会を行わず、形式不一致、アクセストークン未設定、未知stop methodをすべて`STOP_NOT_CONFIRMED`として検証します。

## M7受入ギャップE2E

M7は受入5・26・28とWindows停止時の残存状態を実機で確認します。M5/M6と同じ環境変数・安全境界を継承し、レビュー担当者がPowerShellから直列に実行してください。各シナリオはM7 scopeを作成し、結果を`tests/e2e/results/`へ保存してから自己清掃します。

```powershell
node tests\e2e\m7-01-acceptance-gaps.mjs
node tests\e2e\m7-02-kintone-drain.mjs
node tests\e2e\m7-03-control-plane-api-calls.mjs
node tests\e2e\m7-04-windows-sigbreak.mjs
```

| スクリプト                          | 実測する内容                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m7-01-acceptance-gaps.mjs`         | `network-drill`の全SUCCESSと`$id`順の直列実行、および作業fixtureの失敗SQLを成功版へ変えてもresumeが保存済み失敗SQLを再実行すること                      |
| `m7-02-kintone-drain.mjs`           | FlowNetだけのkintone通信遮断。回復時の結果保存と`NETWORK_LEASE_INTERRUPTED`、非回復時のstate/audit無変更、およびforce-unlockと孤児裁定による清掃        |
| `m7-03-control-plane-api-calls.mjs` | 3 Nodeの参照系Run、`status --json`、`LOCK_NOT_FOUND`となるforce-unlockについて、records/file/その他とheartbeat PUTのcontrol-plane API呼出数を別々に記録 |
| `m7-04-windows-sigbreak.mjs`        | n1実行中のFlowNetへ`SIGBREAK`を送り、graceful drainか単純終了かを記録し、残ったRUNNING孤児をforce-unlockとresume孤児裁定で回収できること                |

`fault-hook.mjs`は`NODE_OPTIONS=--import`でFlowNet起動時だけ読み込みます。`process.argv[1]`がこのリポジトリの`dist/cli/index.js`と一致するときだけfetchを包むため、子のkSQL-Flowプロセスは遮断しません。制御ファイルは`pass` / `block` / `block-writes`を受け付け、通常試験は全通信を止める`block`を使用します。JSONLログは時刻、HTTP method、URL path、遮断有無、heartbeat分類だけを保存し、URL query、header、body、API tokenは保存しません。

`m7-02`と`m7-04`は30秒leaseの失効を待つ回収工程があるため、完了まで数分かかる場合があります。`m7-04`はWindows専用です。これらのスクリプトをCIや非Windows環境で実行しないでください。

## SQL文法の根拠

- `C:\Users\rex02\Projects\ksql-flow\docs\ksql_flow_spec.md` 3.1〜3.3: dialect 1ヘッダ、`SELECT COUNT(*)`、`ASSERT (<scalar subquery>) <comparison>, 'message'`。
- 同仕様 3.2: ASSERT違反はABORTED / Exit 2。M1 execution contractではFlowNet向けresultCodeが`ASSERT_FAILED`。
- `C:\Users\rex02\Projects\ksql-flow\examples\jobs\01_sync_master_customers.sql` / `02_monthly_sales_sync.sql`: 3ヘッダ、LAPP参照、COUNT scalar subquery、ASSERTの公式例。
- `C:\Users\rex02\Projects\kintone-sql-tools\src\flow-library\__tests__\previewStatement.test.ts`: `ASSERT (SELECT 1) = 1, 'ok'`のdialect 1実装例。本fixtureは比較値を0にして決定的失敗にする。
- `C:\Users\rex02\Projects\kintone-sql-tools\src\cli\__tests__\b168_dialect1.e2e.test.ts`: `CREATE TEMP TABLE ... AS SELECT`と後続ASSERTのdialect 1 E2E例。
- `C:\Users\rex02\Projects\kintone-sql-tools\src\__tests__\b105UnionCountTotalCount.test.ts`: 複数アプリの`COUNT(*) ... UNION ALL`実装例。

これらは文法根拠の机上確認です。実kSQL-Flowの`validate`と本実行結果は、実行担当者のゲート結果として別途保存してください。

## 本番パイロットとの同居条件(2026-08-31)

本番パイロット(4261/4262、月次案件集計バッチ)とE2E(4257/4258)はJOBログアプリ4249を共有する。E2Eは**本番のjob_id(`intake_count` / `test_data_gate` / `monthly_deal_summary`)を絶対に使用しない**こと(lock名前空間の分離。既存のm5_〜m8_プレフィックス規約を厳守)。4249の読取専用・直接編集禁止・rerun_request不触の既存規律も従来どおり。ログ混在ノイズが運用の支障になった場合はE2E専用プロファイル(別ログアプリ)への分離を検討する。
