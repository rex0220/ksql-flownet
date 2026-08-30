# M3 実機統合試験

M3完了ゲートを、`pretest`/`build`で生成した`dist/`の製品コードに対して検証する手動実行用スクリプトです。`npm test`には含めません。

## 前提

- Node.js 22以上を使用する。
- `.env.example`を基に`.env`へ2アプリ構成の`KSQL_SPIKE_BASE_URL`、`KSQL_SPIKE_APP_EXEC`、`KSQL_SPIKE_APP_AUDIT`、書込み・閲覧・削除可能な`KSQL_SPIKE_TOKEN_EXEC`と`KSQL_SPIKE_TOKEN_AUDIT`を設定する。
- AUDITアプリのNode Attemptに`state_revision_before`フィールドを追加済みにする。
- アプリ4246、4247、4249は指定しない。スクリプトもこれらのIDを拒否する。
- 最初に`npm run build`を実行し、試験時点の製品コードを`dist/`へ生成する。

## 実行順

各コマンドは合格時0、不合格時1のexit codeを返します。途中で不合格になっても自己清掃を試みます。最後のcleanupは、異常終了で残った`IT`タグのレコードを清掃する安全網です。

```powershell
npm run build
node --env-file=.env tests/integration/m3-run-uniqueness.mjs
node --env-file=.env tests/integration/m3-attempt-numbering.mjs
node --env-file=.env tests/integration/m3-write-failure-recovery.mjs
node --env-file=.env tests/integration/m3-canonical-key-conflict.mjs
node --env-file=.env tests/integration/m3-lease-heartbeat.mjs
node --env-file=.env tests/integration/m3-heartbeat-drain.mjs
node --env-file=.env tests/integration/m3-cleanup.mjs
```

結果の詳細JSONは`tests/integration/results/`へ保存されます。token名のフィールドを除去し、設定されたtoken値がシリアライズ結果に残っていないことを保存前に検査します。結果JSONはgit管理対象外です。scopeは試験名をキーに含めず、`IT<yymmddHHmmss>_<4hex>`形式の19文字とします。試験名は結果JSONの`test`とコンソールログに保持します。製品が付加する`RUN:`/`ATT:`等を含むrecord keyと、`run_id`・lock owner・解放tombstoneの`status_reason`へ`IT`タグを伝播して清掃対象を識別します。試験開始前に全派生キーの64文字制限を検証します。

## M3ゲート対応

| ゲート                    | スクリプト                      | 主な実機証拠                                                               |
| ------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| 1 Run重複防止             | `m3-run-uniqueness.mjs`         | 並行createRun、CB_VA01裁定、永続1件                                        |
| 2 Attempt採番             | `m3-attempt-numbering.mjs`      | ATTEMPT_NUMBER_CONFLICT、1→2→3、重複・再利用なし                           |
| 3 二重書込み修復/停止     | `m3-write-failure-recovery.mjs` | terminal Attempt反映と監査、terminal State矛盾の停止、Run集約再計算、再GET |
| 4 canonical key/競合      | `m3-canonical-key-conflict.mjs` | distとtest vector一致、node_state_key重複禁止、revision 409                |
| 5 長時間heartbeat/fencing | `m3-lease-heartbeat.mjs`        | 縮小leaseで3回更新、旧token拒否、tombstone解放                             |
| 6 heartbeat一時断drain    | `m3-heartbeat-drain.mjs`        | fetch障害注入、起動停止、実行中処理完走、最終確認成功時だけ書込み          |
| 清掃                      | `m3-cleanup.mjs`                | `IT`タグのEXEC/AUDITレコード削除                                           |
