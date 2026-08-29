# Phase 1 仕様レビュー（外部レビュー反映版）

- 文書状態: **PROPOSED**
- 対象: `docs/` 配下の Phase 1 仕様一式
- 初版: 2026-08-29
- 改訂: 2026-08-29（外部レビューと再レビューによる訂正を反映）
- 位置づけ: 本書は判断ではなく、[Phase 1 Freeze Decision Record](./phase1-freeze-decision-record.md) へ `D-15` 以降として取り込むための判断候補である。
- 反映状態: **REFLECTED**（2026-08-29、FDR `D-15`〜`D-25`、`D-28`および関連仕様へ反映）

---

## 0. 改訂履歴

初版に対する外部レビューを受け、次を訂正した。

| 初版ID | 初版の主張 | 本版での扱い | 理由 |
| --- | --- | --- | --- |
| A-3 | UNKNOWN 停止範囲が2文書で矛盾している | `R-07` へ格下げ。矛盾ではなく単一文書内の未確定 | [job-network-phase1-spec.md](./job-network-phase1-spec.md) 7.1-9 はスコープを「そのノードと下流」に限定しており、[job-network-examples.md](./job-network-examples.md) 6 と両立する |
| B-2 | 「ロックも別 business_key なので競合しない」 | 該当記述を撤回。`R-06` として再構成 | Phase 1 の Network ロックは `profile + network_id` 単位であり business key を含まない（[FDR D-03](./phase1-freeze-decision-record.md)）。リスク自体は残るが機序の説明が誤っていた |
| A-1 | node_id と論理ジョブ ID を同名にする | `R-02` で明示 `job_id` 方式へ変更 | 同名強制よりノード名の自由度を保てる |
| C-1 | 契約へ `NOT_RUN` status を追加する | `R-08` で `executionStarted` 方式へ変更 | status enum を増やさずに同じ判定ができる |
| B-1 | 遷移先を SUCCESS / FAILED / SKIPPED へ広げる | `R-04` で Node State のみの遷移と明記し、SKIPPED の扱いを再整理 | 元 Attempt の不変性（[FDR D-04](./phase1-freeze-decision-record.md)）と読み分けられない書き方だった |
| （なし） | — | `R-01` を新規追加 | CLI の所有プロジェクトが文書間で矛盾している点を初版が見落としていた |

---

## 1. 指摘一覧

| ID | 分類 | 対象 | 凍結前必須 |
| --- | --- | --- | --- |
| `R-01` | 文書間矛盾 | CLI の所有プロジェクト | 必須 |
| `R-02` | 文書間矛盾 | Node ロックキーの生成元 | 必須 |
| `R-03` | 仕様欠落 | resolved profile の照合手段 | 必須 |
| `R-04` | 運用の行き止まり | 非冪等 FAILED の復旧出口と SKIPPED | 必須 |
| `R-05` | 仕様矛盾 | 完了済み Run への `--rerun-from` | 必須 |
| `R-06` | 仕様欠落 | business key の生成規則と多重 Run 方針 | 必須 |
| `R-07` | 未確定 | resume 手順の停止スコープ | 望ましい |
| `R-08` | 契約設計 | SQL 未実行の耐久マーカー | 望ましい |
| `R-09` | 検証欠落 | `idempotent` の静的検査 | 望ましい |
| `R-10` | 細部 | 集約状態表・採番クエリ・受入基準 | 望ましい |

---

## 2. 各指摘

### R-01: CLI の所有プロジェクトが矛盾している

[architecture-separation-adr.md](./architecture-separation-adr.md) はジョブネット管理を別プロジェクト `ksql-flownet` へ置き、境界を CLI subprocess とすると決めている。同 ADR 3 の選択基準表も、第3の選択肢を `ksql-flownet` というコマンドとして提示している。

一方で、実際のコマンド例は `ksql-flow` 配下にある。

```bash
ksql-flow run-network ...        # job-network-phase1-spec.md 9
ksql-flow resolve-unknown ...    # phase1-freeze-decision-record.md D-13
```

この表記のままだと次が成立しない。

- orchestrator と kSQL-Flow の version / release cadence を独立させる（ADR 8 の利点）
- [Execution Contract v1](./execution-contract-v1.md) における「orchestrator が `ksql-flow run` を subprocess 起動する」構造。同一binary内でも子プロセス起動は技術的に可能だが、Control PlaneとExecution Planeのrelease境界が失われる
- `run-all --resume`（既存・バッチ resume）と `run-network --resume`（ensure-run semantics）が同一 CLI 上で異なる意味を持つことになり、利用者が区別できない

ADR 3 の表記が正であり、仕様書と FDR のコマンド名を次へ統一する。

```bash
ksql-flownet run-network ...
ksql-flownet resolve-node ...
```

### R-02: Node ロックキーの生成元が食い違っている

| 文書 | 記述 |
| --- | --- |
| [job-network-phase1-spec.md](./job-network-phase1-spec.md) 8.1 | Node ロック = `{profile}:{node_id}` |
| [current-ksql-flow-changes.md](./current-ksql-flow-changes.md) 5 | 現行形式 `{profile}:{jobName}` を維持 |
| [architecture-separation-adr.md](./architecture-separation-adr.md) 5 | Job / Node ロックの所有者は kSQL-Flow |
| [execution-contract-v1.md](./execution-contract-v1.md) 2 | correlation / attempt ID をロックキーの生成材料にしない |

ロックを取得するのは kSQL-Flow であり、契約の CLI には node_id を渡す引数がない。したがって実際に生成されるキーは SQL から解決した `job.name` 由来であり、`node_id` 由来ではない。両者が一致しない定義を書いた時点で、「ジョブネット内ノードと単体ジョブを同じロック体系で排他する」という設計目標が黙って失われる。

`node_id` の一意性要件はネットワーク内に限定されており（同仕様 4.2）、profile 内で論理ジョブ ID と 1:1 である保証はない。

#### 推奨

ノードに明示的な `job_id` を持たせ、ロックキーは `job_id` から生成する。

```yaml
- id: aggregate_customer_node
  job_id: aggregate_customer
  sql: jobs/aggregate_customer.sql
```

- ロックキー表記を `{profile}:{job_id}` へ修正する
- `job_id` と SQL の論理ジョブ ID の一致検証を、実行時（契約 11）だけでなく**バンドル作成時**（仕様 4.2）へ前倒しする
- 受入基準10（単体実行との競合試験）に、`node_id != job_id` のケースを含める

### R-03: resolved profile の照合手段が存在しない

契約 11 と仕様 6.1 は、接続先 URL・guest space・アプリ ID・timezone が snapshot と一致することの検証を要求しているが、その値を取得する手段が契約にない。`capabilities --json` が返すのは version と feature のみである。

orchestrator が kSQL-Flow の config 形式を独自に解釈する案は、ADR 4 の分離方針に反するため採らない。次のいずれかを FDR で決定する。

1. `ksql-flow describe-profile --profile <name> --json` を契約へ追加する
2. `capabilities --json --profile <name>` に解決済みの非秘密設定を含める
3. バンドル作成時に kSQL-Flow 自身が resolved profile manifest を出力し、バンドルへ同梱する

3 は snapshot の一部として不変化できる利点があるが、resume 時点の実設定との突合は別途必要になる。いずれを選ぶにせよ、[current-ksql-flow-changes.md](./current-ksql-flow-changes.md) 8 の実装順と Phase 0 受入基準へ追加する。

### R-04: 非冪等 FAILED の復旧出口がなく、SKIPPED は到達不能

#### 現状の出口

| Node State | 前進手段 |
| --- | --- |
| `UNKNOWN` | `resolve-unknown`（FDR D-13） |
| `FAILED` + `idempotent = true` | resume で再実行 |
| `FAILED` + `idempotent = false` | **なし** |

仕様 7.3-7 は「非冪等なら業務固有の補償または手動復旧が完了するまで自動 resume を禁止する」と定めるが、その手動復旧が完了した事実をシステムへ伝える経路が定義されていない。結果として Run が恒久的に前進しない。

#### SKIPPED の位置づけ

Phase 1 には `SKIPPED` を生成する経路が存在しない。条件分岐は Phase 2 送りであり、明示指示のコマンドも CLI にない。にもかかわらず、仕様 10 は「許可された `SKIPPED`」を完了条件に含め、受入基準7 は `SKIPPED` の伝播を試験項目としている。

さらに、仕様 5.4 により `SKIPPED` は `all_success` を満たさず下流を `BLOCKED` にする。したがって**手動復旧済みノードを `SKIPPED` へ解決しても Run は前進しない**。復旧経路として意味を持つ遷移先は `SUCCESS` だけである。

#### 推奨

- Phase 1 では `SKIPPED` を予約状態へ格下げし、生成経路を持たせない
- 同時に、仕様 10 の「許可された `SKIPPED`」句と受入基準7 の `SKIPPED` 部分を削除する（`CANCELLED` / `UNKNOWN` の試験は残す）
- `resolve-unknown` を `resolve-node` へ一般化し、対象 Node State を `UNKNOWN` / `FAILED`、遷移先を `SUCCESS` / `FAILED` とする
- **元の Node Attempt は変更しない。** 遷移するのは Node State のみであり、根拠は追記イベントとして残す

```text
Attempt #1 = FAILED（不変）
        ↓ 手動突合・補償
NODE_RECOVERY_CONFIRMED を追記
  service principal / 依頼者 / 承認者 / 証拠参照 / 停止確認
        ↓
Node State = SUCCESS
```

`SUCCESS` が唯一の前進先になるため、この遷移の承認要件は `UNKNOWN → SUCCESS`（FDR D-13）と同等以上とする。非冪等ノードについては一者操作を許さない。

ただし、「補償または手動復旧が完了した」を一括して`SUCCESS`へ解決してはならない。人手による処置の結果を次のように区別する。

| 人手による処置の結果 | Node Stateの扱い |
| --- | --- |
| 本来のジョブ成果物を手動で完成させた | 根拠と承認を記録して`SUCCESS`へ解決可能 |
| 部分書込みを取り消して実行前の状態へ戻した | `SUCCESS`にしない。`FAILED`を維持するかRunを`CANCELLED`として新しいRunへ移る |
| 補償後に本来の成果物まで再作成した | 完遂の証拠を確認した場合だけ`SUCCESS`へ解決可能 |
| 実結果を確定できない | `UNKNOWN`または`FAILED`を維持する |
| 業務を中止した | NodeまたはNetwork Runを`CANCELLED`として確定する |

監査イベントも、少なくとも次を区別する。

```text
NODE_MANUAL_COMPLETION_CONFIRMED  # 本来の処理結果を手動で完成
NODE_COMPENSATION_COMPLETED       # 取消・巻戻し等の補償だけを完了
```

`NODE_COMPENSATION_COMPLETED`だけでは`all_success`を満たさず、下流を開始しない。`resolve-node --to SUCCESS`は、期待する成果物が完成したことを証明できる`NODE_MANUAL_COMPLETION_CONFIRMED`に限定する。

### R-05: 完了済み Run への `--rerun-from` が未定義

- ensure-run は完了済み Run を NO-OP / Exit 0 とする（FDR D-02）
- `--rerun-from` は対象内の `SUCCESS` を `WAITING` へ戻す（仕様 7.2）

優先順位が定義されていない。また、終端 `SUCCESS` の Run を再オープンすると、成功として報告済みの業務実行の記録が事後に書き換わる。

#### 推奨

```text
未完了 Run + --rerun-from   → 許可
SUCCESS Run + --rerun-from  → 拒否
再処理が必要                → correction 用の新しい business_key で新規 Run
```

仕様 2.1 が定義変更時に別 business key を要求しているのと一貫する。仮に再オープンを許すなら、Network Run へ reopen イベントを追記し、仕様 10 の集約状態表へ `SUCCESS → RUNNING` 遷移を明示する必要がある（現在の表にこの遷移はない）。

### R-06: business key の生成規則と多重 Run 方針が未定義

FDR D-02 は定期実行での `business_key` 明示必須を定めるが、生成規則がない。実行時刻から生成する運用にすると、次が起きる。

```text
8月分 Run が UNKNOWN で停止
        ↓
9/1 00:05 の cron が --business-key monthly_close@$(date +%Y-%m) で起動
        ↓
2026-09 で検索 → 0件 → NEW を作成
        ↓
8月分は放置される
```

Phase 1 の Network ロックは `profile + network_id` 単位で business key を含まない（FDR D-03）。停止中の8月 Run はロックを保持していないため、9月 Run の作成を妨げるものがない。

さらに、8月 Run のプロセスが異常終了しリースが未回収の場合は、9月の起動が Network ロック競合で fail-closed する。**同じ cron 行が、リースの期限到来タイミング次第で「別 Run を新規作成する」か「ロック競合で失敗する」かに分岐する**。D-02は同じbusiness keyと同じ永続状態に対するensure-run判定を決定的にするが、それだけではスケジュール対象期間とbusiness key生成の決定性を保証できない。

#### 推奨

- business key を実行時刻ではなく**スケジュール対象期間**から生成する。timezone と期間境界はジョブネット定義に固定し、シェルの `date` に依存させない
- backfill と correction では business key を明示指定できるようにする
- 別 business key の未完了 Run が存在する場合の方針（`max_active_runs: 1` 等）をジョブネット単位で宣言可能にする。既定値と、違反時の挙動（阻害している `run_id` を示して拒否する／待機させる）を定義する
- 生成規則をすべての Network へ一律強制はしない。業務種別により適切な粒度が異なる

### R-07: resume 手順の停止スコープが読み取れない

仕様 7.1 の該当箇所は次である。

```text
7. FAILED / CANCELLED は idempotent = true のノードだけを WAITING に戻す。
   idempotent = false は自動再実行せず停止する。
9. UNKNOWN が1件でもあれば、そのノードと下流を自動実行せず停止する。
```

「そのノードと下流」というスコープ限定があるため、[job-network-examples.md](./job-network-examples.md) 6 の「依存関係のない系統は継続」と矛盾はしない。初版の「文書間矛盾」という判定は取り下げる。

ただし両ステップの「停止する」に目的語がなく、当該系統のみを止めるのか Invocation 全体を止めるのかは確定していない。読みの差は観測結果に現れる。

| 読み | 独立系統の Node Attempt | Invocation の結果 |
| --- | --- | --- |
| 系統スコープ | 作られる | 部分実行として終了 |
| Invocation 全体 | 作られない | 何も実行せず終了 |

7 と 9 の「停止する」を、それぞれ「当該ノードと子孫を対象から除外し、独立系統の実行は継続する」等へ書き下す。あわせて受入基準へ次を追加する。

```text
UNKNOWN 経路の下流は BLOCKED
依存しない別系統は実行継続
Network Run 集約状態は UNKNOWN
```

### R-08: SQL 未実行の耐久マーカー

契約 13 の未決事項「SQL 開始前失敗を UNKNOWN ではなく未実行と証明する耐久マーカー」について、初版はstatusへの`NOT_RUN`追加を提案した。status enumは増やさず、Execution Resultの要約フィールドと、SQL開始直前の耐久イベントを組み合わせる。

#### Execution Resultの要約

```json
{
  "executionStarted": false,
  "resultCode": "LOCK_CONFLICT"
}
```

- 全 Execution Result に必須フィールドとして含める（`SUCCESS` / `FAILED` / `CANCELLED` を問わない）
- 定義は「SQL の最初の文の実行を開始したか」とし、判定時点を契約で固定する
- `VALIDATION_ERROR` と `LOCK_CONFLICT` は常に `false` となる

このフィールドは有効な最終JSONを返せたcontrolled failureの分類には使えるが、それ自体は耐久マーカーではない。SQL開始後にプロセスが強制終了するとExecution Result自体が存在しないためである。

#### kSQL-Flow側の耐久イベント

kSQL-Flowは最初のSQL文を開始する直前に、JOBログまたはローカルJSONLへ`EXECUTION_STARTED`イベントを永続化する。

```text
1. JOBログ／ローカルJSONLへ EXECUTION_STARTED を書き込む
2. 必要な保存先への永続化成功を確認する
3. SQLの最初の文を開始する
```

イベントには少なくとも`execution_id`、`correlation_id`、`attempt_id`、`started_at`を含める。どの保存先への成功を「耐久」と認めるか、ログアプリ到達不能時にローカルJSONLだけで実行を許可するかはExecution Contractで決定する。開始イベントを確定できない場合はSQLを開始せずfail-closedとする。

3種類のマーカーを同一視しない。

| マーカー | 意味 | 結果欠損時の利用 |
| --- | --- | --- |
| Node Attempt `execution_started_at` | orchestratorが実行開始を許可し、kSQL-Flow呼出しへ進める状態にした | 単独ではSQL開始を証明しない |
| kSQL-Flow `EXECUTION_STARTED`イベント | kSQL-Flowが最初のSQL文開始直前まで到達した | SQLが開始された可能性があるため、安全側に`UNKNOWN` |
| Execution Result `executionStarted` | 有効な最終結果を返せた場合の要約 | 結果JSONがある場合だけ使用可能 |

結果JSONも耐久イベントも存在せず、Node Attemptの`execution_started_at`だけがある場合は、SQL未実行と推測しない。起動失敗を別の耐久証跡で確定できなければ`UNKNOWN`とする。

### R-09: `idempotent` の静的検査

`idempotent` は自動復旧可否の唯一の安全ゲートだが、現状は申告制で検証がない。仕様 15 と ADR 6 が認めるとおり、`@` を伴わないサーバー評価時刻関数は snapshot で固定されない。

静的検査で冪等性を証明することはできないため、二段階とする。

1. サーバー時刻、乱数、外部状態参照など、明確な非決定要素を検出する
2. 検出されたノードに `idempotent: true` が付いている場合は、検証エラーまたは明示承認を要求する

検査は作業ツリーではなく**バンドルに対して**実行し、結果を manifest へ記録する。resume 時に判定が変わらないようにするためである。既存の `--json` は dry-run 専用のため、新しいサブコマンドとして Execution Contract へ定義する。

### R-10: 細部

- **集約状態表が非決定的**: 仕様 10 の最終行「それ以外（未着手を含む）→ `CREATED` または `RUNNING`」は凍結対象の表として機能しない。`started_at` の有無等で確定させる。全ノードが `SKIPPED` の場合の行もない（R-04 で `SKIPPED` を予約化するなら不要）
- **attempt_noの採番**: Node Attempt履歴から`max(attempt_no)`を検索して採番しない。Networkロックの保持中に、revision付きで取得したNode Stateの`latest_attempt_no + 1`を候補とする。Nodeロックはorchestratorが事前取得せず、kSQL-Flow subprocess内で取得する。`run_id + node_id + attempt_no`からcanonicalな`attempt_key`を生成し、その単一フィールドへ重複禁止制約を設ける。Node State更新とAttempt作成の競合・応答消失時は再GETし、一意に確認できなければfail-closedとする。FDR Spike Aでは、revision不一致、`attempt_key`競合、INSERT成功応答消失、State更新失敗後のreconciliationを測定する
- **受入基準の追加候補**:
  - reconciliation が `RECONCILIATION_REQUIRED` で fail-closed すること
  - `--rerun-from` の子孫集合に `idempotent = false` が含まれるとき拒否すること（仕様 7.2 にあるが試験項目にない）
  - 集約状態が仕様 10 の表どおりに算出されること（特に `UNKNOWN` が `RUNNING` より優先されること）
- **Phase 2 への備え**: 並列化すると Network Run 集約状態の更新が複数ノードから同時に発生する。仕様 10 は更新主体と排他を規定していない。Phase 1 のうちに「集約状態は Invocation が単独で revision 付きで更新する」と定めておくと、Phase 2 でスキーマを開けずに済む

---

## 3. 凍結ゲートへの追加候補

[phase1-freeze-decision-record.md](./phase1-freeze-decision-record.md) 12 の凍結ゲートへ、次の追加を提案する。

- [ ] `R-01`: 全文書のコマンド名を所有プロジェクトへ統一し、`run-all --resume` との意味衝突を回避する
- [ ] `R-02`: `job_id` によるロックキー生成と、バンドル作成時の一致検証。`node_id != job_id` を含む単体実行競合試験に合格する
- [ ] `R-03`: resolved profile の照合手段を契約へ追加し、不一致で fail-closed する
- [ ] `R-04`: 非冪等 `FAILED` の復旧プロトコルを定義し、`SKIPPED` の Phase 1 での扱いを確定する
- [ ] `R-05`: 終端 `SUCCESS` Run への `--rerun-from` の可否を確定する
- [ ] `R-06`: business key の生成規則と多重 Run 方針を定義し、月跨ぎ・年跨ぎ・timezone 境界での ensure-run 決定性を試験する

`R-01` `R-02` `R-04` `R-06` は、実装後に修正するとデータモデルではなくロック体系と運用手順へ波及するため、優先度が高い。

---

## 4. 本レビューの限界

- 本書は `docs/` 配下の文書のみを対象としており、kSQL-Flow 本体の実装との突合は行っていない。`R-02` の現行ロックキー生成箇所など、実装確認を要する項目が含まれる
- kintone の実挙動に依存する事項（重複禁止 INSERT の競合、添付容量、インデックス反映遅延）は、FDR の `VALIDATION_REQUIRED` に従って実測で確定させる必要がある
- 本書自体は判断の正本ではない。採用判断はFDR `D-15`〜`D-25`および`D-28`、実行契約と詳細規則は関連仕様を正とする
