# R0 P2-11本番適用記録(2026-09-04)

release-plan R0 — P2-11(ボードからのSTART要求)の本番展開。§6.5の順序どおり実施し、当月補正smokeまで合格。

## 実施内容

| 手順 | 実施者 | 内容 |
| --- | --- | --- |
| ① 3欄追補 | ユーザー | `add-start-fields.console.js`を本番操作要求アプリ4268へ適用。適用後にAPIで確認: network_id/business_key/scheduled_forすべて`required=false`、request_typeへSTART追加済み |
| ② プラグイン更新 | ユーザー | R2で再パックしたv1 zipへ更新(署名鍵同一・プラグインID不変)。START許可CSVへ月次案件集計を登録 |
| ③ VPSコード更新 | Claude | /opt/ksql/ksql-flownet を `068a9c5`→`bc25b3f`(v1.0.0 tag候補)へfast-forward、npm ci+build(Node v22.23.2)。`poll-requests --check` 合格 |
| ④ allowlist | Claude | `/root/flownet-request-allowlist.yaml` のmonthly_deal_summaryへ`app_start: true`追加(バックアップ同`.bak-20260904`、`cat -A`でLF確認)。追加後`--check`合格 |
| ⑤ 当月補正smoke | ユーザー起票+Claude確認 | 下記 |

## smoke結果(要求#3)

- ボードから補正モードで起票: business_key=`monthly_deal_summary@2026-09-correction-1`、対象期間=当月(2026-09-04 00:00 JST)
- ポーラー(5分cron)がclaim→処理: `requested=1 claimed=1 completed=1`
- 要求`DONE / OK`、`aggregate=SUCCESS; invocation_id=invoke_1fb769c8-...`
- state実体(4261): `netrun_73d7d0f9` NETWORK_RUN=SUCCESS、intake_gate/test_data_gate/monthly_deal_summary 3ノードすべてSUCCESS
- 補正Runは当月の冪等リフレッシュ(現行値と同値のUPSERT)であり業務値への影響なし

## 発見・修正(2件)

1. **ポーラーcronのenv不足(本番設定不備 — コード変更なし)**: ポーラーcronは`/root/.ksql-flownet.env`のみをsourceしており、kSQL-Flowが必要とする業務トークン(`KSQL_TOKEN_DEALS`等 — my-ksql-jobs/.env側)が子プロセスへ渡らず、STARTのpreflight(`describe-profile`)がexit 1→要求#2が`REJECTED / KSQL_FLOW_EXIT_MISMATCH`。月次cronは`run_flownet.sh`が`--env-file=.env`を使うため発生せず、9/1のRERUN smokeは一次審査拒否(子プロセス未起動)だったため露見しなかった。**修正**: ポーラーcron行へ`node --env-file=.env`を追加(crontabバックアップ: `/root/crontab.bak-20260904`)。修正後にdescribe-profile/inspect-job/`--check`合格を確認
2. **誤起票の清掃**: 1回目の起票がE2E(スパイク)側ボードから行われE2E要求アプリへ入った(#141)。本番ポーラーの監視対象外のため、当該1件のみ・未claimを照合のうえ削除し、本番ボードから再起票

## 構成メモ

- VPS: vm-69245b5e-30。FlowNet=`bc25b3f`、kSQL-Flow=0.7.0(node_modules方式 — 本networkはCSV機能を使わないため更新不要。CSV対応networkを本番へ載せる際は@0.9.0へ更新)
- cron: 月次`0 7 1 * *`(run_flownet.sh)/ポーラー`*/5 * * * *`(--env-file=.env付き)
- 切戻し: allowlistの`app_start: true`を外せばSTART受付は即closed(要求はNETWORK_NOT_ALLOWEDで拒否記録)
- 本記録はdocsのみの変更であり、R2凍結コミット(`bc25b3f`)のコード面は不変
