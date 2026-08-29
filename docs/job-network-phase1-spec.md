# kSQL-FlowNet ジョブネット管理仕様書

## Phase 1 推奨仕様案（設計凍結候補）

- 文書状態: **設計凍結候補**（受入試験の完了前は「凍結版」と呼ばない）
- 対象: ジョブネットの定義、直列実行、再開、監査履歴、排他制御
- 対象外: 並列ワーカー、任意の trigger rule、SQL 文途中からの汎用再開
- 作成日: 2026-08-29

## プロジェクト境界

本機能はkSQL-Flow本体へ内蔵せず、独立したControl Plane製品kSQL-FlowNet（リポジトリ`ksql-flownet`）として実装する。

- kSQL-FlowはSQL実行、kintone API、APIリトライ、チャンク処理、単一ジョブのロックと実行結果を担当する。
- kSQL-FlowNetはDAG、Network Run、snapshot、ensure-run、Networkロック、Node State／Attempt、UNKNOWN解決を担当する。
- Phase 1の呼出境界はライブラリimportではなく、`kSQL-Flow Execution Contract v1`に従うCLI subprocessとする。
- 新オーケストレータは`ksql-flow run-all`を呼ばず、各ノードについて`ksql-flow run`を呼び出す。
- 現行`run-all`は小規模・ローカル向けの軽量バッチ機能として維持し、エンタープライズ向けの状態モデルを追加しない。
- Phase 1で実装するexecutorは`ksql-flow`だけとし、任意CLI、HTTP、Python等は後続Phaseへ送る。

詳細は[プロジェクト分離ADR](./architecture-separation-adr.md)と[Execution Contract v1](./execution-contract-v1.md)を参照する。

## 基本方針

本仕様は、**「しくみはシンプルにして、リカバリー方法を明確にする」**ことを最優先とする。正常系の自動化だけでなく、障害時に「どこまで実行されたか」「何を再実行してよいか」「誰が何を確認すべきか」を一意に判断できる設計を目指す。

- **安全側に停止する**: 実行結果、ロック、snapshot、依存状態を確定できない場合は推測で続行せず、`UNKNOWN` またはエラーとして停止する。
- **業務単位を壊さない**: resume は新しい業務実行を作らず、同じ Network Run を継続する。プロセスの再起動履歴は別に記録する。
- **現在状態と監査履歴を分ける**: 状態確認用の可変レコードと、物理実行ごとに追加する履歴レコードを分離し、終端確定済みの過去Attemptを上書きしない。
- **同じ入力で再開する**: DAG、SQL 本文、as-of、実行に影響する非秘密設定を固定し、resume 時に現在の作業ツリーへすり替わらないようにする。
- **冪等性を自動復旧の前提とする**: 非冪等処理や結果不明の処理を汎用 CLI で自動リランしない。旧保持者の停止確認、突合、補償を先に行う。
- **既存機能の保証範囲を超えて主張しない**: 時限ロックを完全な mutex、診断用チャンク情報を途中再開カーソルとして扱わず、実装済み・設計提案・将来拡張を区別する。
- **Phase 1 は最小の閉じたコアにする**: 直列 DAG、`all_success`、同一 Run の resume、監査、排他に限定し、並列化や高度な trigger rule は後続 Phase に分離する。

## Phase別概要

全体ロードマップは次のとおりとする。**本書で設計凍結の対象とするのは Phase 1 だけ**であり、Phase 2 以降は方向性を示すものである。各Phaseは、直前Phaseの受入基準を満たし、永続スキーマと安全条件への影響を別仕様で確認してから開始する。

| Phase | テーマ | 主な内容 | 到達点 |
| --- | --- | --- | --- |
| **Phase 0** | 導入準備と互換性確立 | 現行 `run-all` / ログアプリ / `TIMEOUT` / `NO_DATA` / `ABORTED` から新モデルへの対応付け、ロックキー規則、kintoneアプリ構成、実行バンドル保存方式、同時ロック競合の実機検証 | Phase 1を既存運用へ安全に導入できる |
| **Phase 1** | 信頼できる直列ジョブネット | DAG定義・循環検証、安定トポロジカル直列実行、同一 Network Run の resume、4層の監査モデル、不変snapshot、`UNKNOWN`、`idempotent`、`all_success`、Network/Nodeロック | 障害後も「どこから安全に再開するか」を一意に判断できる |
| **Phase 2** | DAG表現力と制御された並列化 | `none_failed` / `all_done`、条件分岐、ノード単位のリトライポリシー、同時実行数・リソースプール、独立ノードの並列実行、cancel伝播 | 複雑な業務フローを、依存意味論を崩さず効率的に実行できる |
| **Phase 3** | 精密な途中再開と分散実行 | 文・チャンク単位の再開契約、単調カーソル、チェックポイント整合性、分散ワーカー、claim/lease、重複配送を前提とした実行、ワーカー障害からの回復 | 大規模処理をノード全体の再実行なしで安全に継続できる |
| **Phase 4** | エンタープライズ運用 | RBAC、承認付き復旧、監査エクスポート、保持・削除ポリシー、可観測性、SLO、管理API/UI、バックアップ・災害復旧、複数環境への昇格管理 | 組織的な統制、監査、長期運用に耐える製品運用ができる |

### Phase 0: 導入準備と互換性確立

Phase 0 は新しいジョブネット機能そのものではなく、Phase 1を安全に実装するための事前作業である。

- 既存の BATCH/JOB ログと、新しい Network Run / Run Invocation / Node State / Node Attempt の移行表を確定する。
- `TIMEOUT` を発生源で分け、ランナー自身が検知した実行timeoutは `FAILED + EXECUTION_TIMEOUT`、別実行によるstale回収は `UNKNOWN + LEASE_EXPIRED` とする移行規則を確定する。
- `NO_DATA` と `ABORTED` を `status` と `result_code` に分離する規則を確定する。
- `__net__` の予約、ロックキー長、Nodeロックと単体実行の競合規則を確定する。
- 実行バンドルの添付方式、容量、保持期間、アクセス権、ハッシュ検証を実機確認する。
- kintone の重複禁止制約を使った同時ロック競合を実測し、観測結果と非保証範囲を記録する。

### Phase 1: 信頼できる直列ジョブネット

Phase 1 は、機能数よりも**安全に止まり、安全に再開できる最小コア**を完成させる段階である。

- 1つの業務実行を同じ Network Run として追跡する。
- resumeごとのプロセス起動と、ノードの物理試行を追記履歴として残す。
- DAG、SQL、as-of、実行設定をsnapshotとして固定する。
- `UNKNOWN` と非冪等ノードを自動再実行しない。
- 直列実行と `all_success` に限定し、依存伝播を決定的にする。
- ジョブネット実行と既存の単体ジョブ実行を同じロック体系で排他する。

Phase 1の完了条件は、本書「12. 受入基準」の全項目を満たし、旧保持者停止確認を含む復旧訓練が成功することである。

### Phase 2: DAG表現力と制御された並列化

Phase 2では、Phase 1の状態・監査モデルを変えずに、実行計画の表現力と処理効率を拡張する。

- `none_failed` / `all_done` と条件分岐の厳密な伝播規則を実装する。
- ノード単位の最大試行回数、待機時間、対象エラーを定義する。既存のHTTP/APIリトライと、ワークフロー上のNode Attempt再実行を区別する。
- DAG上で独立したノードだけを並列化する。
- profile、アプリ、API消費量などを共有資源として扱うリソースプールを導入する。
- cancel要求が実行中・待機中・下流ノードへどう伝播するかを定義する。

並列化は逐次実行と同じ最終状態・監査結果になることを受入条件とし、速度だけを完了条件にしない。

### Phase 3: 精密な途中再開と分散実行

Phase 3では、現在は診断情報にすぎないチャンク記録を、条件を満たす処理に限って再開位置として利用できるようにする。

- 安定した全順序、単調カーソル、再読込範囲、重複適用時の意味論を定義する。
- チェックポイント保存と業務書込の間に原子的トランザクションがないことを前提に、安全な再読込区間を設ける。
- SQL文単位・チャンク単位のどちらを再開可能とするかを、操作種別ごとに分類する。
- 分散ワーカーの claim、lease、heartbeat、再配送、重複実行を状態遷移として定義する。
- DELETE、外部API、採番、通知など、再開不能または補償必須の処理を明示的に除外する。

Phase 3を導入しても、条件を満たさないノードは Phase 1のノード全体リランまたは手動復旧へ戻せることを必須とする。

### Phase 4: エンタープライズ運用

Phase 4では、実行エンジンの機能追加よりも、組織的な統制と継続運用を完成させる。

- `UNKNOWN` 解決、非冪等リラン、force-unlock に承認・権限・証跡を要求する。
- Run、Attempt、snapshot、ローカルJSONLの保持・アーカイブ・削除規則を統一する。
- 長時間 `RUNNING`、失敗率、再開回数、処理時間、API消費量を監視し、SLOとアラートを定義する。
- 管理API/UIから、Runの検索、DAG表示、履歴比較、復旧手順の案内を提供する。
- バックアップ、復元、リージョン障害、ログアプリ障害を含む災害復旧訓練を定期化する。
- dev/stg/prod間で同じ定義バンドルを昇格させ、承認済みartifactだけを実行する。

---

## 1. 結論

Phase 1 では、次の設計を採用する。

1. **1つの業務実行を1つの Network Run とし、resume しても同じ Run を継続する。**
2. プロセス起動履歴は `Run Invocation` として別に追記し、業務単位と起動単位を分離する。
3. ノードの現在状態を `Node State`、物理実行ごとに追加する耐久履歴を `Node Attempt` として分離する。
4. 孤児化した実行には `UNKNOWN` を使用し、`FAILED` とみなして自動再実行しない。
5. 各ノードに `idempotent` を必須指定する。ただし、冪等であっても旧実行の停止を確認できない状態で重ねて実行しない。
6. 再開は作業ツリーの SQL ではなく、Network Run 作成時に保存した**不変の実行バンドル**を使用する。
7. 依存判定は `effective_status` ではなく `trigger_rule` で定義する。Phase 1 の実装値は `all_success` だけとする。
8. Network Run ロックと既存のジョブロックを併用し、cron、手動 SSH、GitHub Actions、ポーラー、単体ジョブ実行の競合を同じ排他系で扱う。
9. 現行のチャンク記録は診断情報であり、汎用的な「チャンク途中再開」とは呼ばない。Phase 1 の復旧単位はノード全体の冪等リランである。

この方式では、成功済みノードを新しい Run に複製しない。したがって `REUSE` レコード、`reused_from_run_id`、`reused_from_attempt`、および `execution_action = NONE` は Phase 1 の永続モデルには不要である。成功済みノードを保持した事実は、Run Invocation の `preserved_node_ids` に記録する。

---

## 2. 設計原則

### 2.1 業務単位と起動単位を分ける

| 概念 | 意味 | resume 時 |
| --- | --- | --- |
| `Network Run` | 「2026年8月の月次締め」など、業務として答えを出す単位 | 同じレコードを継続 |
| `Run Invocation` | CLI、cron、Actions 等による1回のプロセス起動 | 毎回新規作成 |
| `Node State` | Run 内の各ノードの現在状態 | 同じレコードを状態遷移 |
| `Node Attempt` | ノードを実際に走らせた1回の物理試行 | 毎回新規作成、上書き禁止 |

`business_key` は任意ではなく、定期業務では必須とする。推奨形式は `monthly_close@2026-08` のような、人が検索・照合できる値である。

定期実行ではシェルの現在時刻からbusiness keyを直接組み立てない。呼出側は`--scheduled-for`でスケジュール対象時刻を渡し、orchestratorがnetwork定義の`business_key_policy`、timezone、期間境界から決定的に生成する。backfillとcorrectionはbusiness keyの明示指定を許可する。

同じ `profile + network_id + business_key` の Run は、完了・未完了を問わず重複作成しない。未完了なら `--resume` または `--resume-run` を案内し、完了済みなら何も実行せず「完了済み」と返す。定義を変更して再度実行する業務上の必要がある場合は、`monthly_close@2026-08-correction-1` のように別の `business_key` を明示する。

### 2.2 状態と履歴を混ぜない

- `Node State` は「今どうなっているか」を高速に参照するための可変レコードである。
- `Node Attempt` は「いつ、どこで、何を実行し、どう終わったか」を試行ごとの独立レコードとして残す。実行開始と終端確定に必要なlifecycleフィールドだけをrevision付きで更新し、終端確定後は変更しない。
- attempt番号は**`ksql-flow run` subprocessを起動したNode実行試行の回数**であり、1から始まる。SQLを開始したかは`execution_started_at`と`runner_execution_started_at`で別に記録する。ロック競合などSQL開始前に確定した試行も監査のため番号を消費する。
- `WAITING`、`BLOCKED`、`SKIPPED`、成功状態の保持だけでは Node Attempt を作らない。
- 失敗した attempt も削除・上書きしない。

### 2.3 不明は失敗ではない

プロセス消失、通信断、リース期限切れなどにより、実行結果を確定できない場合は `UNKNOWN` とする。

`UNKNOWN` は「失敗した」ではなく「完走した可能性と部分適用の可能性を排除できない」を意味する。したがって、後続ノードの依存を満たさず、無条件の自動再実行対象にもならない。

### 2.4 再現性はハッシュ照合だけでなく実体保存で担保する

`sql_sha256` だけでは、元ファイルが失われた場合に再開できない。Network Run 作成時に、DAG 定義、SQL 本文、実行に影響する非秘密設定を1つの実行バンドルとして保存する。

resume は必ず保存済みバンドルから実行し、現在の作業ツリーを参照しない。

---

## 3. 回復モデル

Phase 1 は「3階層の resume」ではなく、次の**2段階の階層型回復**として定義する。

```text
[Level 1: Network Run Resume]
  成功済みノードを保持し、失敗・未着手・依存ブロックのノードから再評価する
             |
             v
[Level 2: Node Replay]
  同じ snapshot / as-of でノード全体を再実行し、Node Attempt を追加する
             |
             v
[Supporting diagnostics: Chunk checkpoint]
  成功チャンク数や last_written_key を障害調査に使う
  ※ 順序保証されたカーソルではなく、汎用的な途中再開位置には使わない
```

Phase 1 で保証するのは、Network Run の継続とノード全体の冪等リランである。SQL 文途中や任意チャンクからの再開を将来実装する場合は、順序、カーソルの単調性、書込の原子性、重複適用時の意味論を別仕様として定義する。

---

## 4. DAG 定義

直列、分岐・合流、複数開始点などの具体例は、[対応可能なジョブネット例](./job-network-examples.md)を参照する。Phase 1ではDAG上の並列候補も安定トポロジカル順で直列実行し、実際の同時実行はPhase 2の対象とする。

### 4.1 例

```yaml
schema_version: 1
network_id: monthly_close
description: 月次締め
business_key_policy:
  type: scheduled_period
  period: month
  timezone: Asia/Tokyo
  format: "{network_id}@{yyyy}-{MM}"
max_active_runs: 1
network_lock:
  lease_duration_sec: 300
  heartbeat_interval_sec: 60
nodes:
  - id: extract_sales
    job_id: extract_sales
    sql: jobs/extract_sales.sql
    depends_on: []
    trigger_rule: all_success
    idempotent: true

  - id: aggregate_customer
    job_id: aggregate_customer
    sql: jobs/aggregate_customer.sql
    depends_on: [extract_sales]
    trigger_rule: all_success
    idempotent: true

  - id: send_invoice
    job_id: send_invoice
    sql: jobs/send_invoice.sql
    depends_on: [aggregate_customer]
    trigger_rule: all_success
    idempotent: false
```

### 4.2 必須検証

実行バンドルを作成する前に、少なくとも次を検証する。

- `network_id` と node `id` が命名規則および長さ制約を満たすこと
- node `id` がネットワーク内で一意であること
- `job_id`が全ノードに明示され、SQLから解決した論理job IDと一致すること
- `depends_on` の参照先が存在し、自己参照がないこと
- Kahn のアルゴリズムで全ノードを取り出せること（循環がないこと）
- SQL ファイルが存在し、読取可能であること
- `idempotent` が全ノードに明示されていること
- `trigger_rule` が Phase 1 では `all_success` であること
- 生成したロックキーが kintone のフィールド制約を満たすこと
- `business_key_policy`のtype、period、timezone、formatと`max_active_runs`が対応値であること
- `network_lock.lease_duration_sec`と`heartbeat_interval_sec`が正の整数で、heartbeatがleaseより短く、推奨上限`lease_duration_sec / 3`以下であること
- `idempotent = true`のSQLに、as-ofで固定されない時刻関数、乱数など明確な非決定要素がないこと。検出時は検証エラーまたは承認済み例外をmanifestへ記録すること

複数のノードが同時に実行可能な場合、Phase 1 は定義順を tie-breaker とする安定トポロジカル順で直列実行する。

### 4.3 `business_key_policy`

Phase 1で受理するtypeは次の2つとする。

| type | 用途 | 必須入力 |
| --- | --- | --- |
| `scheduled_period` | 日次・月次等の定期業務 | `period`、`timezone`、`format`。起動時に`--scheduled-for` |
| `explicit` | 不定期、backfill、correction | 起動時に`--business-key` |

`scheduled_period`の`period`はPhase 1では`day`または`month`とする。formatは許可済みplaceholderだけを使用し、同じ入力から常に同じ文字列を生成する。`max_active_runs`は1以上の整数で、Phase 1の既定値は1とする。active Runは`resume_allowed = true`かつNetwork Run statusが`SUCCESS`以外のRunと定義する。`ARCHIVED`または`resume_allowed = false`のRunはactive数へ含めない。

### 4.4 外部ジョブスケジューラとの責務境界

Phase 1のkSQL-FlowNetは、カレンダースケジュール、cron式の管理、常駐ポーリング、missed runの自動補完を提供しない。cron、Cloud Scheduler、GitHub Actions、Windows Task Scheduler等は、kSQL-FlowNetを起動する外部Triggerとして扱う。

定期実行では、外部スケジューラは対象期間を表す論理予定日時を`--scheduled-for`へ渡す。同一予定実行の再送・リトライでは、最初の起動と同じ値を使用しなければならない。リトライ実行時の現在日時へ置き換えてはならない。

kSQL-FlowNetは`--scheduled-for`、network定義のtimezoneおよび`business_key_policy`からbusiness keyを決定的に生成し、ensure-runとNetworkロックによってNEW／RESUME／NO-OPを判定する。外部スケジューラによる重複起動を、Network Runの重複作成や成功済みNodeの再実行へ変換してはならない。

missed run、catch-up、起動リトライの回数・間隔は外部スケジューラの責務とする。backfillおよびcorrectionは定期実行の暗黙的なcatch-upとして扱わず、`business_key_policy.type = explicit`と`--business-key`を用いた別の業務実行として起動する。

外部ジョブスケジューラは起動時刻を管理する。FlowNet内部のDAG schedulerはNode Stateに基づく依存判定と実行順序だけを担当する。Phase 1は安定トポロジカル順による直列実行とし、独立Nodeの並列実行はPhase 2以降とする。

### 4.5 `network_lock`

Network lockはNode実行timeoutとは独立したrenewable leaseとする。`lease_duration_sec`は旧ownerの停止を証明する値ではなく、heartbeat欠損をstale候補として検出するための期間である。`heartbeat_interval_sec`はleaseより短くし、推奨上限をleaseの3分の1とする。具体的な既定値・最小値・最大値はPhase 0のSpike Fで測定して固定するため、例の値を保証値として扱わない。

FlowNetはkSQL-Flow subprocess実行中もheartbeatを更新する。heartbeat、状態更新、次Node起動は現在の`lease_token`とrevisionの一致を必要とし、回収済みの旧ownerは処理を継続できないものとする。

heartbeatが連続失敗するか残余leaseが安全閾値以下になった場合、Invocationは`LEASE_UNCERTAIN`のdrain modeへ入り、新しいNodeを起動しない。実行中subprocessは原則killせず完走を待つ。期限超過後はtoken一致だけでは状態を更新せず、同じtokenとrevisionによるheartbeat再更新を確認できた場合だけ結果を保存する。保存後は次Nodeへ進まず、Invocationを`CANCELLED / NETWORK_LEASE_INTERRUPTED`で終端する。更新不能またはowner変更時は状態を書かずreconciliationへ送る。

### 4.6 `trigger_rule`

スキーマには将来拡張用のキーを最初から持たせるが、Phase 1 で受理する値は `all_success` のみとする。未実装値を黙って `all_success` として扱ってはならない。

| 値 | 意味 | Phase 1 |
| --- | --- | --- |
| `all_success` | 全上流が `SUCCESS` のときだけ着手 | 実装 |
| `none_failed` | 上流に失敗系がなく、`SKIPPED` を許容 | 予約。指定時は検証エラー |
| `all_done` | 上流がすべて確定した後、成否を問わず着手 | 予約。指定時は検証エラー |

`UNKNOWN` は、将来のどの trigger rule でも自動的に充足扱いにしない。

---

## 5. 状態モデル

### 5.1 Node State `status`

| 値 | 意味 |
| --- | --- |
| `WAITING` | 未着手、または依存ノードの確定待ち |
| `RUNNING` | Node Attempt が実行中 |
| `SUCCESS` | ノードが正常終了。正常な対象0件も `result_code = NO_DATA` を伴う `SUCCESS` とする |
| `FAILED` | 結果が失敗と確定した |
| `BLOCKED` | 依存状態が trigger rule を満たさず実行不能 |
| `SKIPPED` | 将来の条件分岐・明示除外用の予約状態。Phase 1では生成しない |
| `CANCELLED` | 利用者または制御系が停止し、未完了であることが確定した |
| `UNKNOWN` | 実行結果を確定できない。部分適用または完走の可能性が残る |

`BLOCKED` と `SKIPPED` を混同しない。依存元の失敗による未実行は `BLOCKED`である。`SKIPPED`はPhase 1では予約値とし、定義、CLI、移行処理から生成しない。旧データに存在する場合は暗黙に成功扱いせず、移行規則で明示的に解決する。

### 5.2 Node Attempt `status`

| 値 | 意味 |
| --- | --- |
| `RUNNING` | 物理実行中 |
| `SUCCESS` | 正常終了 |
| `FAILED` | 失敗が確定 |
| `CANCELLED` | 停止が確定 |
| `UNKNOWN` | 終了結果を確定不能 |

`NO_DATA`、`ASSERT_FAILED`、`API_ERROR`、`LEASE_EXPIRED`、`LOCK_UNAVAILABLE` などは status を増やさず `result_code` / `failure_kind` / `error_message` で表す。

### 5.3 状態遷移

| 現在 | 事象 | 次状態 | Node Attempt |
| --- | --- | --- | --- |
| なし | Run 作成 | `WAITING` | 作らない |
| `WAITING` | 依存を満たし、実行開始 | `RUNNING` | Node Stateの`latest_attempt_no + 1`で作成 |
| `WAITING` | 依存が不成立で確定 | `BLOCKED` | 作らない |
| `RUNNING` | 正常終了 | `SUCCESS` | 同じ attempt を `SUCCESS` で確定 |
| `RUNNING` | 失敗確定 | `FAILED` | 同じ attempt を `FAILED` で確定 |
| `RUNNING` | 停止確定 | `CANCELLED` | 同じ attempt を `CANCELLED` で確定 |
| `RUNNING` | 結果確認不能 | `UNKNOWN` | 同じ attempt を `UNKNOWN` で確定 |
| `BLOCKED` | resume で再評価対象 | `WAITING` | この時点では作らない |
| `FAILED` / `CANCELLED` | resume かつ `idempotent = true` | `WAITING` | この時点では作らない |
| `FAILED` / `CANCELLED` | `idempotent = false` | 状態維持 | 自動再実行しない |
| `SUCCESS` | 通常 resume | `SUCCESS` のまま | 作らない |
| `SUCCESS` | `--rerun-from` の対象 | `WAITING` | 実行開始時に次 attempt を作る |
| `UNKNOWN` | 運用者が結果を確定 | `SUCCESS` / `FAILED` / `CANCELLED` | Attempt Resolutionイベントを追記 |

非冪等`FAILED`を人手で復旧する場合、元Attemptは変更しない。本来の成果物を手動で完成させた証拠がある場合だけ`NODE_MANUAL_COMPLETION_CONFIRMED`を追記し、Node Stateを`SUCCESS`へ解決できる。部分書込みを取り消しただけの`NODE_COMPENSATION_COMPLETED`は`SUCCESS`を意味せず、下流を開始しない。

確定済みNode Attemptの主要フィールドは上書きしない。`UNKNOWN` の解決は、元Attemptを改変せず、必ず `Attempt Resolution` イベントを追記してNode Stateを更新する。開始・終了時の限定的な更新と二重書込みの照合規則は、Freeze Decision RecordのD-07〜D-09を正とする。

### 5.4 依存判定

`effective_status` は導入しない。Phase 1 の `all_success` は、すべての直接依存ノードの Node State が `SUCCESS` の場合だけ真となる。

| 上流状態 | `all_success` の判定 |
| --- | --- |
| すべて `SUCCESS` | 着手可能 |
| 1件以上が `WAITING` / `RUNNING` | 待機 |
| 1件以上が `FAILED` / `BLOCKED` / `CANCELLED` / `UNKNOWN` | `BLOCKED` |

依存元の状態が後で resume により変化した場合、`BLOCKED` ノードを `WAITING` に戻して再評価する。

---

## 6. 永続データモデル

### 6.1 Network Run

```json
{
  "run_id": "netrun_20260829_001",
  "network_id": "monthly_close",
  "business_key": "monthly_close@2026-08",
  "max_active_runs": 1,
  "status": "FAILED",
  "as_of": "2026-08-01T00:00:00+09:00",
  "definition_schema_version": 1,
  "definition_sha256": "sha256:...",
  "source_bundle_sha256": "sha256:...",
  "source_bundle_attachment": "monthly_close_netrun_20260829_001.zip",
  "resolved_profile_snapshot": {
    "profile": "prod",
    "base_url": "https://example.cybozu.com",
    "guest_space_id": null,
    "timezone": "Asia/Tokyo",
    "apps": {
      "受注": 100,
      "顧客マスタ": 200
    },
    "limits": {
      "max_api_calls": 5000,
      "max_read_rows": 200000,
      "batch_timeout_sec": 3600
    }
  },
  "resolved_profile_sha256": "sha256:...",
  "ksql_flow_version": "0.x.y",
  "engine_version": "3.x.y",
  "dialect": 1,
  "created_at": "2026-08-29T08:00:00Z",
  "started_at": "2026-08-29T08:00:01Z",
  "finished_at": null,
  "updated_at": "2026-08-29T08:05:00Z"
}
```

認証トークン、パスワード、秘密鍵はsnapshotに含めない。resolved profileは`ksql-flow describe-profile --profile <name> --config <path> --json`の出力から作成する。resume時も同じコマンドで現在値を取得し、接続先URL、guest space、アプリID、timezoneとhashがsnapshotに一致することを検証する。不一致時は実行せず、新しいRunの作成を要求する。orchestratorがkSQL-Flowのconfig形式を独自に解釈してはならない。

### 6.2 Run Invocation

```json
{
  "invocation_id": "invoke_20260829_002",
  "run_id": "netrun_20260829_001",
  "mode": "RESUME",
  "requested_by": "cron",
  "host": "vps:prod-01",
  "started_at": "2026-08-29T09:00:00Z",
  "finished_at": "2026-08-29T09:02:30Z",
  "status": "SUCCESS",
  "result_code": "OK",
  "selected_node_ids": ["aggregate_customer", "close_month"],
  "preserved_node_ids": ["extract_sales"],
  "blocked_node_ids": [],
  "reason": "resume latest incomplete run"
}
```

`mode` は `NEW` / `RESUME` / `RERUN_FROM` とする。成功済みノードを保持した履歴は `preserved_node_ids` に残るため、Node State を `REUSE` で上書きしない。

heartbeat障害からdrainしたInvocationは、Network leaseの再更新後に`status = CANCELLED`、`result_code = NETWORK_LEASE_INTERRUPTED`で終端する。leaseを再確認できない場合はInvocation自身を更新せず、次回起動のreconciliation対象とする。

### 6.3 Node State

```json
{
  "node_state_id": "nodestate_20260829_001_aggregate_customer",
  "node_state_key": "S1:...",
  "run_id": "netrun_20260829_001",
  "node_id": "aggregate_customer",
  "job_id": "aggregate_customer",
  "status": "SUCCESS",
  "latest_attempt_no": 2,
  "active_attempt_id": null,
  "revision": 7,
  "idempotent": true,
  "trigger_rule": "all_success",
  "blocked_by": [],
  "status_reason": null,
  "started_at": "2026-08-29T09:00:05Z",
  "finished_at": "2026-08-29T09:02:20Z",
  "updated_at": "2026-08-29T09:02:20Z"
}
```

`run_id + node_id`からcanonicalな`node_state_key`を生成し、その単一フィールドに重複禁止制約を設定する。kintoneに複合一意制約があるとは仮定しない。

### 6.4 Node Attempt

```json
[
  {
    "node_attempt_id": "attempt_20260829_001_aggregate_customer_001",
    "attempt_key": "A1:...",
    "run_id": "netrun_20260829_001",
    "node_id": "aggregate_customer",
    "job_id": "aggregate_customer",
    "invocation_id": "invoke_20260829_001",
    "attempt_no": 1,
    "status": "FAILED",
    "result_code": "API_ERROR",
    "execution_started_at": "2026-08-29T08:03:00Z",
    "runner_execution_started_at": "2026-08-29T08:03:01Z",
    "execution_id": "ksqlrun_20260829_001",
    "finished_at": "2026-08-29T08:05:00Z",
    "duration_sec": 120,
    "error_message": "...",
    "read_count": 30000,
    "written_count": 12000,
    "last_successful_chunk_no": 120,
    "last_written_key": "C012000"
  },
  {
    "node_attempt_id": "attempt_20260829_001_aggregate_customer_002",
    "attempt_key": "A1:...",
    "run_id": "netrun_20260829_001",
    "node_id": "aggregate_customer",
    "job_id": "aggregate_customer",
    "invocation_id": "invoke_20260829_002",
    "attempt_no": 2,
    "status": "SUCCESS",
    "result_code": "OK",
    "execution_started_at": "2026-08-29T09:00:05Z",
    "runner_execution_started_at": "2026-08-29T09:00:06Z",
    "execution_id": "ksqlrun_20260829_002",
    "finished_at": "2026-08-29T09:02:20Z",
    "duration_sec": 135,
    "error_message": null,
    "read_count": 30000,
    "written_count": 30000,
    "last_successful_chunk_no": 300,
    "last_written_key": "C030000"
  }
]
```

Node Stateをrevision付きで取得し、`latest_attempt_no + 1`を次のattempt番号候補とする。Node Attempt履歴の`max(attempt_no)`検索には依存しない。`run_id + node_id + attempt_no`からcanonicalな`attempt_key`を生成し、その単一フィールドに重複禁止制約を設定する。競合または応答消失時は再GETし、一意に確認できなければfail-closedとする。Node Attemptはサブテーブルではなく、検索・追記・保持期間管理が可能な独立レコードとする。

`execution_started_at`はorchestratorがkSQL-Flow呼出しを許可した時刻、`runner_execution_started_at`はkSQL-Flowの耐久`EXECUTION_STARTED`イベントを確認した時刻である。前者だけではSQL開始を証明しない。後者が存在する結果不明Attemptは、SQLが開始された可能性があるため`UNKNOWN`として扱う。

### 6.5 実行バンドル

バンドルは少なくとも次を含む。

```text
network.yaml
manifest.json
jobs/extract_sales.sql
jobs/aggregate_customer.sql
jobs/close_month.sql
```

`manifest.json`には各ファイルの相対パス、byte length、SHA-256、`inspect-job --json`で解決したjob ID、非決定要素の検査code、承認済み例外の主体・理由を持たせる。ZIP全体にもSHA-256を持たせる。

Network Run 作成は、バンドル保存とハッシュ検証が完了してから実行状態へ進める。resume 時に添付取得またはハッシュ検証に失敗した場合は fail-closed とし、作業ツリーの同名ファイルへフォールバックしない。

---

## 7. 再開アルゴリズム

### 7.1 通常 resume

1. 対象 Network Run を特定する。
2. Network Run ロックを取得する。
3. 保存済み実行バンドルを取得し、SHA-256 と接続先 snapshot を検証する。
4. `Run Invocation(mode = RESUME)` を作成する。
5. `SUCCESS` は保持する。
6. `BLOCKED` を `WAITING` に戻して依存を再評価する。
7. `FAILED` / `CANCELLED` は `idempotent = true` のノードだけを `WAITING` に戻す。`idempotent = false`は状態を維持し、そのノードと子孫を対象から除外する。依存しない系統の評価と実行は継続する。
8. `WAITING` の未着手ノードを評価する。
9. `UNKNOWN`が1件でもあれば、そのノードと子孫を対象から除外する。依存しない系統の評価と実行は継続する。
10. 安定トポロジカル順に直列実行し、各物理実行で Node Attempt を追記する。
11. 全 Node State から Network Run の集約状態を更新する。

### 7.2 `--rerun-from`

指定ノードとその全子孫を再実行対象にする。対象内の `SUCCESS` も `WAITING` に戻すが、過去の Node Attempt は保持する。対象外の上流ノードはそのまま保持する。

終端`SUCCESS`のNetwork Runは再オープンしない。終端`SUCCESS` Runへの`--rerun-from`は検証エラーとし、correction用の新しいbusiness keyで新しいNetwork Runを作成する。

指定ノードが存在しない、snapshot の DAG に対して子孫集合を計算できない、対象集合に未解決 `UNKNOWN` が含まれる、または対象集合に `idempotent = false` のノードが含まれる場合は実行しない。非冪等ノードの再実行は、業務固有の突合・補償手順を伴う専用の運用フローとして Phase 1 の汎用 CLI から分離する。

### 7.3 `UNKNOWN`と非冪等`FAILED`の手動解決

旧保持者の停止確認前に再実行してはならない。

1. cron、ポーラー、Actions 等の起動元を停止する。
2. `host`、PID、開始時刻、attempt、ローカル JSONL から旧保持者を特定する。
3. 旧保持者が停止し、業務書込が継続していないことを確認する。
4. 対象データを突合する。
5. 実結果を `SUCCESS` / `FAILED` / `CANCELLED` のいずれかとして、根拠と確認者を記録して解決する。
6. `idempotent = true` で再計算可能なら resume する。
7. `idempotent = false` なら、業務固有の補償または手動復旧が完了するまで自動 resume を禁止する。

`ksql-flownet resolve-node`は`UNKNOWN`または非冪等`FAILED`を対象とする。元Attemptは変更しない。`SUCCESS`への解決は、本来の成果物を手動で完成させた`NODE_MANUAL_COMPLETION_CONFIRMED`だけに許可する。取消・巻戻しだけを示す`NODE_COMPENSATION_COMPLETED`ではNode Stateを`SUCCESS`へ変更せず、下流を開始しない。

同一ホストで PID 不在を確認できる場合は停止確認を自動化できる。別ホストや到達不能ホストでは、時刻超過だけを停止確認の代用にしない。

---

## 8. 排他制御

### 8.1 ロック階層

| ロック | キー | 目的 |
| --- | --- | --- |
| Network Run ロック | `{profile}:__net__:{network_id}` | 同一 profile・同一 network の同時起動を防ぐ |
| Node ロック | `{profile}:{job_id}` | ジョブネット内ノードと単体ジョブの競合を防ぐ |

Network Run 中も各ノード開始時に既存形式の Node ロックを取得する。これにより、`monthly_close` の `aggregate_customer` 実行中に、別経路から同じジョブを単体実行した場合も競合として検出できる。

`{profile}:{run_id}:{node_id}`は採用しない。このキーでは別Runや単体実行との同時実行を許してしまうためである。`node_id`はDAG上の識別子、`job_id`はkSQL-FlowがSQLから解決する論理job IDとし、ロックは後者から生成する。

`__net__`は予約語とし、profile、network_id、job_idに`:`および予約名を許可しない。生成後のキーがフィールド長上限を超える場合は検証エラーとする。ハッシュ短縮を導入する場合は、表示名とは別にcanonical inputとアルゴリズム版を保存する。

### 8.2 ロック失敗

- 分散ロックを確立できない場合は fail-closed とする。
- ロック競合はノードの業務失敗ではなく、その Invocation の起動失敗として記録する。
- orchestratorはNodeロックを事前取得しない。kSQL-Flowがsubprocess内で取得する。有効な`LOCK_CONFLICT`結果では、準備済みNode Attemptを`CANCELLED / PREPARE_FAILED`で確定し、Node Stateを`WAITING`へ戻す。SQL実行失敗回数には数えないが、attempt番号と起動履歴は保持する。
- リース期限切れは旧保持者の死亡を意味しない。結果不明の実行を `FAILED` に落とさず `UNKNOWN` とする。
- 自動 stale 回収を許す場合も、少なくとも同一ホスト PID 不在など旧保持者停止を確認できることを条件とする。
- Job lockのforce-unlockはロック所有者であるkSQL-Flowのversion付き回復契約を通じて行う。FlowNetはJob lockレコードを直接変更せず、対象、認証主体、確認者、旧保持者停止確認、理由、時刻、kSQL-Flow側結果を監査イベントとして残す。契約未確定または停止確認不能なら解除しない。
- Network lockはFlowNetが所有する。lease期限超過だけでは自動回収せず、旧owner停止確認、expected owner、revision、`lease_token`を照合する。`force-unlock-network`の結果は`NETWORK_LOCK_FORCE_RELEASED`として監査し、回収後に実行中だったNodeを照合できなければ`UNKNOWN`として扱う。
- Network lockのtoken照合とNode State等の更新は別レコード操作であり、TOCTOU窓が残る。Job lockは同じ論理`job_id`の重複実行に対する最終防波堤だが、異なるNodeの順序やNetwork状態整合性は保証しないため、Network fencingを省略しない。この窓は残余リスクとして障害注入結果とrunbookへ記録する。

### 8.3 既存ログとの対応

現行ログの `TIMEOUT` は、発生源により次のように解釈する。

```text
runner自身が検知したexecution timeout
  -> Node Attempt.status = FAILED
  -> Node Attempt.result_code = EXECUTION_TIMEOUT
  -> Node State.status = FAILED

別実行によるstale回収
  -> Node Attempt.status = UNKNOWN
  -> Node Attempt.result_code = LEASE_EXPIRED
  -> Node State.status = UNKNOWN
```

前者はランナーが中断結果を認識している。後者は監視側が期限超過を検出しただけで、旧実行の完走・部分適用を確定できない。移行時にstatus文字列だけで判断せず、`log_detail`、record type、timeoutの発生元を参照する。

---

## 9. CLI

```bash
# 定義だけを検証する。外部状態は変更しない
ksql-flownet validate monthly_close

# business keyと安定トポロジカル実行計画を表示する。外部状態は変更しない
ksql-flownet plan monthly_close \
  --scheduled-for 2026-08-01T00:00:00+09:00

# Network lock、Run、Node Stateと復旧用識別子を読み取る
ksql-flownet status monthly_close \
  --profile production \
  --run-id netrun_20260829_001 \
  --json

# 新しい業務 Run を作る
ksql-flownet run-network monthly_close \
  --business-key monthly_close@2026-08

# 定期実行。対象時刻とnetwork定義からbusiness keyを生成
ksql-flownet run-network monthly_close --resume \
  --scheduled-for 2026-08-01T00:00:00+09:00

# Run ID を明示して継続
ksql-flownet run-network monthly_close \
  --resume-run netrun_20260829_001

# 指定ノードと全子孫を、同じ snapshot で強制再実行
ksql-flownet run-network monthly_close \
  --resume-run netrun_20260829_001 \
  --rerun-from aggregate_customer

# UNKNOWNまたは非冪等FAILEDを、証拠と承認に基づき手動解決
ksql-flownet resolve-node \
  --run-id netrun_20260829_001 \
  --node-id aggregate_customer \
  --to SUCCESS \
  --reason-file resolution-summary.txt \
  --evidence-ref reconciliation://monthly-close/2026-08/001

# stale候補のNetwork lockを、旧owner停止確認後に監査付きで回収
ksql-flownet force-unlock-network monthly_close \
  --profile production \
  --expected-owner-invocation-id invoke_20260829_002 \
  --reason-file network-lock-recovery.txt \
  --evidence-ref incident://2026-08-29/network-lock-001
```

規則:

- `validate`は定義schema、依存、循環、識別子、Phase 1対応値を検査するread-onlyコマンドとする。
- `plan`は`validate`に加え、business keyと安定トポロジカル順を表示するread-onlyコマンドとし、Networkロック、Run、Invocation、Attemptを作成・更新しない。
- `status`はNetwork lockのowner／lease／stale候補、Run、Invocation、Node State、active Attempt、reconciliation状態、復旧操作に必要な識別子を返すread-onlyコマンドとする。Networkロックを取得せず、停止を推測せず、秘密情報を出力しない。
- `force-unlock-network`はread-onlyではない。認証された実行主体、旧owner停止証拠、expected owner、理由、証拠参照を必須とし、競合または判定不能時はfail-closedとする。
- `--resume` は cron 向けの決定的な入口である。
- `business_key_policy.type = scheduled_period`では、定期実行は`--scheduled-for`を必須とし、orchestratorがtimezoneと期間境界からbusiness keyを生成する。
- backfill、correction、`business_key_policy.type = explicit`では`--business-key`を明示する。
- `--resume` は `profile + network_id + business_key` に一致する Run を検索する。
- 一致する Run が0件なら新規作成、未完了が1件なら継続、完了済みが1件なら何も実行せず Exit 0、複数件ならデータ不整合として Exit 1 とする。
- Networkロック取得後、一致Runが0件でも、別business keyの未完了Run数が`max_active_runs`に達していれば新規作成せず、阻害する`run_id`を表示してExit 1とする。
- `--resume-run` は指定 Run の `network_id`、profile、snapshot を検証する。
- `--rerun-from` は `--resume-run` または既存 Run を特定できる `--resume` と併用する。
- 終端`SUCCESS` Runへの`--rerun-from`は拒否する。
- resume 中に `--as-of`、現在の SQL、現在の DAG を上書き適用してはならない。
- 定義や as-of を変えたい場合は、変更理由を識別できる異なる `business_key` で新しい Network Run を作る。

既存の`run-all --resume`／`--resume-batch`を、Phase 1のNetwork Runへ透過的にresume移行しない。旧実行にはbusiness key、不変bundle、Node Stateがなく、安全な同一Run継続を保証できないためである。旧履歴を参照する必要がある場合は、`legacy_batch_id`を持つ監査専用データとして取り込み、`run_id`へ変換せず、resume判定にも使用しない。FlowNetへ移行する業務は新しいNetwork Runとして開始する。

---

## 10. Network Run の集約状態

| 条件 | Network Run.status |
| --- | --- |
| 1件以上 `UNKNOWN` | `UNKNOWN` |
| 1件以上 `RUNNING` | `RUNNING` |
| 1件以上 `FAILED` または `BLOCKED` | `FAILED` |
| 1件以上 `CANCELLED` かつ上記なし | `CANCELLED` |
| 全ノードが `SUCCESS` | `SUCCESS` |
| 上記以外かつ`started_at`がnull | `CREATED` |
| 上記以外かつ`started_at`が非null | `RUNNING` |

Phase 1では`SKIPPED`を生成せず、Network Run成功条件を全ノード`SUCCESS`に限定する。`started_at`は、開始前検証とreconciliationを完了し、最初のInvocationがノード評価へ進む直前に一度だけ設定する。Network Run集約状態は、Networkロックを保持するInvocationだけが全Node Stateから計算し、revision付きで更新する。

---

## 11. Phase 1 実装スコープ

### 11.1 実装する

1. YAML/JSON による DAG 定義と schema validation
2. Kahn のアルゴリズムによる循環検証
3. 安定トポロジカル順による直列実行
4. SQL 本文を含む不変実行バンドルと SHA-256 検証
5. Network Run / Run Invocation / Node State / Node Attempt の永続化
6. `UNKNOWN` と `idempotent` を含む状態・安全モデル
7. `all_success` による依存判定
8. 同一 Run 継続型 resume
9. `--resume` / `--resume-run` / `--rerun-from`
10. Network Run ロックと既存 Node ロックの統合
11. 現行チャンク進捗の Node Attempt への関連付け
12. UNKNOWN／非冪等FAILEDの`resolve-node`と、kSQL-Flowの回復契約に基づくforce-unlock監査イベント
13. `describe-profile --json`と`inspect-job --json`を使ったprofile／job ID／非決定要素の検証
14. kSQL-Flowの耐久`EXECUTION_STARTED`イベントとの照合
15. renewable Network lease、heartbeat、lease token、監査付き`force-unlock-network`
16. 復旧識別子を機械可読に返すread-only `status --json`
17. 同一ホストPIDとCloud Run Job Executionの停止確認adapter

### 11.2 実装しない

- ノード並列実行
- `none_failed` / `all_done`
- resume ごとの新しい Network Run と `REUSE` レコード生成
- 現在の作業ツリーを使った resume
- 任意 SQL 文または任意チャンク位置からの汎用 resume
- 旧保持者の停止を確認できない状態での自動再実行
- 非冪等ノードの自動リラン

---

## 12. 受入基準

設計を「凍結版」と呼ぶ前に、最低限次を自動試験または実機試験で確認する。

1. 3ノード DAG で中間ノードが失敗し、下流が `BLOCKED` になる。
2. resume 後も `run_id` は変わらず、`invocation_id` だけが増える。
3. 成功済み上流ノードに新しい Node Attempt が作られない。
4. 失敗 attempt 1 と成功 attempt 2 の時刻、件数、エラーが両方残る。
5. Run 作成後に作業ツリーの SQL を変更しても、resume は保存済み SQL を実行する。
6. バンドルのハッシュ不一致時に作業ツリーへフォールバックせず停止する。
7. `CANCELLED`、`UNKNOWN`が`all_success`を満たさず、下流が`BLOCKED`になる。Phase 1の定義とCLIから`SKIPPED`が生成されない。
8. stale 検出時に `UNKNOWN` となり、旧保持者停止確認なしでは resume されない。
9. `idempotent = false` の UNKNOWN/FAILED ノードが自動リランされない。
10. `node_id != job_id`の定義でも、ジョブネット内ノードと同じ`job_id`の単体ジョブが同時起動したとき、Nodeロックで一方が停止する。
11. cronの`--resume`が`--scheduled-for`から月跨ぎ・年跨ぎ・timezone境界でも同じbusiness keyを決定的に生成し、未完了Run 1件を継続し、0件なら新規作成し、完了済みなら二重実行せずExit 0になる。
12. `--rerun-from`が指定ノードと全子孫だけに新しいattemptを作り、対象集合に`idempotent = false`があれば拒否する。終端`SUCCESS` Runも拒否する。
13. 同じ `profile + network_id + business_key` の Run を、完了・未完了を問わず重複作成できない。
14. ロック取得不能、snapshot 取得不能、ログ永続化不能の各開始時エラーが fail-closed になる。
15. 別business keyの未完了Runが`max_active_runs`に達している場合、新しいRunを作らず阻害する`run_id`を返す。
16. `UNKNOWN`／非冪等`FAILED`の手動完遂は元Attemptを変更せず監査イベントを追記し、取消補償だけでは`SUCCESS`へ進まない。
17. UNKNOWN経路の下流は`BLOCKED`、依存しない系統は実行継続、Network Run集約状態は`UNKNOWN`となる。
18. `RECONCILIATION_REQUIRED`を一意に修復できない場合、SQLを開始せずfail-closedになる。
19. Network Run集約状態が表どおり決定的に算出され、Networkロック保持Invocationだけがrevision付きで更新する。
20. `describe-profile`の現在値がsnapshotと異なる場合、SQLを開始しない。
21. `job_id`とSQL論理job IDの不一致、および未承認の非決定要素を含む`idempotent = true`をバンドル作成時に拒否する。
22. Node Stateのrevision競合、`attempt_key`競合、Attempt INSERT応答消失で重複attemptを実行しない。
23. kSQL-Flowの耐久`EXECUTION_STARTED`を確認できない場合はSQLを開始せず、結果欠損時は2つの開始マーカーから安全側に`UNKNOWN`を判定する。
24. `LOCK_CONFLICT`ではSQLを開始せず、Node Attemptを`CANCELLED / PREPARE_FAILED`、Node Stateを`WAITING`として確定し、attempt番号を再利用しない。
25. FlowNetプロセスkillでNetwork heartbeatが停止し、正常な長時間Runはstale扱いされず、停止確認なしの自動回収は拒否される。監査付き`force-unlock-network`後は旧`lease_token`のownerが状態更新・次Node起動をできず、実行中Nodeを照合できない場合は`UNKNOWN`になる。
26. kintone一時到達不能でheartbeatを更新できない場合、新しいNodeを開始せず、実行中subprocessを原則killしない。heartbeat再更新成功時だけ結果を保存してInvocationを`CANCELLED / NETWORK_LEASE_INTERRUPTED`で終端し、更新不能またはowner変更時は状態を書かない。
27. `status --json`がNetwork lock owner、lease、Run、Node State、active Attemptと復旧識別子を返し、Networkロックや実行状態を変更しない。
28. Cloud Run Job Executionのterminal状態だけを旧owner停止確認として受理し、RUNNING、PENDING、権限不足、通信失敗、未知状態では自動回収しない。heartbeatと停止確認のAPI callをControl Plane使用量として別計測する。

---

## 13. Gemini案・Claude案からの採否

| 論点 | 採否 | 推奨仕様での扱い |
| --- | --- | --- |
| `NONE` 導入 | 考え方を採用、値は不採用 | 未実行を実行 attempt として記録しないことで、より直接的に表現 |
| `reused_from_*` | 不採用 | 同一 Run 継続のため不要。成功保持は Invocation に記録 |
| `effective_status` | 不採用 | status の恒等写像を避け、`trigger_rule` で依存意味論を定義 |
| definition snapshot | 強化して採用 | パスやハッシュだけでなく SQL 本文を含む不変バンドルを保存 |
| 3階層 Hierarchical Resume | 名称を修正 | Phase 1 は Network Resume + Node Replay。chunk は診断情報 |
| `UNKNOWN` | 採用 | stale/孤児化を失敗確定と区別 |
| `idempotent` | 採用 | 全ノード必須。自動復旧可否の安全ゲート |
| Node State / Node Attempt 分離 | 採用 | 現在状態と試行ごとの耐久履歴を分離 |
| trigger rule キー | 採用 | Phase 1 は `all_success` のみ実装 |
| Run 分割 | 不採用 | 業務単位は同一 Run、起動単位は Invocation |
| `--resume` | 採用 | cron から run_id 調査なしで利用可能 |
| Network/Node ロック | 採用 | 既存単体ジョブとの競合も同じ Node ロックで防止 |

---

## 14. 凍結前に残る確認事項

凍結判断の正本は、[Phase 1 Freeze Decision Record](./phase1-freeze-decision-record.md) とする。同ADRが`PROPOSED`の間、本書も「設計凍結候補」を維持する。

| 分類 | 主な項目 |
| --- | --- |
| `DECIDED` | 同一Run継続、ensure-run、Network単位ロック、UNKNOWN Resolution、status移行原則、旧run-all移行境界、read-only CLI、外部ジョブスケジューラとの責務境界 |
| `PROPOSED` | Source of Truth、FlowNet新規1／2アプリ構成（既存kSQL-Flow JOBログアプリは別所有）、Network Lock配置、二重書込み・reconciliation、canonical lock key、Job／Network lockのforce-unlock回復契約 |
| `VALIDATION_REQUIRED` | kintone重複禁止INSERTの同時競合、bundle upload/download、障害注入 |
| `OPERATIONS_REQUIRED` | bundle保持・archive、UNKNOWN解決権限、新旧lock protocol移行 |

同ADRの凍結ゲートをすべて満たし、受入試験と復旧訓練が完了した時点で「Phase 1 凍結版」へ昇格する。

---

## 15. 現行 kSQL-Flow との重要な差分

本書は将来仕様の提案であり、現行実装の説明ではない。

- 現行仕様には `SUCCESS` / `NO_DATA` / `ABORTED` / `FAILED` / `SKIPPED` / `RUNNING` / `TIMEOUT` がある。本書はジョブネット層で状態を正規化し、詳細を `result_code` に分離する。
- 現行の `last_written_key` は順序保証のない診断情報であり、途中再開カーソルではない。
- 現行の書込チャンクは最大100件/リクエストであり、「500件単位のカーソル再開」を既存機能として前提にしない。
- 現行の distributed lock は時限リースであり、期限超過は死亡確認ではない。
- 現行の `--resume` は元の as-of を引き継ぐが、コードと未追跡変更を完全固定する仕組みではない。本書の実行バンドルがその不足を埋める。
