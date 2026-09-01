# P2-08 実機受入記録 M3(2026-09-01)

- 対象: 案A v1 導出プラグイン — [仕様](../../p2-08-activity-plugin-spec.md)受入1〜5 / [実装計画](../../p2-08-implementation-plan.md)§5 M3
- 環境: スパイク実行管理4257(プラグイン適用・「00_Run状況」CUSTOMビュー)/監査4258(プラグイン設定)/profile e2e。プラグインv4(単体358件合格の状態)。CLI照合は`status --json`(同一導出のバンドル元)
- 観測方式: 状態はCLI(ドライバ`tests/e2e/p2-08-driver.mjs`)で作成し、画面はユーザーが目視・スクリーンショット、CLIはClaude Codeが同時間帯に取得して照合

## 受入観測(CLI↔画面)

| 状態 | 作り方 | CLI証跡(UTC) | 画面証跡(判定時刻) | 一致 |
| --- | --- | --- | --- | --- |
| LIVE | 長尺Run連続起動ループ | `netrun_bdaf77a8` RUNNING/LIVE + lock owner/lease (05:15:50) ほか kill直後の`netrun_f22243ad` LIVE (05:18:16) | `p208m3b_i6`がLIVE(緑)+owner/lease根拠 (05:16:09) | 同状態一致(別Run)+同Runはkill直後LIVE窓で成立 |
| STOPPED(既存hold) | P2-01 E2E残置のCANCEL ACCEPTED | `netrun_3b4723a0` RUNNING/STOPPED (05:17:30) | 同Run STOPPED(黄)+「Cancel #872/ACCEPTED/止めた本人に確認」(05:16:09) | **同一Run一致** |
| INTERRUPTED | kill→lease30s+分精度60s失効 | `netrun_f22243ad` LIVE(05:18:49)→**INTERRUPTED(05:19:06)** stale_candidate=true | 同Run INTERRUPTED(赤)+「二次対応者へ連絡」(05:30:21) | **同一Run一致**(失効境界の遷移もCLIで実測) |
| STOPPED(遷移) | 同Runへcancel-run | REQUESTED受理→activity=STOPPED (05:31:46) — cancel優先の凍結規則どおり | 同Run STOPPED(黄)+「Cancel #980/REQUESTED」(05:32:06) | **同一Run一致** |
| RELEASE後 | cancel-run --release | RELEASED→activity=INTERRUPTED (05:40:47) — 解除のフォールバックどおり | (画面観測は省略 — 導出は同一関数) | CLIのみ |
| 終端の非表示 | 完走SUCCESS多数(ループ22周+受入残置) | i2完走直後: status=SUCCESS/activityなし (05:15:36) | ボードに終端Runは1件も表示されず。清掃後は「未終端Runはありません」空状態 (05:56:41) | 一致 |
| 終端の詳細表示 | — | — | (STOPPED Runの詳細でヘッダバッジ表示を確認。終端詳細の「終端(activityなし)」は単体で担保) | 部分 |

- **レコード詳細画面**: STOPPED Runの詳細ヘッダにバッジ+根拠表示を実機確認(スクリーンショット)。ボードのレコード番号リンク(v4追加)経由
- **未実施と理由**: IDLE(started_at null)は実機で安全に作る手段がなく(runは作成と同時に開始される)、共有vector+単体で担保。監査アプリ閲覧権限なしのfail-closedは権限剥奪の実機手順が重く、単体(部分失敗で部分バッジを出さない)で担保。GET限定は型レベル+bundle検査+単体で担保(DevToolsでの実機確認はユーザーへ依頼中 — 確認取得後に本行を更新)
- 判定時刻表示・再読込ボタン・複数回再読込でのDOM非増殖は観測中に随時確認

## 実機ゲートが検出した不具合4件(プラグイン、すべて修正・回帰固定済み)

1. **config.htmlの完全HTML文書化**: kintoneは中身を埋め込むため展開されない → フラグメント化
2. **設定画面の設置タイミング**: DOM挿入前にJSが実行される → DOMContentLoaded遅延
3. **$PLUGIN_IDの遅延読取**: プラグインJSの同期実行中しか有効でない → 読込時捕捉(参考: rex0220製プラグインの実績パターンと同型)
4. **設定画面コードのdesktopバンドル混入**: validateAuditAppIdのimport経由でconfig.tsの設置副作用がdesktop.jsへ同梱され一覧でエラー → 副作用なしのconfig-validation.tsへ分離(エラーURLの`type=DESKTOP_JS`が決め手)

## 付随の発見(E2Eハーネス)

- **kintone `like`演算子は文字列1行フィールドで完全一致相当**(前方一致しない — 実測: `like "KSQL_FLOW_TEST_p208m3"`は`..._p208m3c`に不一致)。共通cleanup(`cleanupM5Records`)のprefix意図が効かず、**接尾辞付きbusiness_keyのRunが歴代E2Eで清掃を逃れていた**(今回ボードに出た残置Runの正体)。実キー列挙方式で38 Run(state105+audit128レコード)を清掃済み。cleanupの恒久修正はM4で実施
- ユーザー要望による改善: ボードへレコード番号列(詳細画面への相対リンク)を追加(v4)
