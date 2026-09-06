# Spike C: status移行

## 位置付け

本ディレクトリはFDR D-06の移行規則を、発生原因付きfixtureで検証するP0-06準備物である。`fixtures.yaml`はstatus文字列だけでなく`record_type`、`log_detail`、timeout発生源、実行主体を入力に持つ。

## 検証環境と前提

- fixture変換自体はローカルで実施し、kintoneアクセスは不要
- 実ログ照合時の環境: `https://<subdomain>.cybozu.com`、timezone `Asia/Tokyo`
- 既存実行ログ: app 4249（kSQL-Flow所有）
- profile: `my-ksql-jobs/ksql.config.json`の`prod`
- 実ログを取得する場合の認証環境変数: `KSQL_TOKEN_LOGS_RO`（読取専用token）

実ログ本文、token値、`.env`をfixtureへ転記しない。必要なら匿名化した分類情報だけを追加する。

## 実行手順

fixture変換とfail-closed規則はunit testで確認する。

```powershell
npm run build
node --test --test-name-pattern="D-06|status" tests/unit/status-migration.test.mjs
```

実行ログアプリを最大500件サンプリングする場合は、`.env`へ
`KSQL_SPIKE_BASE_URL`、`KSQL_SPIKE_APP_LOGS`、`KSQL_TOKEN_LOGS_RO`を設定して実行する。

```powershell
node --env-file=.env spikes/c-status-migration/scripts/inspect-real-logs.mjs
node --env-file=.env spikes/c-status-migration/scripts/inspect-real-logs.mjs --sample-size 100
```

inspectスクリプトのclientはGET操作だけを公開し、POST / PUT / DELETE操作や任意method指定を持たない。4249を含む対象アプリへ書込みを行わない。最初に1件だけGETして実フィールド名を発見し、その結果を前提にサンプルを集計する。

結果JSONは`results/`へ既存の秘匿化`writeResult`で保存する。次を確認する。

- `status.distribution`: 実データに存在したstatus値と件数
- `status.observed_statuses_not_in_fixture`: fixtureにない実status値
- `status.fixture_statuses_not_observed`: サンプルで観測しなかったfixture側status値
- `fixture_input_comparison`: fixture名と実フィールド候補の差異、field type、存在件数
- `discovered_fields`: 最初の1件で確認したフィールド名とfield type

自由記述の値、ジョブ名、顧客値、record ID、tokenは結果へ保存しない。候補が0件または複数の場合は推測でフィールドを選ばず、`field_not_found`または`ambiguous_candidates`として報告する。

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
