# Spike D: lock protocol

## 位置付け

本ディレクトリはFDR D-10、D-11、D-14を閉じるための実機contract test準備物である。観測結果をkintoneの公式保証へ格上げしない。

重複禁止を設定した文字列（1行）フィールドの上限は実測64文字（CB_VA01）。canonical lock key設計（D-10、`N1:` + base64url 43文字 = 46文字）は、この実測制限内に収まる。

## 検証環境と前提

- kintone: `https://<subdomain>.cybozu.com`（timezone: `Asia/Tokyo`）
- 既存実行ログ／Job Lock: app 4249（kSQL-Flow所有）
- profile: `my-ksql-jobs/ksql.config.json`の`prod`
- 認証環境変数: `KSQL_TOKEN_LOGS`
- ユーザー作成済みのスパイク用Network Lock保存先アプリ
- barrier同期できる2以上のプロセス。可能なら別ホスト・別作業ディレクトリ
- revision競合、応答消失、GET遅延、通信断を安全に注入できるハーネス

token値、`.env`、Authorization header、lock以外の実レコード内容を保存しない。

## 再実行可能な手順

1. ホスト、プロセス数、作業ディレクトリ、version、app ID、ローカルロック有無、反復回数を記録する。
2. D-10のcanonical inputについてNUL拒否、NFC、大文字小文字、UTF-8、base64url paddingなしを含むtest vectorを生成し、期待キーと照合する。
3. 同じlock keyのINSERTをbarrier同期した2以上のプロセスで多数回競合させ、成功数、拒否数、永続重複数を記録する。
4. 400応答後に同じkeyを再GETし、RUNNING holder確認時だけ`LOCK_CONFLICT`、確認不能・別原因は`LOCK_UNAVAILABLE`となることを確認する。
5. 成功応答消失、GET遅延、通信断、stale回収後の旧保持者復帰、`finishRecord()`と回収更新のrevision競合を注入する。
6. ローカルロックあり／なし、同一ホスト／別ホストの結果を分けて記録する。
7. D-14の一括切替、旧新二重取得、最低protocol version拒否を候補ごとに検証する。二重取得では全コマンドの固定順、deadlock、片側取得後rollbackを確認する。
8. `decision-template.md`へ測定行ID、観測範囲、後続ゲートを記入する。

## 中止条件

- 対象lock key、app、holder、revisionを一意に確認できない。
- 旧保持者の停止を確認できないままstale回収・再取得へ進む必要がある。
- 競合・通信異常を成功扱いする可能性がある。
- 秘密情報または非スパイクレコードを変更するおそれがある。

## スクリプトによる実行

前提として、`tests/e2e/env.e2e.example`を基に`.env`を用意し、作成済みの2アプリ案の実行管理Spikeアプリを`KSQL_SPIKE_APP_EXEC`へ、同アプリでレコード閲覧・追加・編集・削除を許可したtokenを`KSQL_SPIKE_TOKEN_EXEC`へ設定する。スクリプトは`KSQL_SPIKE_APP_EXEC`以外を対象にせず、既存アプリ4246、4247、4249を拒否する。Node.js 22以上で、リポジトリルートから次を実行する。

```bash
node --env-file=.env spikes/d-lock-contract/scripts/lock-contention.mjs
node --env-file=.env spikes/d-lock-contract/scripts/lock-contention.mjs --workers 4 --iterations 50
node --env-file=.env spikes/d-lock-contract/scripts/response-loss.mjs
node --env-file=.env spikes/d-lock-contract/scripts/revision-conflict.mjs
node --env-file=.env spikes/d-lock-contract/scripts/stale-reclaim.mjs
```

`lock-contention.mjs`の既定値は2 worker、10反復である。同一ホスト・ローカルロックなしの経路を測る。別ホスト（D-04）、GET遅延（D-08）、通信断（D-09）、ローカルロックあり（D-12）、キー移行（D-14〜D-16）はこのスクリプト群の自動判定対象外であり、既存の再実行可能な手順に従って別途測定する。`stale-reclaim.mjs`は停止確認済みの回収を模擬し、旧revision拒否だけを測る。実運用の停止確認を代替しない。

結果は実行ごとに`spikes/d-lock-contract/results/<timestamp>-<script>.json`へ保存される。JSONの`measurementIds`と反復内の結果を`measurements.md`の同じIDへ転記し、環境、日時、回数、API呼出数、結果、障害注入方法、残余リスクを埋める。tokenやAuthorizationを含むキーと実際のtoken値は保存前に除去され、混入を検知した場合は結果保存を中止する。
