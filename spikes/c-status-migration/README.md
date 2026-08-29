# Spike C: status移行

## 位置付け

本ディレクトリはFDR D-06の移行規則を、発生原因付きfixtureで検証するP0-06準備物である。`fixtures.yaml`はstatus文字列だけでなく`record_type`、`log_detail`、timeout発生源、実行主体を入力に持つ。

## 検証環境と前提

- fixture変換自体はローカルで実施し、kintoneアクセスは不要
- 実ログ照合時の環境: `https://devenxyfi.cybozu.com`、timezone `Asia/Tokyo`
- 既存実行ログ: app 4249（kSQL-Flow所有）
- profile: `my-ksql-jobs/ksql.config.json`の`prod`
- 実ログを取得する場合の認証環境変数: `KSQL_TOKEN_LOGS`

実ログ本文、token値、`.env`をfixtureへ転記しない。必要なら匿名化した分類情報だけを追加する。

## 再実行可能な手順

1. `fixtures.yaml`を読み込み、各caseの`input`全体を変換関数へ渡す。
2. `current_status`だけで分岐する実装を禁止し、`record_type`、`log_detail`、`timeout_source`、`actor`を使って原因を分類する。
3. 各caseのNode State status、result code、備考を`expected`と比較する。
4. `FAILED`の実エラー種別は`log_detail.error_category`から分類し、fixtureにない種別を成功へfallbackしない。
5. 全caseのpass/fail、変換不能、追加API呼出数（通常0）を`measurements.md`へ記録する。
6. 未分類の現行理由が見つかった場合はcaseを追加し、D-06変更要否を`decision-template.md`へ記録する。

## 中止条件

- 秘密情報・顧客データを含む実ログしか入力に使えない。
- 発生原因を一意に復元できず、推測で`SUCCESS`／`FAILED`を確定しそうになる。
- fixtureの期待値とD-06の表が矛盾し、正本更新判断なしにテストだけを変更する必要がある。
