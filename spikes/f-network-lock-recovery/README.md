# Spike F: Network lock recovery

## 位置付け

本ディレクトリはFDR D-29のrenewable Network lease、drain、旧owner停止確認、監査付き強制回収を閉じるための準備物である。

## 検証環境と前提

- D-08で採用した2アプリ案だけを使用する。
- `KSQL_SPIKE_BASE_URL`、`KSQL_SPIKE_APP_EXEC`、`KSQL_SPIKE_TOKEN_EXEC`、`KSQL_SPIKE_APP_AUDIT`、`KSQL_SPIKE_TOKEN_AUDIT`を設定する。
- 実行管理appと監査appは別appでなければならない。既存app 4246、4247、4249は起動時に拒否する。
- token値、`.env`、Cloud認証情報、Authorization headerを結果へ記録しない。結果JSONは`writeResult`で秘密フィールドと秘密値を除去して保存する。
- 通常解放と強制回収はDELETEせず、`record_key`と`lock_key`を64文字以内の一意なtombstoneへrevision付き単一UPDATEで移す。

既存のSpike A用2アプリschemaには`acquired_at`と`owner_instance_id`の専用フィールドがないため、測定スクリプトではそれぞれ`started_at`と安全化した`status_reason`へ記録する。監査appの`event_type`候補も`ATTEMPT_RESOLVED`だけなので、`NETWORK_LOCK_FORCE_RELEASED`はOperation Auditの`result_code`を安定event codeとして記録する。このschema差はSpike Fの実測結果から本番schemaへ反映する判断材料であり、スクリプトは存在しないフィールドへ書き込まない。

## スケールダウン設定

既定値はlease 6秒、heartbeat 2秒で、`heartbeat < lease`かつ`heartbeat <= lease / 3`を満たす。これは障害注入を短時間で反復するためだけの値であり、実運用値ではない。実運用のlease期間、heartbeat間隔、連続失敗閾値はSpike Fの実測とControl Plane API容量評価後に別途決定する。CLIで値を変更する場合も比率違反はAPIアクセス前に拒否される。

## 実行スクリプト

Node.js 22以上でリポジトリルートから、次の順に実行する。

```bash
node --env-file=.env spikes/f-network-lock-recovery/scripts/lease-lifecycle.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/stale-detection.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/lease-token-fencing.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/drain-mode.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/force-unlock-network.mjs \
  --stop-evidence-ref "evidence://operator/runtime-stop/001" \
  --reason "Spike F verified recovery" \
  --service-principal "<authenticated-service-principal>" \
  --confirmed-by "<operator-id>"
```

PowerShellでは継続記号をバッククォートへ置き換えるか、最後のコマンドを1行で実行する。`lease-lifecycle.mjs`は`--lease-seconds`、`--heartbeat-seconds`、`--subprocess-seconds`を指定できる。`stale-detection.mjs`は`--lease-seconds`を指定できる。

- `lease-lifecycle.mjs`: 疑似subprocessとheartbeatを並行させ、heartbeat回数、間隔、payload、実行秒あたりの`control_plane_api_calls`を記録する。
- `stale-detection.mjs`: heartbeat停止後のobserverはGETとstale候補判定だけを行う。測定後のtombstone更新は旧owner役による清掃であり、自動回収ではない。
- `lease-token-fencing.mjs`: 新lease tokenへ回収後、旧ownerを再GET token不一致とrevision 409の両経路で拒否する。
- `drain-mode.mjs`: fetchラッパーでheartbeatだけを失敗させる。これは障害注入であり、kintoneの実挙動を示すものではない。再更新成功と失敗の両分岐を測る。
- `force-unlock-network.mjs`: owner不一致とrevision不一致をfail-closedで確認した後、応答body消失を模擬し、再GETで確定した回収だけを監査する。停止証拠の内容は照会せず、管理済み参照文字列として受け取る。

各実行結果は`spikes/f-network-lock-recovery/results/<timestamp>-<script>.json`へ保存される。通常解放済みlockと監査eventは測定証跡として残るため、実行前にSpike専用アプリの保持・清掃方針を確認する。

## Cloud Run判定

`cloud-run-adapter.mjs`は純粋な判定ロジックだけを提供し、GCP APIを呼び出さない。unit testで`SUCCEEDED`、`FAILED`、`CANCELLED`だけを停止確認OKとし、`RUNNING`、`PENDING`、未知状態、権限エラー、通信失敗をfail-closedに固定する。

実機ではCloud Run Admin API v2のExecution GETを最小権限`run.executions.get`で手動実施し、完全なExecution resource name、応答状態、API呼出数をF-11〜F-15へ転記する。このリポジトリのスクリプトはGCPへアクセスせず、実機照会を代替しない。

## ローカル検証

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
Get-ChildItem spikes/f-network-lock-recovery/scripts/*.mjs | ForEach-Object { node --check $_.FullName }
```

## 再実行可能な手順

1. lease/heartbeat設定、host/runtime、version、app ID、反復回数、API計数範囲を記録する。
2. 正の整数、`heartbeat < lease`、`heartbeat <= lease / 3`の有効境界と無効境界を検証する。
3. 長時間subprocess中のheartbeat継続、lease token、revision、Control Plane API呼出数を測る。
4. FlowNet processをkillし、heartbeat停止、期限経過、stale候補化を観測する。旧owner停止確認前に回収しない。
5. kintone一時到達不能を注入し、drain、新規Node停止、実行中subprocess完走、結果保存前のlease再確認を検証する。
6. 期限超過後のheartbeat再更新成功／失敗／owner変更と、旧tokenによるState更新・次Node起動拒否を検証する。
7. 同一ホストと別ホストで旧owner停止を確認し、Cloud Run Executionのterminal、non-terminal、未知状態、権限不足、通信障害を分ける。
8. `force-unlock-network`でexpected owner、revision、lease token競合、応答消失後の再GET、監査eventを検証する。
9. 回収後にNode Attempt、耐久開始marker、Job lockを照合し、未確定時に`UNKNOWN`となることを確認する。
10. heartbeatとruntime停止確認のAPI呼出しを`control_plane_api_calls`として集計する。
11. `decision-template.md`へ測定行IDとTOCTOUを含む残余リスクを記入する。

## 中止条件

- 旧ownerの停止を確認できない、またはruntime照会が非terminal・未知・権限不足・通信失敗である。
- expected owner、revision、lease token、現在holderを一意に照合できない。
- drain中に新規Nodeを開始する、またはlease再確認なしに結果を書き込む可能性がある。
- 回収後の実行結果が未確定なのに`SUCCESS`／`FAILED`へ推測確定しそうになる。
