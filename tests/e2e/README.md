# M5 実機E2E

M5完了ゲートの実機確認用fixtureと実行スクリプトです。スクリプトは実kSQL-Flowをsubprocess起動し、FlowNetのスパイク2アプリとE2E専用JOBログアプリ4264を読み戻して状態・相関を判定します。実機実行は人間が行ってください。

## 安全境界

- `fixtures/**/*.sql` は `SELECT` / `ASSERT` / `CREATE TEMP TABLE` のみです。既存アプリに対する `INSERT` / `UPDATE` / `UPSERT` / `DELETE` はありません。
- `LAPP_顧客管理`（4246）と`LAPP_案件管理`（4247）は読取専用です。
- 書込みが発生するのは、kSQL-Flow自身のE2E専用JOBログ（4264）と、FlowNet永続化用の`KSQL_SPIKE_APP_EXEC` / `KSQL_SPIKE_APP_AUDIT`だけです。
- `m5-cleanup.mjs`はスパイク2アプリのM5試験レコードとM5ローカル作業ディレクトリだけを削除します。4264のレコードはkSQL-Flow所有の試験証跡なので削除しません。
- スクリプトはOS環境を子プロセスへ継承します。`KSQL_TOKEN_DEALS` / `KSQL_TOKEN_CUSTOMERS` / `KSQL_E2E_TOKEN_LOGS`は既存のkSQL-Flow設定どおりに使用されます。結果JSONでは名前に`TOKEN` / `SECRET` / `PASSWORD`を含む環境変数値を秘匿化します。

`job-longread.sql`はロック競合・kill試験用です。`$id`だけを投影して顧客管理と案件管理を各6回、合計12個のsource SELECTで読み、一時テーブルへ実体化します。最終集計とASSERT内のsubqueryを含めるとSELECT句は16個です。1 source SELECT約0.5秒という実機目安から5秒以上（目標約6秒）の競合窓を確保しつつ、読取専用かつkSQL-Flow profileの`maxReadRows` / `maxApiCalls`上限内で実行します。

## 実行前提・注意

- このリポジトリで`npm ci && npm run build`が完了していること。
- kSQL-Flow v0.7.0（M1実装済み）が`C:\Users\rex02\Projects\ksql-flow`にあること。
- configは`C:\Users\rex02\Projects\my-ksql-jobs\ksql.config.json`、profileは`e2e`であること。
- 4264へ相関フィールド（`correlation_id` / `attempt_id` / `execution_id` / `job_id` / `runner_execution_started_at`）が適用済みであること。
- PowerShellから実行すること。`m5-kill-unknown.mjs`は`Get-CimInstance Win32_Process`で対象`--attempt-id`を持つkSQL-Flow子プロセスを1件に限定してkillします。
- 本番JOBログアプリ4249はE2Eから参照・変更しません。ハーネスは`KSQL_E2E_LOG_APP_ID=4249`を拒否します。
- ジョブ論理名はすべて`m5_`プレフィックスの専用名です。既存運用ジョブ名へ変更しないでください。
- kSQL-Flowは分散ロックの前に`process.cwd()`単位の`.ksql/lock-<profile>.json`を取得します。競合試験の2プロセスを同一cwdで起動するとローカルロック衝突（同じExit 5）となり、分散ロック裁定へ到達しません。`m5-lock-conflict.mjs`はFlowNet CLIをリポジトリroot、standalone holderをscope専用cwdから起動し、起動前assertでも両者の相違を保証します。
- `m5-lock-conflict.mjs`はstandalone holderの4264 JOBログについて、`job_id = m5_shared_read`かつ対象`attempt_id`の`RUNNING`をポーリング確認した後にだけnetworkを起動します。
- kill後に4264のRUNNINGが残ると、`e2e:m5_shared_read`の`job_key`が最大3600秒ブロックされます。`m5-kill-unknown.mjs`はまず`inspect-lock`で照会し、残留時だけ`force-unlock-job --job-key e2e:m5_shared_read --reason "M5 kill試験の後始末" --confirmed-by <実行者> --evidence-ref <結果JSONのfile URI> --json`を呼びます。4264を直接編集・削除してはいけません。
- kill試験の実行者名は`--confirmed-by <実行者>`または`M5_FORCE_UNLOCK_CONFIRMED_BY`で必ず指定してください。`LOCK_INSPECTION_RESULT`と、解除を実行した場合の`LOCK_RECOVERY_RESULT`は試験結果JSONへ保存されます。
- 4264への書込みはkSQL-Flowだけが`KSQL_E2E_TOKEN_LOGS`で行います。FlowNet/E2Eは`KSQL_E2E_TOKEN_LOGS_RO`による読取りだけで、4264へのPOST / PUT / DELETEを行いません。4264の試験レコードは削除せず、`m5_`〜`m8_`ジョブ名と`correlation_id`で識別します。

必須環境変数は次のとおりです。

| 変数                     | 値・用途                                                    |
| ------------------------ | ----------------------------------------------------------- |
| `KSQL_SPIKE_BASE_URL`    | `https://devenxyfi.cybozu.com`                              |
| `KSQL_SPIKE_APP_EXEC`    | FlowNet state用スパイクアプリID（参照元・ログアプリは禁止） |
| `KSQL_SPIKE_APP_AUDIT`   | FlowNet audit用スパイクアプリID（EXECとは別）               |
| `KSQL_SPIKE_TOKEN_EXEC`  | EXECアプリ書込トークン                                      |
| `KSQL_SPIKE_TOKEN_AUDIT` | AUDITアプリ書込トークン                                     |
| `KSQL_TOKEN_DEALS`       | kSQL-Flowが案件管理4247を読むOS環境変数                     |
| `KSQL_TOKEN_CUSTOMERS`   | kSQL-Flowが顧客管理4246を読むOS環境変数                     |
| `KSQL_E2E_LOG_APP_ID`    | E2E専用JOBログアプリID（`4264`。必須）                      |
| `KSQL_E2E_TOKEN_LOGS`    | kSQL-Flowが4264へ書くトークン                               |
| `KSQL_E2E_TOKEN_LOGS_RO` | FlowNet/E2Eが4264の開始マーカー・相関を読むトークン         |
| `KSQL_FLOW_BIN`          | kSQL-Flowを起動する実行ファイル（既定例は`node.exe`）       |
| `KSQL_FLOW_BIN_ARGS`     | kSQL-Flow契約引数より前へ渡す引数（下記参照）               |

任意環境変数です。

| 変数                           | 既定値                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| `KSQL_FLOW_CONFIG`             | `C:\Users\rex02\Projects\my-ksql-jobs\ksql.config.json`                |
| `KSQL_FLOWNET_PROFILE`         | `e2e`（未設定時も`e2e`。本番プロファイルは拒否）                       |
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
node C:\Users\rex02\Projects\ksql-flow\dist\cli.js validate -f tests\e2e\fixtures\jobs\success-n1-extract.sql --profile e2e --config C:\Users\rex02\Projects\my-ksql-jobs\ksql.config.json
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
| JOBログ相関      | `m5-serial-success.mjs` | 4264のcorrelation/attempt/execution/job IDとFlowNet Attemptの一致                                                        |
| 複数開始点・合流 | `network-diamond.yaml`  | n1/n2独立開始、n3が両方へ依存                                                                                            |
| 10・24           | `m5-lock-conflict.mjs`  | standalone RUNNING確認後、同job_idのn1を`CANCELLED / PREPARE_FAILED`、Stateを`WAITING`、attempt番号保持。独立n2はSUCCESS |
| 23相当           | `m5-kill-unknown.mjs`   | 4264の耐久開始マーカー確認後に子プロセスkill。n1 Attempt/State=`UNKNOWN`、独立n2継続、n3 BLOCKED、Run=`UNKNOWN`          |

## E2Eログの識別と清掃

試験レコードは次で識別できます。

- FlowNetスパイク2アプリ: `business_key`または動的`network_id`が`M5`で始まる。関連するNode State / Attempt / Invocationは同じ`run_id`で追跡する。
- 4264: network実行は`correlation_id = FlowNet run_id`、`attempt_id = FlowNet node_attempt_id`。standalone lock holderは`correlation_id = <M5 scope>_holder`、`attempt_id = <M5 scope>_standalone`。
- ローカル: `KSQL_FLOW_WORKDIR`配下のディレクトリ名が`M5`で始まる。

`m5-cleanup.mjs`は上記FlowNetレコード、Network lock、ローカル作業ディレクトリを削除します。4264は読取専用トークンで照合し、削除APIを呼びません。4264に残るM5 JOBログは試験証跡として保持してください。

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

## P2-01 要求アプリE2E

P2-01の実機受入は、本番の操作要求アプリとは別のE2E専用アプリで行います。アプリ名は`kSQL-FlowNet 操作要求 P2-01 E2E`とし、profile `e2e`、FlowNet state/auditのスパイクアプリ、E2E JOBログアプリだけへ接続してください。ハーネスはprofile `prod`、本番アプリID 4261/4262/4249、本番要求アプリと同じID/token、`KSQL_FLOW_TEST_`以外のnetwork/node/job IDをpreflightで拒否します。

作成手順: `templates/create-flownet-request-app.console.js`を一時コピーし、コピーの`APP_NAME`だけを`"kSQL-FlowNet 操作要求 P2-01 E2E"`へ変更してブラウザConsoleで実行します（正本テンプレート自体は変更しません）。

作成後は`templates/README.md`のフィールド、一覧、ACLを照合します。P2-01 E2Eでは次の2 tokenをE2E要求アプリ専用で発行します。本番ポーラーtokenは追加・削除権限を持たせません。

| 変数                         | 権限・用途                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `KSQL_E2E_REQUEST_APP_ID`    | E2E専用操作要求アプリID。4261/4262/4249および本番要求アプリIDは禁止              |
| `KSQL_E2E_TOKEN_REQUESTS`    | E2Eハーネスの要求追加、ポーラーの読取/編集、prefix限定清掃に使用するE2E専用token |
| `KSQL_E2E_TOKEN_REQUESTS_RO` | ハーネスの結果照合専用token。レコード閲覧のみ                                    |

`KSQL_E2E_TOKEN_REQUESTS`はE2E専用アプリに限ってレコード追加・閲覧・編集・削除を許可します。削除APIを呼ぶのはハーネスのfixture清掃だけで、`reason`が実行scope（`KSQL_FLOW_TEST_...:`）から始まるレコードに限定されます。非終端の要求が1件でも残っている場合は、別ポーラーによる誤処理を避けるため開始前に停止します。token値、実アプリID、reason本文はリポジトリや結果JSONへ保存しません。

PowerShellではUser環境変数へ3変数を設定してからsetup scriptをdot-sourceします。値はこのREADMEや`setup-env.ps1`へ書きません。

```powershell
. .\tests\e2e\setup-env.ps1
```

実機E2Eは次の順序で必ず直列に実行します。各スクリプトは要求レコード、Run/Invocation/Node State、監査の相関を結果JSONへ保存した後、自分のscopeの要求レコードとFlowNet fixtureを清掃します。

```powershell
node tests\e2e\p2-01-01-rerun.mjs
node tests\e2e\p2-01-02-rerun-from.mjs
node tests\e2e\p2-01-03-rejections.mjs
node tests\e2e\p2-01-04-stop-release.mjs
node tests\e2e\p2-01-05-claim-stale.mjs
node tests\e2e\p2-01-06-get-failclosed.mjs
```

| スクリプト                | 実測する受入                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `p2-01-01-rerun`          | 1: FAILED Runの完走、要求DONE、`requested_by=app-request:<record_id>:<creator>`相関    |
| `p2-01-02-rerun-from`     | 2・9: 冪等Nodeからの再実行、上流preserve、RETRY_BRAKEのDONE記録と`rerun_from_node`解除 |
| `p2-01-03-rejections`     | 3: 不在/SUCCESS/LIVE/hold拒否とFlowNet状態不変                                         |
| `p2-01-04-stop-release`   | 4・5: 次Node境界STOP、hold、RELEASE単独非起動、別RERUN要求による完走                   |
| `p2-01-05-claim-stale`    | 6・7: 同時claim一意性、実行済み/未実行staleの非再実行、実child中heartbeat              |
| `p2-01-06-get-failclosed` | 8: 無効tokenによる要求GET失敗時の要求/state/audit無書込とchild非起動                   |

`resume_allowed=false`、ARCHIVED、UNKNOWN、不正フィールド、allowlistの曖昧/不一致、結果PUT競合、出力上限、一時reasonファイル削除など、実機固有でない§2.4境界は`tests/unit/poll-requests*.test.mjs`、`request-store.test.mjs`、`flownet-child-client.test.mjs`で判定します。静的・単体合格を上記実機受入の代用にはしません。

## P2-11 START要求E2E

P2-11はP2-01と同じE2E専用操作要求アプリ・環境変数・本番ID拒否・token分離を使用します。先に`templates/add-start-fields.console.js`をE2E要求アプリへ適用し、`START`、`network_id`、`business_key`、`scheduled_for`、任意化された`run_id`、対象2一覧を確認してください。実行中に使うallowlistはスクリプトが一時生成し、START対象だけへ`app_start: true`を明示します。

fixtureは次の2件です。全Nodeが`idempotent: true`で、顧客管理・案件管理は参照だけを行います。JOBログアプリは既存どおり書込み結果の照合だけに使用し、E2Eから削除しません。非冪等networkは計画どおり単体S03だけで担保します。

| fixture                       | policy                                 | 用途                                          |
| ----------------------------- | -------------------------------------- | --------------------------------------------- |
| `network-p211-explicit.yaml`  | `explicit`                             | 明示キーSTART、重複、拒否、STALE、RERUN回帰   |
| `network-p211-scheduled.yaml` | `scheduled_period`（Asia/Tokyo・月次） | 対象月キー導出、correction、`as_of`、cron回帰 |

M3計画§5の順序どおり、拒否によるstate/audit不変を最初に確認してから、正常系・重複・障害回帰を直列実行します。並列実行は禁止です。

```powershell
. .\tests\e2e\setup-env.ps1
node tests\e2e\p2-11-04-rejections.mjs
node tests\e2e\p2-11-01-explicit.mjs
node tests\e2e\p2-11-02-scheduled.mjs
node tests\e2e\p2-11-03-duplicates.mjs
node tests\e2e\p2-11-05-stale-regression.mjs
```

各シナリオは`KSQL_FLOW_TEST_` scope以外のnetwork/node/job IDと要求cleanupを拒否します。`job_id`はP2-01の短縮`jobScope`を共用し、profileを含む64 UTF-16単位制約内に収めます。要求レコードとFlowNet state/audit fixtureは各シナリオ終了時に必ずcleanupされ、cleanup失敗は不合格です。JOBログは試験証跡として残します。

`p2-11-04-rejections`の不正日時は、kintoneのDATETIME型が不正文字列を保存前に拒否することとstate/audit不変を実測します。ポーラー内部の`INVALID_TIMESTAMP_FORMAT`（日付のみ・offsetなし・実在しない日時）の詳細matrixは単体S11が正です。`p2-11-02-scheduled`は案件管理をGETだけで独立集計し、その件数・売上合計を一時fixtureの`ASSERT`へ埋めます。Runと各JOBログの`as_of`、Attemptの参照件数、書込0件も照合するため、対象期間断面の集計結果を業務アプリへ書き込まず直接確認します。

`p2-11-05-stale-regression`はclaim後にポーラーが失われた永続状態を`ACCEPTED`要求として再現し、STALE回収、自動再claimなし、Run/Invocation不増加、人の再要求がNOOPへ収束することを確認します。同じシナリオで`app_start:false` networkのRERUNと、`run-network --scheduled-for ... --resume`のcron相当経路も確認します。P2-01のSTOP/RELEASE全体の実機証拠は既存`p2-01-04-stop-release.mjs`を引き続き正とします。

## CSV取込 段階1 E2E

CSV段階1は、既存のE2E state/audit/JOBログアプリに加えて、取込先を専用fixtureアプリへ分離します。顧客管理・案件管理は書込先にせず、本番JOBログアプリも使用しません。fixtureアプリには次のフィールドだけを作成し、E2E用tokenへレコード閲覧・追加・編集・削除権限を付与してください。

| 環境変数                     | 用途                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `KSQL_FLOWNET_IO_DIR`        | 実行者が用意した既存の絶対directory。各シナリオはこの直下にscope固有IO rootと`in/`・`out/`を一時作成して終了時に削除 |
| `KSQL_CSV1_TARGET_APP_ID`    | `test_key`（文字列1行・重複禁止）と`test_value`（文字列1行）を持つCSV専用fixtureアプリ                               |
| `KSQL_CSV1_TARGET_API_TOKEN` | 上記fixtureアプリ専用の閲覧・追加・編集・削除token                                                                   |

`KSQL_CSV1_TARGET_APP_ID`はstate、audit、E2E JOBログ、操作要求の各アプリと同じIDにできません。さらにkSQL-Flow configの既存logical appとIDが重なる場合も開始前に拒否します。ハーネスは一時configへ`LAPP_KSQL_FLOW_TEST_CSV1`だけを追加し、token値を保存しません。すべての取込キーは`KSQL_FLOW_TEST_`で始まり、cleanupは今回生成した完全なキー集合を再照会してからID/revision指定で削除します。JOBログは削除しません。

セットアップ後、安全な拒否系から次の順で直列実行します。実機実行はこのリポジトリ作成工程には含めません。

```powershell
. .\tests\e2e\setup-env.ps1
node tests\e2e\csv1-03-rejections.mjs
node tests\e2e\csv1-01-import-run.mjs
node tests\e2e\csv1-02-mutated-resume.mjs
node tests\e2e\csv1-04-10k-measure.mjs
```

| スクリプト               | 実測内容                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csv1-03-rejections`     | `INPUT_FILE_MISSING`、root外を指すsymlink/junctionの`INPUT_PATH_REJECTED`、`importCsv:false` capabilityのロック前拒否。Windowsでlink作成権限がない場合はskip理由と正本のunit test名を結果へ記録 |
| `csv1-01-import-run`     | UTF-8の一気通貫SUCCESS、Attemptのbaselineとrows/encoding、専用アプリのセル一致、監査への絶対path・セル値非漏出                                                                                  |
| `csv1-02-mutated-resume` | 250行の第1書込chunk成功後に第2chunkを非再試行HTTP 400で失敗させ、同じCSVの通常resumeが全key各1件へ収束。別のFAILED Runでは差替え後resumeを`INPUT_FILE_MUTATED`でInvocation作成前に拒否          |
| `csv1-04-10k-measure`    | 2列・10,000 data rowをUTF-8とSJIS（ASCII内容）で各1回取込。壁時計時間と、kSQL-Flow子プロセス内`process.memoryUsage()`を10ms間隔で採取したpeakを結果JSONへ保存                                   |

途中失敗hookはkSQL-Flowのorchestrator `run`子プロセスだけに作用し、対象fixtureアプリへの2回目のrecords POST/PUTだけをHTTP 400にします。FlowNetのstate/audit通信、capability/inspection、他アプリには作用しません。各ケースは結果を`tests/e2e/results/`へ保存し、終了時にstate/audit、要求（該当時）、IO root、専用アプリの書込レコードを清掃します。10,000件はflatな2列fixtureのgateであり、サブテーブル有無の比較はこのハーネスの対象外です。

## CSV出力 段階2 E2E

CSV段階2は段階1と同じ専用fixtureアプリ、`KSQL_CSV1_TARGET_*`、`KSQL_FLOWNET_IO_DIR`を使用します。`setup-env.ps1`が指定する隣接`C:\Users\rex02\Projects\ksql-flow\dist\cli.js`（v0.9.0 / engine 3.77.0、main 0a66c35のbuild）以外はpreflightで拒否します。実機では先に`cli-kintone`をPATHへ追加し、`cli-kintone record import`が利用できることを確認してください。認証は`KSQL_CSV1_TARGET_API_TOKEN`を`--api-token`引数へ渡しますが、token値は標準出力、エラー、結果JSONへ保存しません。

安全なfail-closed系から始め、次の順序で必ず直列実行します。

```powershell
. .\tests\e2e\setup-env.ps1
node tests\e2e\csv2-04-failclosed.mjs
node tests\e2e\csv2-01-export-run.mjs
node tests\e2e\csv2-02-roundtrip.mjs
node tests\e2e\csv2-03-clikintone.mjs
```

| スクリプト           | 実測内容                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csv2-04-failclosed` | 受入15・16。temp table実体化後の後続文失敗で既存file不変・一時fileなし、U+301Cを含むSJIS exportで完成fileなし。受入14の単体/contract test参照も結果へ記録                 |
| `csv2-01-export-run` | CSV取込→変換検査→UTF-8 exportの3 Node SUCCESS、`output_files`のsha256/rows/encoding、完成bytes、監査へのin/out絶対path・セル値非漏出                                      |
| `csv2-02-roundtrip`  | 受入1・17。UTF-8/SJIS（ASCII data）のexport bytesを`out/`からimport専用`in/`境界へ無変更コピーし、`BY NAME`で別キー空間へ取込。同一Runの`--rerun-from`でexport sha256一致 |
| `csv2-03-clikintone` | 受入3。kSQL UTF-8 exportを公式`cli-kintone record import --update-key test_key`で専用アプリの別キー空間へ取込                                                             |

SJISケースではE2E専用`csv2-encoding-wrapper.mjs`が、同じ`KSQL_FLOW_BIN`と`KSQL_FLOW_BIN_ARGS`へexport実行時だけ`--export-encoding sjis`を追加します。これは現行FlowNetの`outputs`定義がpathだけを持ちencodingを持たないためです。各スクリプトは自分が作成した`KSQL_FLOW_TEST_`キーのレコード、scope固有IO `in/`・`out/`、一時network/configを`finally`で清掃し、state/audit fixtureは共通E2E gateが清掃します。業務アプリは読取もしません。

## SQL文法の根拠

- `C:\Users\rex02\Projects\ksql-flow\docs\ksql_flow_spec.md` 3.1〜3.3: dialect 1ヘッダ、`SELECT COUNT(*)`、`ASSERT (<scalar subquery>) <comparison>, 'message'`。
- 同仕様 3.2: ASSERT違反はABORTED / Exit 2。M1 execution contractではFlowNet向けresultCodeが`ASSERT_FAILED`。
- `C:\Users\rex02\Projects\ksql-flow\examples\jobs\01_sync_master_customers.sql` / `02_monthly_sales_sync.sql`: 3ヘッダ、LAPP参照、COUNT scalar subquery、ASSERTの公式例。
- `C:\Users\rex02\Projects\kintone-sql-tools\src\flow-library\__tests__\previewStatement.test.ts`: `ASSERT (SELECT 1) = 1, 'ok'`のdialect 1実装例。本fixtureは比較値を0にして決定的失敗にする。
- `C:\Users\rex02\Projects\kintone-sql-tools\src\cli\__tests__\b168_dialect1.e2e.test.ts`: `CREATE TEMP TABLE ... AS SELECT`と後続ASSERTのdialect 1 E2E例。
- `C:\Users\rex02\Projects\kintone-sql-tools\src\__tests__\b105UnionCountTotalCount.test.ts`: 複数アプリの`COUNT(*) ... UNION ALL`実装例。

これらは文法根拠の机上確認です。実kSQL-Flowの`validate`と本実行結果は、実行担当者のゲート結果として別途保存してください。

## 本番パイロットからのログ分離(2026-08-31)

E2E(4257/4258)のJOBログは専用アプリ4264へ分離済みで、kSQL-Flowの`e2e`プロファイルを使用します。本番パイロット(4261/4262、月次案件集計バッチ)が使用する本番JOBログアプリ4249には、E2Eから書込みも読取りも行いません。`KSQL_E2E_LOG_APP_ID=4249`と`KSQL_FLOWNET_PROFILE=prod`はハーネスが起動前に拒否します。

ロック名前空間も`e2e:...`系へ分離されます。`m5_`〜`m8_`のジョブ名プレフィックス規約は、試験レコードの識別と清掃のため引き続き維持します。
