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
- 業務アプリ(顧客管理4246/案件管理4247)・JOBログ(4249)は現行トークンのまま

## 4. 切替チェックリスト(移行runbook準拠)

- [ ] 本番2アプリへ追補2本(CANCEL_REQUEST選択肢・確認ボード3一覧)をConsole適用
- [ ] 本番2アプリのトークン発行→実行環境のOS環境変数へ設定(`KSQL_FLOWNET_*`)
- [ ] `validate`/`plan`で定義検証、`run-network`を試験business key(過去月バックフィル)で1回実行し完走確認
- [ ] 一次対応1ページの連絡先欄を記入
- [ ] **未完了の旧run-allバッチ0件を確認**(4249でRUNNINGなし)
- [ ] リランポーラー(`--resume-batch`)を停止し、cronを`run_batch.sh`から`ksql-flownet run-network ... --resume --scheduled-for`へ切替(旧経路は無効化 — 並走禁止)
- [ ] 張り付き期間開始(推奨: 月次2サイクル)。撤退条件はvision §5のとおり(二重書込み1件/一次対応が回らない/FlowNet起因の締切逸失 → 切戻し手順)

## 5. 導入後の観測

- 実測項目([4]の入力): 手動介入回数(`requested_by`がcron以外のInvocation)、RETRY_BRAKE発生数、UNKNOWN/resolve件数、control_plane_api_calls、Run所要時間
- 案B・並列化・案Cの判定閾値は実測着手前に合意(vision §9)
