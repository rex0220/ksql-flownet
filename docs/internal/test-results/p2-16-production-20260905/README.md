# P2-16 本番適用記録(2026-09-05)

release-plan R1.5「本番適用」。P2-16(操作要求ライフサイクル v2: CLOSE・claim 前取消・終端 hold 解除)を本番へ展開し smoke 合格。

## 実施内容

| 手順 | 実施者 | 内容 |
| --- | --- | --- |
| ① VPS コード更新 | Claude | /opt/ksql/ksql-flownet を `92bad60`(main・P2-16 M0〜M5 取り込み)へ fast-forward、npm ci+build。`poll-requests --check` 合格。要求アプリ追補前でも旧スキーマで動く後方互換(`cancel_requested` 欠落=未取消)を確認 |
| ② 要求アプリ追補 | ユーザー | 本番操作要求アプリへ `add-request-lifecycle-v2.console.js` を適用(CLOSE/CANCELLED 選択肢・`cancel_requested`・`03_取消済み`・フィールド権限)。API で確認: request_type に CLOSE、request_state に CANCELLED、`cancel_requested` CHECK_BOX `["取消"]`、一覧 3 種 |
| ③ プラグイン更新 | ユーザー | version 1(署名鍵同一・プラグイン ID 不変)。起動ログ `plugin v1 loaded` を確認 |
| ④ smoke | ユーザー起票+Claude 確認 | 下記 |

## smoke 結果(要求 #4)

- ボードから補正 START を起票(`monthly_deal_summary@2026-09-correction-1`・対象期間 2026-09-05)し、直後にボードの「取消」→ 確認ダイアログ(不可逆の警告)→「取消を受け付けました。次のポーラー周期で CANCELLED になります」
- 次の 5 分 cron でポーラーが claim せずに終端化: `requested=1 claimed=0 cancelled=1`
- 要求 #4: `CANCELLED / CANCELLED_BY_REQUESTER`、`claimed_at` 空、`result_message = requester cancelled before claim`。Invocation・Run とも作成なし(何も実行していない)
- 補正キーが `-1`(9/4 実行済み)のままだったが、claim 前取消のため重複ガード・ensure-run 裁定には到達しない。取消経路の smoke としては十分

CLOSE・終端 hold 解除は本番に対象 Run(FAILED/CANCELLED)が無いため本番 smoke は行わず、M3 実機 E2E(p2-16-03/04/05)と M4 ボード受入を根拠とする。

## 発見・修正(1 件)

- **プラグイン起動ログの版表示**: `desktop.ts` にハードコードされた `plugin v2 loaded` が manifest(1)と食い違っていた(P2-09 時代の名残)。build 時に manifest の `version` を `__PLUGIN_VERSION__` として埋め込む修正(`9c55731`)を入れ、再配布して `plugin v1 loaded` を確認。R2 記録に例外扱いを明記

## 構成メモ

- VPS: FlowNet `92bad60` 以降(main)。cron 2 本は不変(月次 `0 7 1 * *`、ポーラー `*/5` with `--env-file=.env`)
- 本番要求アプリの ACL: 機械 6 フィールド=everyone 閲覧のみ、`cancel_requested`=作成者編集可+everyone 閲覧のみ。API トークン書込は影響を受けない(E2E で確認済み)
- 切戻し: プラグインは旧 zip の再読込、要求アプリの追加項目は残しても旧ポーラーは無視する(`CLOSE` 要求は旧ポーラーでは `REQUEST_INVALID`)
