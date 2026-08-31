# 初回本番導入計画: 月次案件集計バッチ

- 文書状態: **PLAN**(Dq-4決定の記録と切替手順)
- 決定日: 2026-08-31(ユーザー承認)
- 対象業務: **月次案件集計バッチ**(my-ksql-jobs `jobs/` 3ジョブ) — PRE-05棚卸し([pre-05-inventory.md](./pre-05-inventory.md))で全ノード冪等を確認済み
- 手順の正本: [移行runbook](./runbook-phase1-migration.md)(切替・切戻し)、[復旧runbook](./runbook-phase1-recovery.md)(障害時)、[一次対応1ページ](./ops-first-response.md)

## 1. Dq-4の最終決定(記録)

| 項目 | 決定 |
| --- | --- |
| (1) 初回導入の対象業務 | 月次案件集計バッチ(全ノード冪等) |
| (2) 承認者の割当 | **初回導入では不要**(非冪等ノードが存在しないため`--approved-by`が要る場面が発生しない)。非冪等業務を載せる時点で再決定 |
| (3) 縮退運用 | 同上により初回は不要 |
| (4) ベンダー関与 | 未定のまま進行(討論§11.3。二次対応者は開発者本人) |
| 定義レビュー体制(vision §4提案) | **採用**: 定義の追加・変更は二次対応者(当面は開発者)の`idempotent`宣言レビュー(7項目基準)を通過するまで本番profileへ載せない |

## 2. ジョブネット定義

定義ファイル: `my-ksql-jobs/flownet/network-monthly-summary.yaml`(SQLは既存`jobs/`を相対参照 — 二重管理しない)

- DAG: `intake_gate → test_data_gate → monthly_deal_summary`(現行run-allのファイル名順直列を明示依存に写像)
- 全ノード `idempotent: true`(根拠: pre-05-inventory.md)
- `business_key_policy: scheduled_period / month / Asia/Tokyo`。cron入口は`--resume --scheduled-for <月初>`
- **実運用lease値の決定(FDR D-29残余1)**: `lease_duration_sec: 300` / `heartbeat_interval_sec: 60`。根拠: 現行3ジョブの実行は秒〜分オーダー(最長timeout 600秒)、heartbeat ≤ lease/3を満たし、一時的なAPI遅延(実測の断続5xx数分)をlease内で吸収できる余裕を持つ。初回張り付き期間の実測で見直す

## 3. 本番アプリとトークン

- 実行管理/監査履歴: **テンプレートから作成済みの「kSQL-FlowNet 実行管理」「kSQL-FlowNet 監査履歴」**(2026-08-31作成)を本番用とする。適用が必要な追補: `add-cancel-request-option.console.js`(CANCEL_REQUEST選択肢)と`add-triage-views.console.js`(確認ボード3一覧) — スパイクアプリには適用済みだが**本番2アプリへは未適用**
- APIトークン: 実行管理・監査履歴とも追加/読取/編集(**削除なし** — templates/README.md権限表どおり)。値はOS環境変数のみ(リポジトリ・.env平文へ置かない)
- 業務アプリ(顧客管理4246/案件管理4247)・JOBログ(4249)は現行トークンのまま。**4249はE2E(スパイク環境)と共有**: Job lockの一意性のため意図的な設計(D-08/D-26)。条件=E2Eは本番job_idを使用しない(tests/e2e/README「同居条件」)。実害はログ混在ノイズのみで、一次対応者は4249を参照しない
- 本番アプリID(2026-08-31確定): **実行管理=4261 / 監査履歴=4262**(フィールド構成・追補・一覧のAPI検証合格)

## 3.5 my-ksql-jobs側の受け入れ準備(2026-08-31完了 — 返信: my-ksql-jobs/docs/kSQL-FlowNetへの返信-20260831-初回導入.md、コミットb33a9d4)

- network-monthly-summary.yamlレビュー・コミット済み。**idempotent宣言3件をジョブ実装オーナーが承認**(棚卸しと独立にSQL突合+UPSERTキー「会社名」の重複禁止=YESを4246実測で確認)
- 起動スクリプトrun_flownet.sh/.bat新設(git cloneしたksql-flownetのdist直接起動、KSQL_FLOWNET_DIR既定../ksql-flownet、当月初+09:00自動計算、SCHEDULED_FORで上書き)
- 切替準備手順をmy-ksql-jobs/docs/runbook.md §5へ整理(旧run_batch.shは削除せず参照除去で無効化)
- **実態訂正**: 現VPSに日次run_batch cronは未設定(稼働はリランポーラーのみ)。切替は「cron差替え」ではなく**「ポーラー停止+FlowNet cron行の新設」**
- 注意: run_flownet.batの当月初自動計算はホストJST前提(JST以外はSCHEDULED_FOR明示)

## 4. 切替チェックリスト(移行runbook準拠)

- [ ] 本番2アプリへ追補2本(CANCEL_REQUEST選択肢・確認ボード3一覧)をConsole適用
- [ ] 本番2アプリのトークン発行→実行環境のOS環境変数へ設定(`KSQL_FLOWNET_*`)
- [ ] `validate`/`plan`で定義検証、`run-network`を試験business key(過去月バックフィル)で1回実行し完走確認
- [ ] 一次対応1ページの連絡先欄を記入
- [ ] **未完了の旧run-allバッチ0件を確認**(4249でRUNNINGなし)
- [ ] **ポーラー停止+FlowNet cron行の新設**(run_flownet.sh経由。現VPSにrun_batch日次cronは元々なし — my-ksql-jobs返信§4-1の実態訂正)。旧run_batch.shは削除せず全スケジューラからの参照除去で無効化
- [ ] 張り付き期間開始(推奨: 月次2サイクル)。撤退条件はvision §5のとおり(二重書込み1件/一次対応が回らない/FlowNet起因の締切逸失 → 切戻し手順)

## 5. 導入後の観測

- 実測項目([4]の入力): 手動介入回数(`requested_by`がcron以外のInvocation)、RETRY_BRAKE発生数、UNKNOWN/resolve件数、control_plane_api_calls、Run所要時間
- 案B・並列化・案Cの判定閾値は実測着手前に合意(vision §9)
