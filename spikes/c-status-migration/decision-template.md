# Spike C 判定記録

## D-06検証: 現行status移行

- D-06の状態: `DECIDED`（状態変更なし）
- 記録区分: 移行表の実データ検証結果
- 検証日: 2026-08-29（JST）
- 環境: `LAPTOP5` / `win32` / Node.js `v24.14.0` / `<subdomain>.cybozu.com`
- 実ログ出典: `spikes/c-status-migration/results/2026-08-29T13-02-37.002Z-inspect-real-logs.json`
- fixture出典: `spikes/c-status-migration/fixtures.yaml`
- テスト出典: `tests/unit/status-migration.test.mjs`

### 判断案

実ログ431件をread-onlyで取得した（GET 2回）。`status`を持つ429件の全statusはfixture、すなわちD-06移行表でカバーされ、fixtureにない想定外statusは0件だった。分布は`SUCCESS` 244件、`ABORTED` 70件、`NO_DATA` 66件、`FAILED` 29件、`SKIPPED` 16件、`TIMEOUT` 4件である。

一方、fixtureの`CANCELLED`は現行実ログに存在しない。fixture `explicit_external_stop`の入力`current_status: CANCELLED`は今回の実データに実在しない値であるため、D-06の「外部からの明示停止」行の入力表現は、移行ツール実装時に実データ根拠で再定義する必要がある。これは`fixtures.yaml`の修正候補として残すが、本検証ではfixture自体を変更しない。

変換試作はfixture全14ケースに合格した。また、原因情報の欠落・矛盾4ケースと未知status 1ケースを暗黙変換せず`MIGRATION_*`エラーとするfail-closedを確認した。ただし、これは試作レベルであり、凍結ゲート「現行status移行fixtureの全ケースに合格」は本実装（M7）で全件を実行するまで未チェックを維持する。

### 実装ノート

- `record_type`と`log_detail`は実ログに同名フィールドとして存在する。
- fixtureの`current_status`に対応する実フィールドは`status`であり、名称変換が必要である。
- `timeout_source`と`actor`は実ログのフィールドとして存在せず、導出値である。移行ツールは、たとえばstale回収を示す`log_detail`の記録文言と`record_type`などから発生源と主体を導出する必要がある。
- `job_key`と`job_key_done`は実ログに`SINGLE_LINE_TEXT`として存在し、キーを退避して解放する現行ロック解放プロトコルを実データのフィールド構成が裏付ける。

### 残項目

- 「外部からの明示停止」行の実在する入力表現を、移行ツール実装時に実データ根拠で再確認する。
- `timeout_source`と`actor`の導出規則を実データの`log_detail`文言・`record_type`に基づいて定義し、曖昧な入力をfail-closedにする。
- 本実装（M7）で移行fixture全件を実行し、凍結ゲートの可否を判定する。

本記録はD-06の決定を置換せず、実データによる検証結果を追記する案である。Supersededはない。
