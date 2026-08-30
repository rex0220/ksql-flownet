# M3 / M4 実機統合試験

M3/M4完了ゲートを、`pretest`/`build`で生成した`dist/`の製品コードに対して検証する手動実行用スクリプトです。`npm test`には含めません。

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

M4も同じ`.env`、同じ2アプリを使い、次の順で実行します。M4スクリプトのkSQL-Flow CLI層は既定で`tests/fixtures/executor/`を返すfake spawnです。kintoneのRun、Node State、Invocation、Network Lock、bundle添付はfakeではなく実アプリへ永続化します。

```powershell
npm run build
node --env-file=.env tests/integration/m4-ensure-run-branches.mjs
node --env-file=.env tests/integration/m4-bundle-continuity.mjs
node --env-file=.env tests/integration/m4-preflight-rejections.mjs
node --env-file=.env tests/integration/m4-capability-gate.mjs
node --env-file=.env tests/integration/m4-bundle-retention.mjs
node --env-file=.env tests/integration/m4-cleanup.mjs
```

`KSQL_FLOW_BIN`を設定した場合だけ、fake spawnの代わりに実kSQL-Flow subprocessを起動します。この任意モードでは`KSQL_FLOW_CONFIG_PATH`も必須で、profile名は`KSQL_FLOW_PROFILE`（未指定時`prod`）です。たとえば次のように設定して同じM4コマンドを実行します。

```powershell
$env:KSQL_FLOW_BIN = 'C:\Users\rex02\Projects\ksql-flow\dist-bin\ksql-flow.exe'
$env:KSQL_FLOW_CONFIG_PATH = 'C:\path\to\ksql-flow.config.json'
$env:KSQL_FLOW_PROFILE = 'prod'
node --env-file=.env tests/integration/m4-ensure-run-branches.mjs
```

不一致試験は、実CLIモードでもCLIを一度起動したうえで返却値の対象項目だけを派生fixture相当に変更します。したがって、実CLIモードはsubprocess契約の追加確認には使えますが、M4の必須証跡は決定的なfake spawnモードです。

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

## M4ゲート対応

M4時点にはSQL実行そのものがありません。このため完了ゲートの「SQLを開始しない」は、`ensureRun()`が`NEW`/`RESUME`の実行対象を返さず、distの安定`code`で拒否することとして検証します。

| ゲート                      | スクリプト                    | 主な実機証拠                                                                                                                                                                                         |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 保存SQLで同じRunを継続    | `m4-bundle-continuity.mjs`    | NEW後に作業ツリー相当SQLを変更し、RESUMEが添付bundleをdownload、SHA-256検証して元SQLを返す。RESUMEでは`inspect-job`を呼ばない                                                                        |
| 2 preflight拒否             | `m4-preflight-rejections.mjs` | 添付差替えの`BUNDLE_HASH_MISMATCH`、現profile変更の`PROFILE_SNAPSHOT_MISMATCH`、`JOB_ID_MISMATCH`、未承認`NONDETERMINISTIC_IDEMPOTENT_JOB`で実行対象なし。承認済みKSQL1306はdist preflight APIで通過 |
| 3 capability先行ゲート      | `m4-capability-gate.mjs`      | `CAPABILITY_FEATURE_MISSING`時にlockレコード0件、Run 0件、lock acquire観測0回                                                                                                                        |
| 4 ensure-run分岐            | `m4-ensure-run-branches.mjs`  | 0件NEWでRunとbundle添付を再GET、未完了1件RESUME、SUCCESS化後1件NOOPかつInvocation増加なし                                                                                                            |
| 5 bundle保持・archive・復元 | `m4-bundle-retention.mjs`     | 添付downloadと再検証、`resume_allowed=false`で`RUN_NOT_RESUMABLE`、`true`復元後RESUMEと同一hash                                                                                                      |
| 清掃                        | `m4-cleanup.mjs`              | `IT`タグのEXEC/AUDITレコードを削除。NETWORK_RUN削除にbundle添付を含む                                                                                                                                |

R1の`profile + network_id + business_key`重複禁止により、M4実機アプリ上へ複数Runを正常APIで作れません。複数件fail-closedは`m3-run-uniqueness.mjs`のCB_VA01/R1実機証跡と、ensure-run単体試験の`MULTIPLE_RUNS`証跡を参照します。

KSQL1306の承認例外はM4時点の`ensureRun()`入力には公開されていないため、未承認側をensure-runで拒否し、承認側を同じdistの`validateJobInspections()`で検証します。承認済みpreflightが通っても、このスクリプトはSQL実行対象を開始しません。

`m4-bundle-retention.mjs`のarchive/復元は、D-12で未決定の実archive先へbundleを移動せず、運用フラグ`resume_allowed`のfalse/trueによる「archive相当」「復元相当」を検証します。実archive先、object version、権限、承認フローはスコープ外です。
