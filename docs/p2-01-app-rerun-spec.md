# P2-01: アプリ起点リラン(案B) 仕様書

- 文書状態: **DRAFT**(Phase 2 最初の作業単位。凍結仕様の変更ではなく外付け追加のためFDR再審議は不要 — ただし本仕様の受入合格まで本番profileへ載せない)
- 起案日: 2026-08-31
- 正本参照: [implementation-plan.md](./implementation-plan.md) P2-01/P2-02、[job-network-phase1-spec.md](./job-network-phase1-spec.md) §7.4(PRE-06 = 要求モデルのプロトタイプ)・§7.2(rerun-from)・§5.3(ブレーキ)、[討論記録](./kintone-ops-roadmap-discussion.md) §13.2(設計条件)、my-ksql-jobs `docs/poll_control_setup.md`(旧ポーラーの設計資産)

## 1. 目的と非目的

**目的**: SSH/CLIなしで、kintoneアプリの画面から (a) 失敗Runの再開(リラン)、(b) Run単位の停止要求、を安全な範囲に限って起動できるようにする。旧kSQL-Flowリランポーラー(切替で停止済み)のFlowNet版後継。

**非目的**: resolve-node等の判断を伴う操作のアプリ化(一次対応者のCLI作業のまま)。FlowNet本体(orchestrator/ensure-run)の変更。承認フロー(非冪等の承認はPhase 1決定どおり`--approved-by`のCLI専用)。

## 2. 構成要素

```
[操作要求アプリ(新設・人間が書く)] ←── 一次対応者がレコード追加(要求)
        ↑ 状態更新(受理/結果)
[poll-requests(新設CLIコマンド・cron起動)] ── 子プロセスとして run-network / cancel-run を起動
        ↓
[実行管理4261 / 監査4262(機械専用・既存)]
```

- **機械専用制約の維持**: 実行管理アプリには人間もポーラーも書かない。人間が書くのは操作要求アプリのみ、そこへ機械(ポーラー)が状態を書き戻す(討論§13.2-1と同型の分離)。
- **FlowNet本体無改修**: ポーラーは`run-network`/`cancel-run`を**自分自身のCLIの子プロセス**として起動する(人間と同じ信頼経路・同じ検証を通る。内部APIへ直結しない)。

## 3. 操作要求アプリ(テンプレート新設)

1要求=1レコード。終端後も残す(レコード自体が監査を兼ねる — PRE-06と同思想)。再利用しない(PRE-06のCANCEL_REQUESTは1 Run 1レコード再利用だが、要求アプリは操作履歴が価値のため使い捨て)。

| フィールド | 型 | 書き手 | 内容 |
| --- | --- | --- | --- |
| `request_type` | ドロップダウン | 人 | `RERUN` / `STOP` / `RELEASE` |
| `run_id` | 文字列1行(必須) | 人 | 対象Run(確認ボード/status出力からコピー) |
| `rerun_from_node` | 文字列1行(任意) | 人 | RERUN時のみ有効。`--rerun-from`対象ノード |
| `reason` | 文字列複数行(必須) | 人 | 理由(PRE-06と同じく必須) |
| `request_state` | ドロップダウン | 機械 | `REQUESTED`(初期値) → `ACCEPTED` → `DONE` / `REJECTED` |
| `claimed_at` / `claimed_host` | 日時/文字列 | 機械 | 受理時に記録(stale判定用) |
| `result_code` / `result_message` | 文字列 | 機械 | 実行結果(拒否理由・起動したInvocation ID・Exit Code) |
| 作成者/作成日時 | システム | — | **要求者の真正性の根拠**(偽装不可。専用フィールドで自己申告させない) |

- トークン権限: ポーラー用は**追加なし・読取・編集**(人のレコードを消せない)。人はkintone画面から追加のみ。
- 選択肢は上記のみ(旧poll_control_setup.mdと同じ「選択肢を増やさない」規律)。

## 4. 状態機械と受理範囲

`REQUESTED → ACCEPTED → DONE / REJECTED`(全遷移revision fencing付き。討論§13.2-2どおり案Bの正式版)。

**受理範囲(fail-closed・固定)** — 範囲外は`REJECTED`+理由:

| request_type | 受理条件 | 実行内容 |
| --- | --- | --- |
| `RERUN` | 対象Runが存在し未終端(`FAILED`集約含む再開可能状態)、`activity`が`LIVE`でない、holdされていない(`CANCEL_REQUEST`が`REQUESTED/ACCEPTED`でない) | `run-network --resume-run <run_id>`(`rerun_from_node`指定時は`--rerun-from`付与) |
| `STOP` | 対象Runが存在し未終端 | `cancel-run --run-id <run_id> --reason-file <一時ファイル>` |
| `RELEASE` | 対象Runに`ACCEPTED/REQUESTED`のCANCEL_REQUESTがある | `cancel-run --run-id <run_id> --release --reason-file <一時ファイル>` |

- ポーラーの事前チェックは**一次審査**(親切な拒否理由のため)であり、正の検証はCLI側の既存規則(終端SUCCESS拒否、R2-1の非冪等×既存attempt拒否、RETRY_BRAKE解除は--rerun-fromのみ等)。CLIがExit≠0を返したら`DONE`ではなく`REJECTED`+stderr要約。
- `RELEASE`はバックログ文言(再開+停止)への追加。理由: アプリからSTOPできてRELEASEにSSHが要るのは非対称で、一次対応が完結しない。**採否は本仕様のレビューで決定**(却下ならRELEASE行を削るだけで他へ波及しない)。

## 5. ポーラー `poll-requests`

- 新CLIコマンド `ksql-flownet poll-requests`(one-shot: 1回の起動で未処理要求を処理して終了 — cron `*/5`起動。常駐しない。旧poll_controlと同運用)。
- 処理順: `REQUESTED`を作成日時昇順にGET → 1件ずつ: revision fencingで`ACCEPTED`へ更新(競合したらスキップ=多重ポーラー安全) → 事前チェック → 子プロセス起動(逐次。並列起動しない) → 結果を`DONE/REJECTED`へ書き戻し。
- **相関**: 子プロセスへ `KSQL_FLOWNET_REQUESTED_BY=app-request:<record_id>:<作成者ログイン名>`(形式固定)。監査4262から要求レコードへ辿れる。
- **fail-closed規律**(旧ポーラーの資産を踏襲):
  - 要求GET失敗(5xx/メンテ) → 何も書かず終了。次回cronが再試行
  - `ACCEPTED`のまま残った要求(ポーラー死亡)は、`claimed_at`+受理期限(既定30分)超過で次回ポーラーが`REJECTED`(`result_code=STALE`)へ倒す。**自動再実行はしない**(人が再要求 — 旧poll_controlのstale→UNKNOWN+チェック解除と同思想)
  - 結果書き戻しの競合は再GET+1回再適用まで
- 環境変数: `KSQL_FLOWNET_REQUEST_APP_ID` / `KSQL_FLOWNET_REQUEST_API_TOKEN`(既存の`.ksql-flownet.env`方式に追記)。子プロセスには親の環境をそのまま継承(cron行の`. /root/.ksql-flownet.env`が正本)。

## 6. 通知(最小)

Phase 1の確認ボード方針を踏襲し、**アプリの一覧**で運用する(通知連携はしない): `01_未処理要求`(REQUESTED/ACCEPTED)、`02_拒否された要求`(REJECTED)。kintoneリマインダー(REQUESTEDが1時間超)は旧ポーラーと同型の任意設定として手順書に記載。

## 7. 受入基準(実機E2E)

1. RERUN要求 → ポーラーが受理 → 失敗Runがresumeされ完走 → 要求が`DONE`、監査4262の`requested_by`が`app-request:<record_id>:<作成者>`形式
2. `rerun_from_node`付きRERUNが`--rerun-from`として効く(冪等ノード)
3. 拒否系: (a)存在しないrun_id (b)終端SUCCESS Run (c)`LIVE`なRun (d)hold中のRunへのRERUN — いずれも`REJECTED`+理由、FlowNet状態は不変
4. STOP要求 → CANCEL_REQUEST作成 → 次ノード境界で停止(`CANCELLED/STOP_REQUESTED`)、要求`DONE`
5. RELEASE要求(採用時) → hold解除 → 後続RERUNが受理される
6. 多重ポーラー模擬(同一要求へ同時claim) → 一方だけが実行、他方はスキップ
7. `ACCEPTED`のまま放置した要求が受理期限後に`REJECTED(STALE)`へ倒れ、自動再実行されない
8. 要求GET失敗時(トークン無効で模擬)に何も書かず終了する

## 8. 作業分割(想定)

| # | 作業 | 内容 |
| --- | --- | --- |
| 1 | テンプレート | 操作要求アプリのConsoleスクリプト(`templates/create-flownet-request-app.console.js`)+README権限表更新 |
| 2 | poll-requestsコマンド | 要求読取・状態機械・事前チェック・子プロセス起動・書き戻し(単体テスト付き) |
| 3 | E2Eハーネス | E2E用要求アプリ(スパイク環境に新設)+受入1〜8 |
| 4 | 運用文書 | runbook・一次対応1ページへ「アプリからの再開/停止」章、my-ksql-jobsへcron行追加依頼(`*/5`でpoll-requests) |

実装はCodex、レビュー・実機E2EはClaude Code(確立済み分担)。
