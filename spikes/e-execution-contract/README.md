# Spike E: Execution Contract拡張

## 位置付け

本ディレクトリはP0-00のExecution Result Schema草案と、FDR D-22／D-23およびExecution Contract v1 §13の未決事項を検証する準備物である。[execution-result-v1.draft.schema.json](./execution-result-v1.draft.schema.json)は**草案**であり、配布場所・package化が未決のため正本ではない。

Schemaは契約§3.3の「未知フィールドは無視し、v1内の追加はadditive」に従い、各objectの`additionalProperties`を`true`にする。status・exitCode・`executionStarted`の既知resultCodeとの整合は条件schemaで表す。未知resultCodeの受理判定は§4.3のとおりControl Planeのstatus／Exit Code整合ロジックで行い、schemaでは拒否しない。

2026-08-30裁定: kSQL-Flow公開仕様7.1との整合のため、`SQL_ERROR`は`FAILED`／Exit 1とする（`executionStarted`は制約しない）。

## 検証環境と前提

- kintone: `https://devenxyfi.cybozu.com`（timezone: `Asia/Tokyo`）
- 既存アプリ: 案件4247、顧客4246、実行ログ4249
- profile: `my-ksql-jobs/ksql.config.json`の`prod`
- 認証環境変数: `KSQL_TOKEN_DEALS`、`KSQL_TOKEN_CUSTOMERS`、`KSQL_TOKEN_LOGS`
- `ksql-flow describe-profile --json`、`inspect-job --json`、耐久`EXECUTION_STARTED`を実装したスパイク版
- Node Attempt開始markerとJOB更新の間へ障害注入できるハーネス

token値、`.env`、Authorization header、SQL literal、顧客レコードを結果JSONへ含めない。

## 再実行可能な手順

1. まず単体テストで正常・失敗fixtureのschema合格、必須欠落・literal不一致の不合格を確認する。
2. `describe-profile --json`をprofile `prod`で取得し、canonical JSON再現性、接続先・timezone・app ID、秘密情報除外を確認する。
3. `inspect-job --json`でjob ID、非決定要素code、承認済み例外manifestを確認する。静的検査だけで冪等性を証明しない。
4. Node Attempt開始marker成功後かつJOB `EXECUTION_STARTED`前にcrashを注入し、結果・照合・UNKNOWN境界を記録する。
5. JOB `EXECUTION_STARTED`更新成功後かつ最初のSQL文前にcrashを注入し、UNKNOWNとなることを確認する。
6. JOB更新の成功応答消失を注入し、revision付き再GETとfail-closedを確認する。
7. 耐久markerと結果JSONの`executionStarted`、status、resultCode、process exitの整合・矛盾を検証する。
8. stdout/path、atomic rename、schema配布場所・version・package化、既存ファイル上書き規則を候補ごとに記録する。
9. `decision-template.md`へ測定行IDを根拠として記入する。

## 中止条件

- 結果・profile・job inspectionに秘密情報や顧客データが出力される。
- marker、attempt、execution ID、JOBレコードを一意に相関できない。
- crash後のSQL開始可能性を否定できないのに自動再実行へ進む。
- 結果JSONとprocess exitの矛盾を成功扱いしそうになる。
