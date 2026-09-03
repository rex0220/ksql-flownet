# FDR反映提案 2026-08-31: Phase 1凍結(FDR ACCEPTED化)

状態: REFLECTED(2026-08-31承認・実施済み。FDR ACCEPTED化・仕様凍結版昇格を同一コミットで実施)
前提: QA-01受入28/28済(`docs/internal/acceptance-phase1.md`、証跡`docs/internal/test-results/m7-qa01-20260831/`)、M0〜M7全マイルストーン完了。

## A. QA-01結果のFDR反映(m7実機が捕捉した製品ギャップ2件)

D-29節へ2026-08-31追記: (1)受入26のdrain配線(到達不能→LEASE_UNCERTAIN→2秒間隔・lease時間上限のlease再確認リトライ→成功時のみ保存+`CANCELLED / NETWORK_LEASE_INTERRUPTED`終端、上限で無書込放棄)を実装し実機注入で確認。(2)放棄Invocationのreconciliation終端(`INVOCATION_FINALIZED`監査)を実装しSIGBREAK実機で確認。control_plane_api_calls計測をm7-03証跡へ記録。

## B. 凍結ゲートのクローズ(証跡対応表)

| ゲート                                     | 証跡                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| D-07 SoT・Attempt lifecycle                | 仕様§5/§6実装+受入4/16/22(unit+実機)。レビュー承認=本凍結承認をもって充足                                             |
| D-09 障害注入                              | M3/M4ゲート(競合・修復)、m7-02(一時断)、m6-04(kill)                                                                   |
| D-12 bundle容量・保持・archive・復元       | 下記決定1で決定                                                                                                       |
| D-13 UNKNOWN解決権限・監査主体             | 下記決定2で決定                                                                                                       |
| D-14 新旧lock protocol移行方式             | 下記決定3で決定                                                                                                       |
| D-15 コマンド所有境界統一                  | CLI help=Control Plane 7コマンドのみ、Execution Plane(run/inspect-lock等)非混入を確認(2026-08-31)                     |
| D-16/1098 Nodeロック競合                   | m5-lock-conflict(node_id≠job_id、受入10/24)                                                                           |
| D-17 describe-profile照合                  | preflight unit(実出力fixture、受入20)                                                                                 |
| D-18 非冪等手動完遂・補償区別・SKIPPED予約 | m6-03+resolve-node unit+移行fixture(skipped拒否)                                                                      |
| D-19 終端SUCCESS rerun拒否                 | FN-11 unit(受入12)                                                                                                    |
| D-20 期間境界・max_active_runs             | business-key/ensure-run unit(受入11/15)                                                                               |
| D-21 UNKNOWN分離                           | m6-02(受入17)                                                                                                         |
| D-23 inspect-job検査・例外manifest         | preflight unit(KSQL1306超過承認ガード、受入21)                                                                        |
| D-26 Job lock回復契約                      | kSQL-Flow M1完了報告(inspect-lock/force-unlock-jobのcontract test)+m6/m7実機での回復実施+record-job-unlock監査(FN-12) |
| D-27 legacy非変換                          | ensure-runはR1(NETWORK_RUN record_type)のみ検索し、監査参照レコードは構造上resume判定に入らない+移行runbook           |
| D-28 read-only CLI                         | m6-05($revision全件前後比較)。validate/planはkintone接続自体を持たない                                                |
| 移行fixture全件(1094)                      | unit全14+fail-closed 5(毎PR実行)                                                                                      |
| ensure-run 4分岐(1095)                     | unit+M3/M4ゲート+m6-01                                                                                                |
| snapshot fail-closed(1096)                 | bundle tamper unit+m7-01b(受入5/6)                                                                                    |
| 残余リスク反映(1099)                       | acceptance-phase1.md+runbook 2冊+FDR各節                                                                              |

## C. 決定3件(承認対象)

1. **D-12**: bundle容量はSpike B実測(ZIP添付、数KB〜数十KB規模)を基準とし、保持はRunレコードと同寿命(削除しない=監査保持)。kintoneのアプリ/スペース標準のバックアップ運用に従い、復元はSpike Bで実測済みの添付再取得手順(再GETでfileKey取得→download)。大容量化時の閾値見直しはPhase 2事項。
2. **D-13**: UNKNOWN解決の認証主体は環境変数`KSQL_FLOWNET_SERVICE_PRINCIPAL`/`KSQL_FLOWNET_REQUESTED_BY`(配備単位で運用者へ割当)。非冪等SUCCESSは別主体`--approved-by`必須。全操作は監査レコード必須(FN-12実装・m6-03実機済)。具体的な担当者割当は導入時の運用設定とする。
3. **D-14**: 旧lock protocolからの段階移行は行わない。切替は業務(ジョブ群)単位で行い、同一業務の新旧並走を残さない(移行runbook正本)。同一`job_id`の防波堤はkSQL-Flow所有のNode lockが新旧共通で担う。

## D. 凍結アクション(承認後に同一コミットで実施)

1. FDRを`ACCEPTED`へ変更
2. 仕様書へ「Phase 1 凍結版」表記(job-network-phase1-spec.md冒頭)
3. version記録: 実装0.1.0 / schema_version 1 / JOBログ相関=kSQL-Flow M1(templates/README.md対応表を正)
4. 受入試験結果(acceptance-phase1.md)と復旧訓練記録(m6-gate/m7-qa01証跡)への参照を追加

## E. 凍結後も残る限定事項(変更なし・記録済み)

実GCP Cloud Run照会 / 複数ホスト停止確認 / Unix実機停止試験 / 実運用スケール長時間Run / lease実運用値の本番調整 / schema v2専用フィールド / npm公開はリリース検証後(private維持)
