# Spike C 測定表

## 実測条件と出典

- 実施日: 2026-08-29（JST）
- 環境: `LAPTOP5` / `win32` / Node.js `v24.14.0` / `<subdomain>.cybozu.com`
- 実ログ出典: `spikes/c-status-migration/results/2026-08-29T13-02-37.002Z-inspect-real-logs.json`
- fixture出典: `spikes/c-status-migration/fixtures.yaml`
- テスト出典: `tests/unit/status-migration.test.mjs`
- 読取り条件: read-only、要求500件、取得431件、discovery 1件、GET 2回

## 現行statusの分布

実ログ431件のうち、`status`を持つ429件の分布は次のとおり。合計は429件で、fixtureにない想定外statusは0件だった。

| 現行status | 件数 |
| ---------- | ---: |
| `SUCCESS`  |  244 |
| `ABORTED`  |   70 |
| `NO_DATA`  |   66 |
| `FAILED`   |   29 |
| `SKIPPED`  |   16 |
| `TIMEOUT`  |    4 |

fixture側に定義されているstatusのうち、実ログで未観測だった値は`CANCELLED`である。出典はresults JSONの`status.distribution`、`fixture_statuses_not_observed`、`observed_statuses_not_in_fixture`。

## fixture入力と実フィールドの照合

| fixture入力      | 実フィールド照合                                     | 結果                                   |
| ---------------- | ---------------------------------------------------- | -------------------------------------- |
| `current_status` | 実フィールド名は`status`（`DROP_DOWN`）、429件に存在 | 意味上の候補あり。フィールド名は異なる |
| `record_type`    | 同名の`record_type`（`DROP_DOWN`）、429件に存在      | 一致                                   |
| `log_detail`     | 同名の`log_detail`（`MULTI_LINE_TEXT`）、431件に存在 | 一致                                   |
| `timeout_source` | 候補フィールドなし                                   | フィールド非実在。導出値               |
| `actor`          | 候補フィールドなし                                   | フィールド非実在。導出値               |

出典はresults JSONの`fixture_input_comparison`と`discovered_fields`。`timeout_source`と`actor`は実フィールドから直接転記できないため、移行時に`log_detail`の記録文言、`record_type`などの実在情報から導出する必要がある。

`discovered_fields`には`job_key`と`job_key_done`がともに`SINGLE_LINE_TEXT`として存在し、現行のロック解放プロトコルで使用する両フィールドの実在を確認した。

## 変換試作

`tests/unit/status-migration.test.mjs`で、`spikes/c-status-migration/fixtures.yaml`の全14ケースをテーブル駆動で実行し、14/14件が期待値と一致した。

同テストでは、既知statusでも原因情報が欠ける、または矛盾する4ケースと、未知status `PARTIAL_SUCCESS` 1ケースが`MIGRATION_*`エラーになることを確認した。したがって、変換試作は未分類の入力を暗黙変換せずfail-closedする。

これは`spikes/c-status-migration/scripts/convert.mjs`による試作レベルの検証であり、本実装（M7）の移行fixture全件合格を示すものではない。
