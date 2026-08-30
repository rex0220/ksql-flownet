# Phase 1 受入マトリクス(QA-01)

仕様 `docs/job-network-phase1-spec.md` §12 の受入基準28項目と、自動試験・実機試験の対応表。M7ゲートの正本。

環境: devenxyfi.cybozu.com(スパイクアプリ)、実kSQL-Flow(node dist/cli.js)、Windows 11。実行回数は各証跡JSON内に記録。unit=`npm test`(毎PR実行)、E2E証跡=`docs/test-results/`配下。

| # | 受入基準(要約) | 方法 | 証跡 | 状態 |
| --- | --- | --- | --- | --- |
| 1 | 中間失敗→下流BLOCKED | E2E | m5-mid-failure、m6-01 | 済 |
| 2 | resumeでrun_id不変・invocation_id増加 | E2E | m6-01 | 済 |
| 3 | SUCCESS済みノードに新Attemptなし | E2E | m6-01 | 済 |
| 4 | 失敗attempt1と成功attempt2が両方残る | E2E | m5-lock-conflict(PREPARE_FAILED attempt+SUCCESS attempt、番号非再利用) | 済 |
| 5 | resumeは保存済みSQLを実行(作業ツリー変更を無視) | E2E | m7-01(作業ツリーを成功版へ改変してもresumeが保存済み失敗SQLを実行) | 済 |
| 6 | bundleハッシュ不一致でfail-closed | unit | bundle-builder tamper系(tests/unit) | 済 |
| 7 | CANCELLED/UNKNOWNはall_success不成立・SKIPPED非生成 | unit+E2E | scheduler unit、m6-02(UNKNOWN→BLOCKED) | 済 |
| 8 | stale→UNKNOWN、停止確認なしでresumeしない | E2E+unit | m6-04(LEASE_STILL_ACTIVE/孤児UNKNOWN)、STOP_NOT_CONFIRMED unit | 済 |
| 9 | 非冪等UNKNOWN/FAILEDの自動リランなし | E2E | m6-03 | 済 |
| 10 | node_id≠job_idでも同job_id単体ジョブとNodeロック排他 | E2E | m5-lock-conflict | 済 |
| 11 | --scheduled-forのbusiness key決定性(月跨ぎ/年跨ぎ/TZ境界)とresume分岐 | unit+E2E | business-key unit(境界値)、ensure-run unit(0/1/完了/複数)、m6-01 | 済 |
| 12 | --rerun-fromの子孫限定・非冪等/終端SUCCESS拒否 | unit | FN-11 unit(descendants、拒否5種) | 済 |
| 13 | R1重複Run作成不能 | 実機 | M3ゲート(createRun裁定、record_key=R1) | 済 |
| 14 | 開始時エラー(lock/snapshot/ログ)のfail-closed | unit+実機 | preflight/ensure-run unit、M4ゲート | 済 |
| 15 | max_active_runs超過で新規作成せず阻害run_id返却 | unit | ensure-run unit | 済 |
| 16 | 手動解決はAttempt不変+監査追記、補償のみでSUCCESS不可 | E2E+unit | m6-03(監査全項目)、resolve-node unit | 済 |
| 17 | UNKNOWN下流BLOCKED・独立系統継続・集約UNKNOWN | E2E | m6-02 | 済 |
| 18 | RECONCILIATION_REQUIRED一意修復不能時fail-closed | unit+実機 | reconciliation unit、M4ゲート | 済 |
| 19 | 集約状態の決定的算出・lock保持者のみrevision付き更新 | unit | run-aggregate unit(§10表全行)、scheduler unit | 済 |
| 20 | describe-profile現在値≠snapshotでSQL開始しない | unit | preflight unit(実出力fixture) | 済 |
| 21 | job_id不一致・未承認非決定要素のbundle時拒否 | unit | preflight/bundle unit(KSQL1306超過承認ガード含む) | 済 |
| 22 | revision/attempt_key競合・INSERT応答消失で重複attempt実行なし | unit+実機 | in-memory/kintone unit、M3ゲート(GAIA_CO02/DA02裁定) | 済 |
| 23 | EXECUTION_STARTED未確認でSQL不開始・結果欠損は2マーカーでUNKNOWN | E2E | m5-kill-unknown、m6-04(孤児裁定) | 済 |
| 24 | LOCK_CONFLICTでCANCELLED/PREPARE_FAILED+WAITING・番号非再利用 | E2E | m5-lock-conflict | 済 |
| 25 | FlowNet kill→stale候補・停止確認なし回収拒否・回収後旧owner排除・照合不能UNKNOWN | E2E+実測 | m6-04、Spike F(lease-token-fencing) | 済 |
| 26 | kintone一時断でdrain(新Node開始なし・subprocess非kill・再更新成功時のみ保存・不能時無書込) | E2E | m7-02(回復系=保存+NETWORK_LEASE_INTERRUPTED終端、非回復系=無書込) | 済 |
| 27 | status --jsonの復旧識別子返却・無変更 | E2E | m6-05($revision全件前後比較) | 済 |
| 28 | Cloud Run terminal限定受理・fail-closed・control_plane_api_calls別計測 | unit+E2E | 判定表unit、m6-06、m7-03(URL分類別呼出数を証跡へ記録) | 済 |

## 判定(2026-08-31)

**28項目すべて「済」。** 公式実行: m6スイート6本+m7スイート4本を最終ビルドで直列実行し全合格(証跡: `docs/test-results/m7-qa01-20260831/`、M6分は`m6-gate-20260830/`も参照)。diamond全SUCCESS(m7-01)によりM5ゲートの限定事項も解除。

m7実機判定が捕捉し修正した製品ギャップ2件(FDR反映対象):

1. 受入26のdrain配線欠落 — node実行中のcontrol-plane到達不能が即時abortしていた → LEASE_UNCERTAIN遷移+2秒間隔・lease時間上限のlease再確認リトライ、再確認成功時のみ保存、上限で無書込放棄
2. 仕様424行後段の未実装 — 放棄InvocationがRUNNINGのまま残置 → resume時に`CANCELLED / NETWORK_LEASE_INTERRUPTED`+`INVOCATION_FINALIZED`監査で終端

## M7で追加実施した試験

- **m7-01a**: diamond全SUCCESS完走(M5ゲートの限定事項解除。分岐・合流・複数開始点の正常系)
- **m7-01b**: 受入5 — Run作成後に作業ツリーSQLを成功版へ書換え→resumeが保存済み失敗SQLを実行(誤合格しにくい向きで固定)
- **m7-02**: 受入26 — FlowNetプロセスのkintone通信だけを窓時間遮断(実kSQL-Flow subprocessは無傷で完走)し、(a)回復→結果保存+`CANCELLED / NETWORK_LEASE_INTERRUPTED`終端、(b)非回復→状態無書込、を実機検証
- **m7-03**: 受入28後段 — control_plane_api_calls計測(通常Run・heartbeat・status・force-unlock停止確認のAPI呼出数をURL分類で記録)
- **m7-04**: Windows実機の停止試験 — SIGBREAK配送後の安全状態(不整合な終端なし)と孤児回収(Invocation終端含む)を確認(Unix側は残余リスクとして記録)

## 対応しない/残余リスク(§11.2・FDR限定事項)

- 実GCP Cloud Run Execution照会(D-29限定。運用導入時にrunbookで確認)
- 複数ホスト停止確認(手動運用)
- Unix実機停止試験(Windows環境のみ。run-subprocessのgraceful→forced経路はunitで担保)
- 現行status移行fixtureは全14ケース+異常系をunitで毎PR実行(tests/unit/status-migration.test.mjs)
