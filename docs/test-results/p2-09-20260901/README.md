# P2-09 実機受入記録 M3(2026-09-01)

- 対象: ボードからの操作要求起票 — [仕様](../../p2-09-board-request-spec.md)受入(§6)/[実装計画](../../p2-09-implementation-plan.md)
- 環境: スパイク実行管理(プラグインv5・設定=監査+操作要求アプリ)/E2E操作要求アプリ/profile e2e。単体390件合格の状態
- 方式: 状態作成とポーラー実行はClaude Code(`tests/e2e/p2-09-driver.mjs`)、ボタン操作・画面確認はユーザー、結果照合はCLI+要求レコード

## シナリオと結果(すべて合格)

| シナリオ | 操作(ユーザー・ボードから) | 結果(要求レコード/Run) |
| --- | --- | --- |
| A: FAILED→リラン完走 | 要対応(終端)のFAILED行→リラン要求→起票→**処理待ちバッジ「要求処理待ち #28」表示確認**→ポーラー | #28 `RERUN DONE/OK` **作成者=rex0220**(真正性)、resume完走`aggregate=SUCCESS`、行消滅 |
| B-1: INTERRUPTED→リラン(1回目) | kill済みRunのINTERRUPTED行→リラン要求 | #29 **`REJECTED / LOCK_CONFLICT`**(Invocation作成前拒否) — kill Runのstale lockはforce-unlock(二次対応者CLI・停止確認必須)が先に必要。**「リラン→REJECTEDなら連絡」のエスカレーション文言が受け止める実ケースを実機確認** |
| B-2: force-unlock後のリラン(2回目) | 同行→リラン要求 | #30 `RERUN DONE/OK` — 裁定が**ジョブログの実証拠で確定**し、UNKNOWNへ倒れず再実行→SUCCESS完走(裁定機構の良性パス) |
| C-1: LIVE→停止 | lease120秒fixtureのLIVE行→停止要求(約3分の観測窓) | #31 `STOP DONE/STOP_REQUESTED`、Run=STOPPED(hold) |
| C-2: STOPPED→解除 | 解除要求ダイアログに**停止要求者`app-request:31:rex0220`+停止理由+「本人に確認しましたか?」+「解除後、次の定期resumeが再開し得ます」表示をスクリーンショット確認**→起票 | #32 `RELEASE DONE/RELEASED`(自動再開なし — Run=INTERRUPTEDへ) |
| C-3: UNKNOWN表示 | (unlock+CLI resumeで裁定が証拠を見つけられずRun=UNKNOWN化 — B-2と逆の実ケース) | 要対応(終端)に**UNKNOWN行: リランボタンなし+「二次対応者へ連絡」+Run IDコピー**をスクリーンショット確認。**コピーボタンの実動作も確認**(貼り付けられたIDが正)。単体担保のみの想定だったUNKNOWN表示を実機観測できた |

付随確認: 2セクション表示・各セクションの空状態文言・シナリオ完了後の行消滅・要求作成者=ログインユーザー(全5件)・pendingバッジ。要求レコード#28〜#32はE2E操作要求アプリに証跡として残置。

## 補足

- B-1/B-2/C-3で、**同じ「kill後リラン」でも裁定結果が分かれる**(ジョブログ証拠あり→自動完走/なし→UNKNOWN→resolve要)実挙動を初めて連続観測。§5のエスカレーション文言(result_codeがOK以外→連絡)の妥当性を裏付ける
- 清掃はP2-08 M4で修正したprefix cleanup(`cleanupM5Records`のstartsWith方式)で実施 — 1回の前方一致で3 scope・state9+audit17を回収(修正の実地検証)
- 未実施: 403(追加権限なし)分岐・重複ガードfail-open・30セル網羅は単体担保(仕様受入13/14どおり)。observation用fixture(`network-p209-live.yaml` lease120秒)とドライバはリポジトリへ収録
