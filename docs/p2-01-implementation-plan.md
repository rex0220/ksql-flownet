# P2-01: アプリ起点リラン 実装計画

- 文書状態: **DRAFT / 仕様レビュー完了・実装未着手**
- 作成日: 2026-08-31
- 対象仕様: [p2-01-app-rerun-spec.md](./p2-01-app-rerun-spec.md)
- 制約: FlowNetのorchestration、`ensure-run`、永続化schemaは変更しない。既存CLIを子プロセスとして呼ぶ外付けポーラーとする

## 1. 結論

P2-01は、次の3点をDRAFT仕様へ反映してから実装に進めば、FlowNetのorchestration/`ensure-run`を変更せず実現できる。

1. 要求の`run_id`から実行対象を解決するため、ポーラーへ**許可ネットワークの`network_id`とnetwork定義パスの対応表**を与える。ポーラーは対応表に含まれるnetworkだけを`status --json`で検索し、対応する定義パスを`run-network`の必須位置引数へ渡す。
2. `run-network`へ後方互換な`--json`出力を追加し、`invocation_id`、aggregate status、Invocation result codeを機械可読で返す。変更はCLI表示境界だけとし、orchestration/`ensure-run`は変更しない。
3. `ACCEPTED`のstale判定を30分固定から、**claim heartbeat + FlowNet側LIVE確認**へ変更する。長時間ノード実行中はstaleへ倒さない。

`RELEASE`は採用を推奨する。停止だけを画面化して解除をSSH専用に残すより運用が閉じ、既存`cancel-run --release`はrevision fencing付きかつ冪等である。ただし、アプリ要求の`RELEASE`はhold解除だけを行い、Runを自動再開しない。

要求アプリは本番用とE2E用を分離する。これは「操作要求アプリを新設する」という仕様と齟齬しない。同一テンプレート・同一schemaから別アプリとして作成し、本番用は受入1〜8の合格後にのみ本番profileへ接続する。

## 2. 仕様レビュー所見

判定は次の意味で用いる。

- **CORRECT**: 正本・既存実装と整合し、そのまま実装可能
- **FLAWED**: 矛盾または安全上の欠陥があり、実装前の修正が必要
- **NEEDS-CLARIFICATION**: 複数の解釈が成立し、受入判定が一意にならない

### 2.1 矛盾・実装不能点

1. **FLAWED — 「未終端」と`FAILED`/activityの関係が矛盾している。**
   - DRAFT §4はRERUN条件を「未終端(`FAILED`集約含む再開可能状態)」としている。
   - 凍結仕様 §7.4 と実装`deriveRunActivity()`は`SUCCESS / FAILED / CANCELLED / UNKNOWN`を終端扱いし、これらへ`activity`を付与しない（`src/orchestration/status.ts:108-110`）。従って、`FAILED` Runについて`activity != LIVE`だけを検査しても、LIVEでないことを積極的には証明できない。
   - 修正案: 「未終端」を受理語彙に使わず、RERUNの許可statusを`CREATED / RUNNING / FAILED / CANCELLED`と明記する。加えて`resume_allowed = true`、`lifecycle_status = ACTIVE`、holdなし、live ownerなしを要求する。`SUCCESS`と`UNKNOWN`は拒否する。`--rerun-from`の対象集合に関するUNKNOWN・非冪等・SUCCESS Run拒否は既存CLIへ委ねる。

2. **FLAWED — `status --json`の契約は対象Runを見つけた後の審査には足りるが、`run_id`だけから対象を発見できない。**
   - 現行statusは`status <network_id> --profile <profile> --run-id <run_id> --json`であり、`network_id`とprofileが必須である（`src/cli/status-command.ts:72-116`）。要求アプリには`run_id`しかない。
   - 詳細JSONはRun status、`resume_allowed`、`lifecycle_status`、activity、Invocation IDs、Network lockを返すため、対象発見後の一次審査には利用できる。
   - 修正案: 非秘密のポーラー設定に、対象profileと`network_id -> network定義パス`のallowlistを持たせる。全allowlistをstatus検索し、0件は`RUN_NOT_FOUND`、2件以上は`RUN_ID_AMBIGUOUS`としてfail-closedにする。要求者に`network_id`を手入力させない。

3. **FLAWED — DRAFT記載の子プロセス引数では`run-network`を起動できない。**
   - DRAFT §4は`run-network --resume-run <run_id>`としているが、現行CLIは先頭に`<network>`パスを必須とする（`src/cli/run-network-command.ts:149-150`、`src/orchestration/ensure-run.ts:100-107`）。
   - 修正案: `run-network <allowlistで解決したnetwork定義パス> --resume-run <run_id> [--rerun-from <node_id>]`とする。現在の作業ツリーの定義はRun identity検証にだけ使われ、実行は既存どおり保存済みbundleから行われる。

4. **FLAWED — `result_message`へ記録するとしたInvocation IDを現行child出力から取得できない。**
   - 現行`run-network`の標準出力はRun ID、aggregate、result codeだけで、Invocation IDを含まない（`src/cli/run-network-command.ts:95-102`）。status差分からの推定は別起動との競合で一意性を保証できない。
   - 修正案: `run-network --json`をCLI表示境界へ追加する。少なくとも`outcome`、`run_id`、`invocation_id`、`aggregate_status`、`invocation_result_code`を返す。NO-OPは`invocation_id = null`とする。既存text出力とexit codeは維持する。

5. **FLAWED — `ACCEPTED`から30分固定でSTALEへ倒す規則は、ノード実行時間と整合しない。**
   - FlowNetは実行中subprocessを完走まで待ち、ノードごとの`batch_timeout_sec`は設定可能である。Network全体は複数ノードの直列実行なので、総所要時間は単一ノードtimeoutより長く、上限がない場合もある。
   - 旧ポーラーは単一batchを対象とし、確保期限を`batchTimeoutSec + claimGraceSec`としていた（`my-ksql-jobs/docs/poll_control_setup.md:38-39,121-123`）。この30分への短縮は旧資産の踏襲になっていない。
   - 修正案: 要求アプリへ`claim_heartbeat_at`を追加し、child実行中にポーラー親が定期更新する。stale回収は「heartbeatが既定15分+ kintone DATETIME分精度上限60秒を超過」かつ「status詳細JSONで当該Runのlive ownerを確認できない」場合だけ行う。閾値はポーリング間隔5分の3回分を既定とし、設定可能にする。status取得不能時は何も更新しない。STALEは実行結果不明を意味し、自動再実行しない。

6. **FLAWED — childのExit≠0をすべて`REJECTED`とすると、「要求拒否」と「受理後にジョブが失敗」を区別できない。**
   - 現行`run-network`はRunを実際にresumeしても最終aggregateがSUCCESS以外ならExit 1を返す（`src/cli/run-network-command.ts:95-102`）。
   - 修正案: `REJECTED`は事前審査拒否、spawn不能、Invocation作成前のCLI検証拒否に限定する。`invocation_id`が作られた後は、aggregateがFAILED等でも要求自体は`DONE`とし、`result_code`へInvocation result code、`result_message`へaggregateを記録する。これを判別するためにも前項のJSON出力が必要である。

7. **NEEDS-CLARIFICATION — RERUNの固定受理範囲をstatus値で確定する必要がある。**
   - バックログは「冪等FAILED/BLOCKEDの再開」を記す一方、DRAFT受入5はRELEASE後の後続RERUNを要求する。停止後のRunはNode Stateを変えないため、aggregateが`RUNNING`または`CREATED`のままになり得る。
   - 本計画では、既存CLIが安全に扱える範囲のうち`CREATED / RUNNING / FAILED / CANCELLED`を許可し、`UNKNOWN / SUCCESS`を拒否する。さらにLIVE/hold/archived/resume禁止を拒否する。より狭く`FAILED`だけにする場合、受入5はCLI/SSH再開へ変更が必要になる。

8. **NEEDS-CLARIFICATION — `rerun_from_node`未指定の通常resumeにも連続失敗ブレーキが効く。**
   - 凍結仕様 §5.3では同一failure_kindの連続FAILED 3回で通常resumeを抑止し、解除は`--rerun-from`だけである（`docs/job-network-phase1-spec.md:344`）。
   - DRAFTの「RERUN受理」は、要求を実行した結果、ブレーキ対象ノードを除外して非SUCCESSで終わる場合を含む。本計画ではCLI結果を`DONE / RETRY_BRAKE`として記録し、「要求拒否」にはしない。受入へブレーキ作動と`rerun_from_node`解除のケースを追加する。

9. **NEEDS-CLARIFICATION — `requested_by`の区切り規則が未定義である。**
   - 固定形式`app-request:<record_id>:<作成者ログイン名>`は、作成者コードに`:`または`%`が含まれると曖昧になる。
   - 修正案: record IDは10進文字列、作成者ログイン名はUTF-8をpercent-encodeして格納する。表示名ではなく偽装不能なkintoneシステムフィールドのログイン名/コードを使い、最大長超過は実行せず拒否する。

10. **FLAWED — 結果書き戻し不能時の意味が不足している。**
    - child実行後にポーラーが死亡すると、要求は`ACCEPTED`のままでもRunは実行済みになり得る。stale回収後の再要求は二重実行リスクをCLI側排他だけでは完全に除けない。
    - 修正案: `REJECTED(STALE)`の表示文言を「要求の実行有無/結果を確定不能。Run/監査を照合するまで再要求禁止」と固定し、受入7で実行済み・未実行の両方を模擬する。ポーラーはstale要求を自動再実行しない。

### 2.2 RELEASE採否

11. **CORRECT（条件付き採用推奨） — RELEASEは既存安全モデルの外側へ権限を広げない。**
    - `cancel-run --release`は既存の同一`CANCEL_REQUEST`をrevision fencing付きで`RELEASED`へ更新し、Run自体を起動しない（`src/orchestration/cancel-request.ts:35-50`）。
    - statusの`STOPPED`は、未終端Runに`REQUESTED / ACCEPTED`のholdがある場合だけ導出される。現行`cancel-run`は終端Runへの新規STOPを拒否するため、RELEASE一次審査は`activity = STOPPED`を根拠にできる。
    - 採用条件: RELEASE完了後も自動RERUNしない、理由必須、要求者相関を残す、同時解除競合はCLIのrevision fencingへ委ねる。holdがない要求は`REJECTED / RUN_NOT_ON_HOLD`とする。
    - RELEASEを今回見送る場合は、仕様§3の選択肢、§4の行、受入5を一括で削除し、解除は既存CLI手順へ明記する。

### 2.3 要求アプリとE2Eアプリ

12. **CORRECT — 本番/スパイクの2アプリ体制は仕様と齟齬しない。**
    - 「操作要求アプリ」は論理roleであり、環境ごとに別instanceを持てる。本番要求と破壊的な競合・stale試験を同一アプリで混ぜない方が安全である。
    - 同一の`templates/create-flownet-request-app.console.js`を、アプリ名prefix/用途だけ変えて使用する。schema差分を作らない。
    - E2E用app ID/tokenは試験環境変数だけに置き、本番`.ksql-flownet.env`へ混在させない。E2E清掃用tokenだけに削除権限を与え、本番ポーラーtokenは追加・削除権限なしとする。
    - 受入前にテンプレート生成結果のフィールド型、選択肢、初期値、一覧、権限手順がE2Eアプリと一致することを検査する。

### 2.4 不足している受入条件

13. **FLAWED — 仕様§7の1〜8だけでは次の重要境界が未検証である。** 実機E2Eまたは単体/統合試験へ以下を追加する。
    1. `resume_allowed = false`、`lifecycle_status = ARCHIVED`、`UNKNOWN`、`CANCELLED`の各RERUN判定。
    2. allowlist外Run、同じrun_idが複数allowlistで見つかる異常、network定義パス不在/不一致。
    3. `rerun_from_node`が不存在、対象内UNKNOWN、実行済み非冪等、RETRY_BRAKE解除。
    4. child spawn失敗、CLI検証失敗、Invocation作成後のaggregate FAILEDを別状態として記録できること。
    5. child実行が30分を超えてもheartbeat中はSTALEにならず、heartbeat停止かつ非LIVEのときだけSTALEになること。
    6. child完了後の結果PUT失敗、revision競合後の再GET+1回再適用、再適用も失敗した場合の終了動作。
    7. 不正な`request_type`、RERUN以外の`rerun_from_node`、空/空白reason、過長run_id/creator/result、stderr/stdout上限。
    8. RELEASEがRunを起動せず、holdなしでは拒否され、RELEASE後のRERUNが別要求としてのみ起動すること。
    9. 1回の取得上限、作成日時同値時のrecord IDによる安定順序、複数要求の逐次処理。
    10. tokenやreason本文がログ、result_message、例外へ漏れず、一時reasonファイルが必ず削除されること。

### 2.5 実装不能点と本体変更の要否

14. **現行DRAFTのまま実装不能な点は3件ある。**
    1. network定義パスがないため`run-network`を起動できない。
    2. child出力にInvocation IDがないため、仕様どおりの結果相関を書けない。
    3. 30分固定staleでは、長時間実行とポーラー死亡を安全に区別できない。

15. **FlowNet orchestration本体の変更が必要な点: なし。**
    - 1はポーラーのallowlist設定、3は要求アプリ側heartbeatで解決する。
    - 2は`src/cli/run-network-command.ts`の出力境界へ`--json`を加える必要があるが、`src/orchestration/ensure-run.ts`、schedulerの状態遷移・書込・判定ロジック、永続化model/schemaの変更は不要である。本計画ではこれを「既存CLI境界の後方互換拡張」として本体改修から分離する。
    - 実機E2E 02で検出したRETRY_BRAKE報告漏れへの対応として、scheduler summaryへ`retryBrakeNodeIds`を追加する。これは既存判定材料を外部へ返す読み取り専用の報告拡張であり、状態遷移・書込・判定ロジックには触れないため、本体無改修原則から`run-network --json`と同じ扱いで明示的に分離する。
    - CLI境界も「本体無改修」に含める判断の場合は、Invocation ID記録要件を削る必要がある。status前後差分による推定は採用しない。

## 3. 実装前に確定する仕様差分

実装着手条件として、DRAFT仕様へ次を反映しレビュー承認する。

| ID | 確定事項 | 本計画の推奨値 |
| --- | --- | --- |
| G-01 | RERUN許可status | `CREATED / RUNNING / FAILED / CANCELLED`。`SUCCESS / UNKNOWN`は拒否 |
| G-02 | LIVE除外 | activityだけでなく、詳細statusのlock ownerが当該RunのInvocationに属しleaseが生存していれば拒否 |
| G-03 | 対象解決 | 非秘密allowlistの`network_id -> network定義パス`。0件/複数件は拒否 |
| G-04 | child結果契約 | `run-network --json`を追加。Invocation作成前拒否と作成後失敗を区別 |
| G-05 | stale | `claim_heartbeat_at`、既定15分+分精度余裕60秒、かつ非LIVEでのみSTALE |
| G-06 | RELEASE | 採用。解除だけを行い自動resumeしない |
| G-07 | 要求結果 | Invocation作成済みはaggregate非SUCCESSでも`DONE`、作成前拒否は`REJECTED` |
| G-08 | 要求者形式 | creator login/codeをpercent-encodeした固定形式 |

## 4. 実装方針

### 4.1 処理フロー

1. `REQUESTED`を`作成日時 asc, $id asc`で上限付き取得する。GET失敗時は書込みもchild起動もせず非0終了する。
2. レコード型・必須値・操作別フィールドを検証する。不正要求はrevision指定で直接`REJECTED`へ更新する。
3. `$revision`を使い`ACCEPTED`へclaimし、`claimed_at`、`claim_heartbeat_at`、`claimed_host`を記録する。revision競合は他ポーラーのclaimとしてスキップする。
4. allowlistの各networkへstatus childを実行し、run_idを一意に解決する。詳細JSONからstatus、lifecycle、resume可否、activity、lock、Invocation ID集合を審査する。
5. reasonを権限制限した一時ファイルへ書き、shellを介さないargv配列で`run-network`または`cancel-run`を起動する。childには親環境を継承し、`KSQL_FLOWNET_REQUESTED_BY`だけを要求相関値で上書きする。
6. child実行中はclaim heartbeatを更新する。heartbeat更新失敗だけでchildをkillせず、ログへ固定codeを残す。
7. 機械可読結果とexit codeを分類し、`DONE`または`REJECTED`へ更新する。結果PUTのrevision競合は再GET後1回だけ再適用する。
8. 一時ファイルを`finally`で削除し、次要求へ進む。1プロセス内では逐次実行する。
9. 各起動の先頭でstale候補を別取得し、statusでLIVEでないことを確認できた要求だけ`REJECTED / STALE`へ倒す。自動再claim・自動再実行はしない。

### 4.2 status --jsonで使える範囲

現行契約で次を判定できる。

| 判定 | JSON要素 | 判定方法 |
| --- | --- | --- |
| Run存在・所属 | `network_id`, `profile`, `runs[0].run_id` | allowlistごとに詳細statusを呼び一意一致を要求 |
| 再開可能性 | `status`, `resume_allowed`, `lifecycle_status` | G-01とactive/resumable条件を適用 |
| 未終端Runのactivity | `runs[0].activity` | `LIVE / IDLE / INTERRUPTED / STOPPED`。終端ではキー自体がない |
| 終端を含むlive owner | `lock.owner_invocation_id`, `lock.lease_expires_at`, `runs[0].invocations[].invocation_id` | owner所属とlease生存を保守側60秒込みで照合 |
| hold | 未終端Runの`activity = STOPPED` | STOP拒否/RELEASE受理/RERUN拒否に使用 |

従って、activity単独では全RunのLIVE判定に使わない。終端Runにはactivityが付かないという凍結契約を変更せず、既存JSON内のlock/Invocation関係を補助判定に使う。

## 5. マイルストーン

### M0: 仕様差分の確定 — S

**目的**: G-01〜G-08をDRAFT仕様へ反映し、実装・受入の判定を一意にする。

変更ファイル:

- `docs/p2-01-app-rerun-spec.md`
- `docs/p2-01-implementation-plan.md`（承認結果の反映）

試験:

- 文書内の状態値、フィールド、環境変数、受入番号の相互参照確認
- 凍結仕様 §5.3、§7.2、§7.4、§8を変更していないことのdiffレビュー

順序制約: **M0完了前にコード実装へ進まない。** とくにG-01、G-05、G-07は実装構造とE2E期待値を変える。

### M1: 要求アプリテンプレート・設定・要求ストア — M

**目的**: 本番/E2E共通schemaと、revision fencing付き要求I/Oを作る。

新規ファイル（想定）:

- `templates/create-flownet-request-app.console.js`
- `src/requests/request-model.ts`
- `src/requests/kintone-request-store.ts`
- `src/requests/poll-requests-config.ts`
- `tests/unit/request-store.test.mjs`
- `tests/unit/poll-requests-config.test.mjs`
- `tests/unit/request-template.test.mjs`

変更ファイル:

- `templates/README.md`: 3アプリ目のrole、フィールド/一覧、ユーザー権限、ポーラーtoken権限、本番/E2E分離
- `.env.example`: request app ID/tokenの**変数名だけ**、allowlist設定パス、heartbeat/stale既定値
- `src/persistence/kintone/client.ts`: 必要な場合のみ、query pagingやsystem fieldを保持する汎用read/update機能を後方互換追加

単体テスト:

- テンプレートに全フィールド、dropdown値、`REQUESTED`初期値、一覧2件がある
- `$id / $revision / 作成者 / 作成日時`のparse
- `REQUESTED`取得の安定順序と上限
- revision付きclaim、競合skip、結果再GET+1回再適用
- 不正field組合せ、空reason、過長値、未知選択肢のfail-closed
- configの重複network、相対/不存在パス、allowlist外を拒否

受入対応: 受入6のclaim基盤、受入8のGET失敗基盤。実機合否はM3。

### M2: CLI結果境界とpoll-requests本体 — L

**目的**: status一次審査、child起動、heartbeat、結果分類を実装する。

新規ファイル（想定）:

- `src/cli/poll-requests-command.ts`
- `src/requests/request-poller.ts`
- `src/requests/flownet-child-client.ts`
- `src/requests/request-result.ts`
- `tests/unit/poll-requests.test.mjs`
- `tests/unit/flownet-child-client.test.mjs`

変更ファイル:

- `src/cli/index.ts`: helpと`poll-requests`dispatch
- `src/cli/run-network-command.ts`: 後方互換な`--json`結果（orchestration変更なし）
- `tests/unit/cli.test.mjs`: 新command dispatch/help、run-network text/JSON互換
- `package.json`: 必要なtest対象追加のみ

単体テスト:

- status JSONの0件/1件/複数件解決、終端activity欠落、live owner、STOPPED、lease分精度境界
- RERUN/STOP/RELEASEの全許可・拒否matrix
- `--rerun-from`のargv伝播とshellを介さないこと
- `KSQL_FLOWNET_REQUESTED_BY`上書き、他の環境継承、creator encode
- JSON結果のInvocation作成前拒否/作成後FAILED/DONE分類
- heartbeat継続中は長時間childをSTALEにしない
- 親死亡相当のheartbeat停止、LIVEなら保留、非LIVEならSTALE
- stdout/stderrの長さ上限、秘密らしい環境値を出力しない、reason一時ファイルの必須削除
- 1件ずつ逐次実行し、claim競合した要求を起動しない

受入対応: 受入1〜8のロジックを単体で満たし、不足受入13.1〜13.10を自動化する。実機合否はM3。

### M3: E2E用要求アプリと実機受入 — L

**目的**: 本番アプリを汚さず、kintone revision競合、権限、実child境界を含めて受入する。

新規ファイル（想定）:

- `tests/e2e/p2-01-support.mjs`
- `tests/e2e/p2-01-01-rerun.mjs`
- `tests/e2e/p2-01-02-rerun-from.mjs`
- `tests/e2e/p2-01-03-rejections.mjs`
- `tests/e2e/p2-01-04-stop-release.mjs`
- `tests/e2e/p2-01-05-claim-stale.mjs`
- `tests/e2e/p2-01-06-get-failclosed.mjs`
- `docs/test-results/p2-01-<実施日>/README.md`および機械可読結果

変更ファイル:

- `tests/e2e/README.md`: E2E要求アプリ、専用環境変数、prefix限定清掃、実行順
- `tests/e2e/setup-env.ps1`: 値ではなく必要変数名と事前確認
- 必要に応じて`tests/e2e/fixtures/`へ長時間/失敗/冪等ネットワークfixtureを追加

環境分離:

- E2Eアプリ名は例として`kSQL-FlowNet 操作要求 P2-01 E2E`とし、本番要求アプリと別IDにする。
- E2Eレコードの識別可能な値は`KSQL_FLOW_TEST_` prefixに限定する。
- E2E清掃は専用tokenでprefix一致レコードだけを対象とし、ポーラーtokenへ削除権限を与えない。
- 本番要求アプリ/tokenをE2Eコマンドが受理した場合はpreflightで停止する。

受入1〜8の対応:

| 受入 | E2E | 主担当マイルストーン |
| --- | --- | --- |
| 1. RERUN完走、DONE、requested_by相関 | `p2-01-01-rerun` | M2実装 / M3合格 |
| 2. rerun-fromが冪等ノードへ効く | `p2-01-02-rerun-from` | M2 / M3 |
| 3. 不在/SUCCESS/LIVE/hold拒否・状態不変 | `p2-01-03-rejections` | M2 / M3 |
| 4. STOP、次ノード境界、要求DONE | `p2-01-04-stop-release` | M2 / M3 |
| 5. RELEASE、hold解除、別RERUN要求 | `p2-01-04-stop-release` | M2 / M3 |
| 6. 同時claimで一方だけ実行 | `p2-01-05-claim-stale` | M1/M2 / M3 |
| 7. staleはREJECTED、再実行なし | `p2-01-05-claim-stale` | M2 / M3 |
| 8. GET失敗時に書込・child起動なし | `p2-01-06-get-failclosed` | M1/M2 / M3 |

合格条件:

- 仕様§7の1〜8と本計画§2.4の追加条件がすべて合格する。
- 監査4262、Run/Invocation/Node State、要求アプリの3面で同じ結果を照合する。
- 静的/単体試験だけを実機合格の代用にしない。
- 証跡へtoken、reasonの機微情報、環境ファイル内容を保存しない。

### M4: 運用文書・本番接続準備 — M

**目的**: cron、本番権限、一次対応を安全に引き渡す。本番profileへの接続はM3合格後に行う。

変更ファイル:

- `README.md`: command概要と設定入口
- `docs/README.md`: P2-01仕様・計画・E2E証跡への索引
- `docs/runbook-phase1-recovery.md`: アプリRERUN、RETRY_BRAKE、STALE照合、SSHへ上げる条件
- `docs/ops-first-response.md`: RERUN/STOP/RELEASE、次ノード境界、再要求禁止条件
- `templates/README.md`: 本番作成・ACL・token権限・一覧/リマインダー
- `.env.example`: request appとpoller設定の変数名
- `C:/Users/rex02/Projects/my-ksql-jobs`側は別依頼/別変更として、`.ksql-flownet.env`読込後の`*/5` cron行と運用確認を追加する

検証:

- `poll-requests --check`相当のread-only preflight、または本番cron投入前の設定検査
- 無効token、allowlist不一致、network定義不在でchildを起動しない
- cron重複起動時もrevision fencingで二重実行しない
- 本番tokenに要求レコード追加/削除権限がないことを人手確認
- メンテ時GET失敗は無変更、claim後メンテはheartbeat/STALE規則へ収束することをrunbookで確認

受入対応: 受入8の運用化、受入7の人手照合、受入1/4/5の一次対応手順。本番接続の最終gateを担当する。

## 6. リスクと軽減策

| ID | リスク | 影響 | 軽減策 |
| --- | --- | --- | --- |
| R-01 | statusとchild起動の間のTOCTOU | 一次審査後に別Invocationが開始 | 一次審査は案内用とし、正の排他/検証は既存run-network/cancel-runへ委ねる。lock競合は安全な拒否 |
| R-02 | terminal Runにactivityがない | LIVEを見落とす短い窓 | lock ownerとRunのInvocation IDsを別途照合し、lease判定へ60秒余裕を加える |
| R-03 | 長時間Network実行 | 30分STALE誤判定 | claim heartbeat + 非LIVE確認。固定実行時間だけでは判定しない |
| R-04 | 親死亡後にchildだけ継続 | 要求状態とRun実態が乖離 | LIVE中はSTALE化せず、停止後は結果不明STALEとして人手照合。自動再実行なし |
| R-05 | 結果PUT応答消失 | DONE済みか不明 | 再GETし、既に同じ終端値なら成功扱い。異なるrevisionは1回だけ再適用後停止 |
| R-06 | allowlist/定義パスdrift | statusは一致するがrun-network identity拒否 | startup preflightで全定義をvalidateしnetwork_id一致を確認。CLIのsnapshot/identity検証を正とする |
| R-07 | child出力形式drift | 誤分類または結果欠損 | JSON schema/versionを固定し、未知version/欠損はfail-closed。textをparseしない |
| R-08 | 同一networkへの複数要求 | lock競合で後続要求が拒否 | 1ポーラー内は逐次。複数ポーラー間はclaim fencing。lock競合結果は明示し、暗黙retryしない |
| R-09 | kintone DATETIME分精度 | heartbeat/stale境界の早期判定 | 60秒の保守余裕と共有clock fixtureを使用。境界値を単体/実機で検査 |
| R-10 | result_messageへの情報漏えい | token/業務情報露出 | 固定code中心、stdout/stderrは長さ制限と要約、環境/token/reason本文を保存しない |
| R-11 | 本番/E2E app取り違え | 本番要求の誤処理・削除 | app ID分離、用途markerのpreflight、E2E prefix限定、削除token分離 |
| R-12 | RELEASEによる意図しない再開 | hold解除直後の自動起動 | RELEASE自身は起動しない。ただし既存cron `--resume`が次回起動し得ることを画面・手順へ明記する |

## 7. 順序制約とリリースgate

1. M0でG-01〜G-08を確定する。
2. M1のschemaを確定してからE2Eアプリを作る。後からfieldを足して本番/E2E差分を作らない。
3. M2の`run-network --json`契約を先に固定し、その契約に対してpoller結果分類を実装する。
4. M2単体試験完了後にM3の実child E2Eへ進む。
5. M3合格前は本番要求アプリID/tokenを本番profileへ設定しない。
6. M4の権限確認、allowlist preflight、cron dry-run後にだけ本番cronを有効化する。
7. 初回本番はRERUN 1件を有人監視し、要求・監査4262・Run Invocationの相関を照合する。STOP/RELEASEは別の安全な試験Runで確認する。

## 8. 見積りまとめ

| マイルストーン | 規模 | 主な不確実性 |
| --- | --- | --- |
| M0 仕様差分確定 | S | RERUN status集合とDONE/REJECTED意味論の承認 |
| M1 テンプレート・設定・要求ストア | M | kintone system field/ACL、paging、revision競合 |
| M2 CLI結果境界・poller本体 | L | 長時間child heartbeat、結果分類、status/起動間競合 |
| M3 E2E用アプリ・実機受入 | L | 長時間/死亡/同時claimの再現、実機清掃と証跡 |
| M4 運用文書・本番接続準備 | M | 配備環境のcron、権限、allowlist実値の確認 |

全体規模は**L**。実装量そのものより、長時間実行・親死亡・kintoneメンテ・多重ポーラーを「自動再実行しない」側へ確実に収束させる試験が支配的である。

## 9. 非対象

- `src/orchestration/ensure-run.ts`、`src/orchestration/sequential-scheduler.ts`、Network lock、Node lock、永続化schemaの変更
- 実行中SQLのkill（STOPは凍結仕様どおり次ノード境界）
- UNKNOWN解決、非冪等ノードの承認、~~correction Run作成のアプリ化~~(**2026-09-02改訂D-1**: correction Runを含む新規STARTのアプリ化は[P2-11](./p2-11-adhoc-start-spec.md)で正式採用し、本項の非対象指定を撤回。冪等networkかつallowlist `app_start: true`明示のみが対象)
- 通知連携、常駐daemon、分散worker/lease一般化
- token値、接続秘密、実app IDのリポジトリ記載
