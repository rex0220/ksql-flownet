# Spike F: Network lock recovery

## 位置付け

本ディレクトリはFDR D-29のrenewable Network lease、drain、旧owner停止確認、監査付き強制回収を閉じるための準備物である。

## 検証環境と前提

- kintone: `https://devenxyfi.cybozu.com`（timezone: `Asia/Tokyo`）
- profile: `my-ksql-jobs/ksql.config.json`の`prod`
- 既存app 4249と、ユーザー作成済みのNetwork Lock／Node State／Node Attempt保存先
- 認証環境変数: `KSQL_TOKEN_LOGS`。検証jobが案件・顧客appを使う場合のみ`KSQL_TOKEN_DEALS`、`KSQL_TOKEN_CUSTOMERS`
- 同一ホストと別ホスト、制御可能な長時間subprocess、Cloud Run Execution照会用の最小権限主体
- heartbeat、kintone一時断、process kill、owner/revision競合、応答消失を注入できるハーネス

token値、`.env`、Cloud認証情報、Authorization headerを記録しない。

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
