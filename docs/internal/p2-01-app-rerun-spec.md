# P2-01: アプリ起点リラン(案B) 仕様書

- 文書状態: **REVIEWED**(Phase 2 最初の作業単位。凍結仕様の変更ではなく外付け追加のためFDR再審議は不要 — ただし本仕様の受入合格まで本番profileへ載せない)
- 起案日: 2026-08-31 / 改訂: 2026-08-31 Codexレビュー([実装計画](./p2-01-implementation-plan.md)§2)の指摘G-01〜G-08を反映(初版DRAFTの実装不能3点 — network定義パス不足・Invocation ID取得不能・30分固定stale — を解消) / 2026-09-05 P2-16 反映(CLOSE・claim前取消・終端hold解除)
- 正本参照: [implementation-plan.md](./implementation-plan.md) P2-01/P2-02、[job-network-phase1-spec.md](./job-network-phase1-spec.md) §7.4(PRE-06 = 要求モデルのプロトタイプ)・§7.2(rerun-from)・§5.3(ブレーキ)、[討論記録](./kintone-ops-roadmap-discussion.md) §13.2(設計条件)、my-ksql-jobs `docs/poll_control_setup.md`(旧ポーラーの設計資産)

## 1. 目的と非目的

**目的**: SSH/CLIなしで、kintoneアプリの画面から (a) 失敗Runの再開(リラン)、(b) Run単位の停止要求、を安全な範囲に限って起動できるようにする。旧kSQL-Flowリランポーラー(切替で停止済み)のFlowNet版後継。

**非目的**: resolve-node等の判断を伴う操作のアプリ化(一次対応者のCLI作業のまま)。FlowNet本体(orchestrator/ensure-run)の変更。承認フロー(非冪等の承認はPhase 1決定どおり`--approved-by`のCLI専用)。

## 2. 構成要素

```
[操作要求アプリ(新設・人間が書く)] ←── 一次対応者がレコード追加(要求)
        ↑ 状態更新(受理/結果)
[poll-requests(新設CLIコマンド・cron起動)] ── 子プロセスとして run-network / cancel-run / archive-run を起動
        ↓
[実行管理4261 / 監査4262(機械専用・既存)]
```

- **機械専用制約の維持**: 実行管理アプリには人間もポーラーも書かない。人間が書くのは操作要求アプリのみ、そこへ機械(ポーラー)が状態を書き戻す(討論§13.2-1と同型の分離)。
- **CLI境界の維持**: ポーラーは`run-network`/`cancel-run`/`archive-run`を**自分自身のCLIの子プロセス**として起動する(人間と同じ信頼経路・同じ検証を通る。内部APIへ直結しない)。

## 3. 操作要求アプリ(テンプレート新設)

1要求=1レコード。終端後も残す(レコード自体が監査を兼ねる — PRE-06と同思想)。再利用しない(PRE-06のCANCEL_REQUESTは1 Run 1レコード再利用だが、要求アプリは操作履歴が価値のため使い捨て)。

| フィールド | 型 | 書き手 | 内容 |
| --- | --- | --- | --- |
| `request_type` | ドロップダウン | 人 | `RERUN` / `STOP` / `RELEASE` / `START` / `CLOSE` |
| `run_id` | 文字列1行(必須) | 人 | 対象Run(確認ボード/status出力からコピー) |
| `rerun_from_node` | 文字列1行(任意) | 人 | RERUN時のみ有効。`--rerun-from`対象ノード |
| `reason` | 文字列複数行(必須) | 人 | 理由(PRE-06と同じく必須) |
| `request_state` | ドロップダウン | 機械 | `REQUESTED`(初期値) → `ACCEPTED` → `DONE` / `REJECTED`、またはclaim前に`CANCELLED` |
| `cancel_requested` | チェックボックス | 人(作成者だけ) | 値`取消`。`REQUESTED`の間だけ有効で、一度立てた取消は不可逆 |
| `claimed_at` / `claimed_host` | 日時/文字列 | 機械 | 受理時に記録 |
| `claim_heartbeat_at` | 日時 | 機械 | 子プロセス実行中にポーラー親が定期更新(stale判定の主材料 — G-05) |
| `result_code` / `result_message` | 文字列 | 機械 | 実行結果(拒否理由・起動したInvocation ID・Exit Code) |
| 作成者/作成日時 | システム | — | **要求者の真正性の根拠**(偽装不可。専用フィールドで自己申告させない) |

- トークン権限: ポーラー用は**追加なし・読取・編集**(人のレコードを消せない)。人はkintone画面から追加のみ。
- 選択肢は上記のみ(旧poll_control_setup.mdと同じ「選択肢を増やさない」規律)。

## 4. 状態機械と受理範囲

`REQUESTED → ACCEPTED → DONE / REJECTED`、または`REQUESTED → CANCELLED`(claim前取消)。全遷移revision fencing付きであり、取消とclaimが競合した場合は再GETした状態で裁定する。

**受理範囲(fail-closed・固定)** — 範囲外は`REJECTED`+理由:

| request_type | 受理条件(一次審査) | 実行内容 |
| --- | --- | --- |
| `RERUN` | 対象Runの`status`が`CREATED / RUNNING / FAILED / CANCELLED`のいずれか(**G-01**: `SUCCESS / UNKNOWN`は拒否)、`resume_allowed = true`かつ`lifecycle_status = ACTIVE`、live ownerなし(**G-02**: `activity != LIVE`に加え、詳細statusのlock ownerが当該RunのInvocationに属しlease生存(分精度+60秒保守)なら拒否 — 終端statusにはactivityが付かないため)、status JSONの`hold = null`。activityは表示・live判定の補助であり、holdの正は`runs[].hold` | `run-network <定義パス> --resume-run <run_id> --json`(`rerun_from_node`指定時は`--rerun-from`付与) |
| `STOP` | 対象Runが存在し未終端 | `cancel-run --run-id <run_id> --reason-file <一時ファイル>` |
| `RELEASE`(**G-06: 採用**) | status JSONの`hold`が非null(`REQUESTED/ACCEPTED`のCANCEL_REQUEST)。Run状態は問わない。holdなしは`REJECTED / RUN_NOT_ON_HOLD` | `cancel-run --run-id <run_id> --release --reason-file <一時ファイル>`。**hold解除のみで自動再開しない**(次の定期`--resume`が再開し得ることを画面・手順へ明記) |
| `START`(**2026-09-02改訂D-2で追加 — 正は[P2-11](./p2-11-adhoc-start-spec.md)**) | 三重ゲート(アプリ権限×allowlist `app_start: true`明示×全ノード明示`idempotent: true`)+キー規則(P2-11 §3)+`run_id`空必須。受理判定の詳細はP2-11 §4の表が正 | `run-network <定義パス> [--business-key <key>] [--scheduled-for <RFC3339>] --json`(**`--resume`/`--resume-run`は絶対に付けない** — P2-11 I-01) |
| `CLOSE`(**2026-09-05 P2-16追加**) | allowlist内で一意な`FAILED / CANCELLED`、`lifecycle_status = ACTIVE`、holdなし、live ownerなし。SUCCESS/UNKNOWN/非終端は拒否。既にARCHIVEDならDONE/NOOP | `archive-run <定義パス> --run-id <run_id> --reason-file <一時ファイル>`。Invocationを作らず`lifecycle_status = ARCHIVED`へ変更する |

- **対象解決(G-03)**: 要求には`run_id`しかなく、`status`/`run-network`は`network_id`・network定義パスを必須とする。ポーラーは**非秘密のallowlist設定(`network_id → network定義パス`の対応表)**を持ち、allowlist内の各networkへ`status --json`検索して一意解決する。0件は`RUN_NOT_FOUND`、複数件は`RUN_ID_AMBIGUOUS`で拒否(fail-closed)。要求者にnetwork_idを手入力させない。**2026-09-02改訂D-2([P2-11](./p2-11-adhoc-start-spec.md))**: `START`要求のみ例外で、`run_id`を持たず要求レコードの`network_id`欄からallowlistを**直接解決**する別分岐(status検索は行わない)。allowlistの`app_start: true`明示がない`network_id`は`NETWORK_NOT_ALLOWED`で拒否し、`app_start: false`は既存のRERUN等の解決には影響しない。
- ポーラーの事前チェックは**一次審査**(親切な拒否理由のため)であり、正の検証・排他はCLI側の既存規則(終端SUCCESS拒否、R2-1の非冪等×既存attempt拒否、RETRY_BRAKE解除は--rerun-fromのみ、lock競合等)。
- **結果の意味論(G-04/G-07)**: `run-network`へ後方互換の`--json`出力を追加し(`outcome / run_id / invocation_id / aggregate_status / invocation_result_code / retry_brake_node_ids`。NO-OPは`invocation_id = null`、`retry_brake_node_ids = []`。orchestration本体は無改修 — CLI表示境界のみの拡張として本体無改修原則から明示的に分離)、ポーラーはこれで結果分類する: **`REJECTED`は事前審査拒否・spawn不能・Invocation作成前のCLI検証拒否に限定**。Invocation作成後はaggregateが非SUCCESSでも要求自体は`DONE`とし、`result_code`へInvocation result code(RETRY_BRAKE作動時は`DONE / RETRY_BRAKE`)、`result_message`へaggregateと`invocation_id`を記録する。**P2-16の例外**として、CLOSEはInvocationを作らない状態変更操作であるが、RunをARCHIVEDにできた部分成功は`DONE / RUN_ARCHIVED_AUDIT_PENDING`または`DONE / RUN_ARCHIVED_LOCK_UNRELEASED`とする。要求のREJECTED/DONEではなく、Run状態が変わったかを基準に分類する。

## 5. ポーラー `poll-requests`

- 新CLIコマンド `ksql-flownet poll-requests`(one-shot: 1回の起動で未処理要求を処理して終了 — cron `*/5`起動。常駐しない。旧poll_controlと同運用)。
- 処理順: `REQUESTED`を作成日時昇順にGET → 1件ずつ: `cancel_requested`があればclaimせずrevision fencingで`CANCELLED / CANCELLED_BY_REQUESTER`へ終端化、なければ`ACCEPTED`へ更新(競合したらスキップ=多重ポーラー安全) → 事前チェック → 子プロセス起動(逐次。並列起動しない) → 結果を`DONE/REJECTED`へ書き戻し。取消は入力不正より優先するが、`cancel_requested`自体の型不正は`REQUEST_INVALID`とする。
- **相関(G-08)**: 子プロセスへ `KSQL_FLOWNET_REQUESTED_BY=app-request:<record_id>:<作成者ログイン名(UTF-8 percent-encode)>`(形式固定。record_idは10進文字列。作成者は偽装不能なシステムフィールドのログイン名/コード。最大長超過は実行せず拒否)。監査4262から要求レコードへ辿れる。
- **fail-closed規律**(旧ポーラーの資産を踏襲):
  - 要求GET失敗(5xx/メンテ) → 何も書かず終了。次回cronが再試行
  - **stale判定(G-05)**: 子プロセス実行中はポーラー親が`claim_heartbeat_at`を定期更新する(heartbeat更新失敗だけでは子をkillしない)。stale回収は「`claim_heartbeat_at`が既定15分(ポーリング間隔5分×3。設定可能)+kintone DATETIME分精度余裕60秒を超過」**かつ**「status詳細JSONで当該Runのlive ownerを確認できない」場合のみ、`REJECTED`(`result_code=STALE`)へ倒す。status取得不能時は何も更新しない。**STALEは「実行有無・結果を確定不能」を意味し、自動再実行はしない**(Run/監査を人が照合するまで再要求禁止 — 文言固定。旧poll_controlのstale→UNKNOWN+チェック解除と同思想。固定30分期限は長時間Network実行と整合しないため不採用)
  - 結果書き戻しの競合は再GET+1回再適用まで(再GETで既に同じ終端値なら成功扱い)
- 環境変数: `KSQL_FLOWNET_REQUEST_APP_ID` / `KSQL_FLOWNET_REQUEST_API_TOKEN`(既存の`.ksql-flownet.env`方式に追記)+allowlist設定(非秘密ファイル)。子プロセスには親の環境をそのまま継承し、`KSQL_FLOWNET_REQUESTED_BY`のみ要求相関値で上書き(cron行の`. /root/.ksql-flownet.env`が正本)。

## 6. 通知(最小)

Phase 1の確認ボード方針を踏襲し、**アプリの一覧**で運用する(通知連携はしない): `01_未処理要求`(REQUESTED/ACCEPTED)、`02_拒否された要求`(REJECTED)。kintoneリマインダー(REQUESTEDが1時間超)は旧ポーラーと同型の任意設定として手順書に記載。

## 7. 受入基準(実機E2E)

1. RERUN要求 → ポーラーが受理 → 失敗Runがresumeされ完走 → 要求が`DONE`、監査4262の`requested_by`が`app-request:<record_id>:<作成者>`形式
2. `rerun_from_node`付きRERUNが`--rerun-from`として効く(冪等ノード)
3. 拒否系: (a)存在しないrun_id (b)終端SUCCESS Run (c)`LIVE`なRun (d)hold中のRunへのRERUN — いずれも`REJECTED`+理由、FlowNet状態は不変
4. STOP要求 → CANCEL_REQUEST作成 → 次ノード境界で停止(`CANCELLED/STOP_REQUESTED`)、要求`DONE`
5. RELEASE要求(採用時) → hold解除 → 後続RERUNが受理される
6. 多重ポーラー模擬(同一要求へ同時claim) → 一方だけが実行、他方はスキップ
7. heartbeatが停止した`ACCEPTED`要求が(非LIVE確認のうえ)`REJECTED(STALE)`へ倒れ、自動再実行されない。**実行済み・未実行の両方を模擬**する。逆に、heartbeat継続中の長時間実行はSTALEにならない
8. 要求GET失敗時(トークン無効で模擬)に何も書かず終了する
9. RETRY_BRAKE作動ノードを含むRERUNが`DONE / RETRY_BRAKE`で記録され、`rerun_from_node`指定の再要求で解除・再実行できる

追加の判定matrix(拒否系の網羅・境界値・情報漏えい防止)は[実装計画](./p2-01-implementation-plan.md)§2.4を正本とし、単体/実機E2Eで満たす。

## 8. 作業分割(想定)

| # | 作業 | 内容 |
| --- | --- | --- |
| 1 | テンプレート | 操作要求アプリのConsoleスクリプト(`templates/create-flownet-request-app.console.js`)+README権限表更新 |
| 2 | poll-requestsコマンド | 要求読取・状態機械・事前チェック・子プロセス起動・書き戻し(単体テスト付き) |
| 3 | E2Eハーネス | E2E用要求アプリ(スパイク環境に新設)+受入1〜8 |
| 4 | 運用文書 | runbook・一次対応1ページへ「アプリからの再開/停止」章、my-ksql-jobsへcron行追加依頼(`*/5`でpoll-requests) |

実装はCodex、レビュー・実機E2EはClaude Code(確立済み分担)。
