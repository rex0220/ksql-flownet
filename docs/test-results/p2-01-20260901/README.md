# P2-01 実機E2E受入記録(2026-09-01)

- 対象: アプリ起点リラン(案B) — [仕様](../../p2-01-app-rerun-spec.md)受入1〜9 / [実装計画](../../p2-01-implementation-plan.md)§5 M3
- 環境: profile=e2e / E2E操作要求アプリ=4267(kSQL-FlowNet 操作要求 P2-01 E2E) / state=4257 / audit=4258 / JOBログ=4264 / ksql-flow 0.7.0
- ブランチ: feat/p2-01-app-rerun(単体325件合格の状態)

## 結果: 6本全合格(受入1〜9充足)

| スクリプト | 受入 | 結果 | 結果JSON(tests/e2e/results/) |
| --- | --- | --- | --- |
| p2-01-01-rerun | 1 | 合格 | 2026-09-01T00-33-45.037Z |
| p2-01-02-rerun-from | 2・9 | 合格 | 2026-09-01T00-13-19.420Z |
| p2-01-03-rejections | 3 | 合格 | 2026-09-01T00-14-50.303Z |
| p2-01-04-stop-release | 4・5 | 合格 | 2026-09-01T00-15-33.897Z |
| p2-01-05-claim-stale | 6・7 | 合格 | 2026-09-01T00-23-06.974Z |
| p2-01-06-get-failclosed | 8 | 合格 | 2026-09-01T00-24-51.226Z |

## 実機ゲートが検出した不具合2件(いずれも修正・回帰固定済み)

1. **E2Eハーネス**: scope全体をjob_idへ前置するとksql-flowのジョブロックキー上限(`{profile}:{job_id}` ≦ **64 UTF-16単位**、ksql-flow `src/jobkey.ts`のkintone一意フィールド実測)を超え、n2以降がVALIDATION_ERROR。製品はfail-closedで正しく拒否していた(ポーラーもG-07どおり`DONE/NODE_FAILED_OR_BLOCKED`を記録)。→ job_idの前置を`KSQL_FLOW_TEST_`+scope短縮ハッシュへ変更し、60文字assertを追加。**運用への含意: 本番のnetwork定義でも`profile:job_id`が64文字を超えると実行不能**(validate段階では検出されない — M4文書へ記載)
2. **M2実装漏れ(仕様G-07)**: RETRY_BRAKE作動時に要求result_codeを`RETRY_BRAKE`にする規定に対し、`run-network --json`にブレーキ情報がなく分類不能だった。→ scheduler summaryへ読み取り専用`retryBrakeNodeIds`を追加(挙動変更なしの報告拡張 — 本体無改修原則から`--json`と同じ扱いで明示分離、実装計画§2.5追記)、`--json`へ`retry_brake_node_ids`、分類器で`DONE/RETRY_BRAKE`へマップ

## 本番接続記録(2026-09-01、ユーザー承認のうえSSHで実施)

- 本番操作要求アプリ=**4268**(テンプレートから作成、全10フィールド・初期値REQUESTED・一覧2件をAPI検証合格)。ポーラートークンは閲覧・編集のみ(追加・削除なし)
- VPS(vm-69245b5e-30): ksql-flownet main 068a9c5へ更新・build。`/root/.ksql-flownet.env`へ要求アプリ3変数を追記(0600)、allowlist=`/root/flownet-request-allowlist.yaml`(monthly_deal_summaryのみ)
- `poll-requests --check` 合格(networks=1, request_app=readable)。**発見**: PowerShell経由のenv追記でCRLFが混入しALLOWLIST_UNREADABLEになった(sed -i 's/\r$//'で解消 — VPSのenvファイルを編集する際の注意点)
- cron追加: `*/5 * * * * . /root/.ksql-flownet.env && cd /opt/ksql/my-ksql-jobs && node /opt/ksql/ksql-flownet/dist/cli/index.js poll-requests >> /var/log/ksql/flownet-requests.log 2>&1`(crontabバックアップ: /root/crontab.bak-20260901)
- 手動1回実行: `requested=0 claimed=0 ... Exit 0`
- **本番スモーク(同日、ユーザー実施)**: 完走済み8月Run(`netrun_9b5e94c6`)へのRERUN要求を画面から作成 → 次のcronサイクルでポーラーが処理(`requested=1 claimed=1 completed=1`)し、`REJECTED / RUN_STATUS_NOT_RERUNNABLE`(Run status SUCCESS is not rerunnable)で終端。FlowNet状態は無変更(一次審査での拒否のため子プロセス未起動)。要求→claim→審査→拒否記録の本番経路全体を実弾確認

## テンプレート実機適用で検出した不具合3件(アプリ作成時、修正・回帰固定済み)

- `kintone.api.url`への生パス渡し(`/k/v1`+`.json`欠落)で最初のAPI呼出しが失敗
- 一覧`sort`に`$id`・複数キーを指定(一覧定義では不可)
- 一覧定義に必須の`name`プロパティ欠落(GAIA_VI03)
- 付随修正: kintoneエラー詳細のJSON表示化(`[object Object]`潰れの解消)、一覧設定からの再開スクリプト`templates/finish-request-app-views.console.js`追加
