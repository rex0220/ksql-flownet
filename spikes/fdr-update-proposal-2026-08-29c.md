# FDR更新提案書（2026-08-29 第3弾）

反映状態: REFLECTED(2026-08-29)

反映状態: PROPOSAL（未反映）

> **これは正本ではない。承認後に`docs/internal/phase1-freeze-decision-record.md`へ反映する。** 本提案では`docs/`を変更しない。

## 共通の検証条件と出典

- 実施日: 2026-08-29（JST）
- 環境: `LAPTOP5` / `win32` / Node.js `v24.14.0` / `<subdomain>.cybozu.com`
- D-06実ログ: `spikes/c-status-migration/results/2026-08-29T13-02-37.002Z-inspect-real-logs.json`
- D-06 fixture・試作テスト: `spikes/c-status-migration/fixtures.yaml`、`tests/unit/status-migration.test.mjs`
- D-10 vector・テスト・実装: `tests/fixtures/canonical-lock-key/vectors.json`、`tests/unit/canonical-lock-key.test.mjs`、`src/domain/canonical-lock-key.ts`

## 1. D-10: canonical lock keyの固定

- 提案状態: `PROPOSED` → `DECIDED`
- 凍結ゲート: D-10のcanonical bytes・キーversionのtest vector固定をチェック済みにする
- Superseded: なし。既存案へ固定・検証記録を追記する

### 追記案

2026-08-29、canonical lock keyのbytes契約とキーversionを固定test vectorとして記録した。`vectors.json`のmetadataは、contract version `N1/J1`、SHA-256、`base64url without padding`、UTF-8、Unicode NFC、canonical input `<version>\0<NFC(profile)>\0<NFC(identifier)>`、生成キー長46文字、NFC正規化後identifier上限128文字を定義している。

固定vectorは有効9件と拒否6件である。有効vectorにはNetwork/Job、ASCII/日本語、NFC/NFD同値、大文字小文字の区別、128文字境界を含む。拒否vectorには空値、区切り文字、予約値、NUL、129文字境界超過を含み、安定したerror codeと対象componentを固定している。

Node.js標準`crypto`だけを使い、実装関数を経由せずmetadataどおりにcanonical bytesを組み立てて全9件を独立再計算した結果、expected keyとの不一致は0件だった。実装は`src/domain/canonical-lock-key.ts`にあり、固定vector全件・NFC同値・case sensitivity・拒否ケースを`tests/unit/canonical-lock-key.test.mjs`で検証する。

以上によりD-10を`DECIDED`とし、対応する凍結ゲートを閉じることを提案する。ただし、J1への実データ移行と新旧lock protocol切替はD-14の範囲であり未実施である。D-14は別項目として未完了のまま残す。

## 2. D-06: DECIDED済み判断への実データ検証記録

- 提案状態: `DECIDED`を維持
- Superseded: なし。決定済み移行表へ検証結果を追記する

### 追記案

2026-08-29、現行ログをread-onlyで431件取得した（GET 2回）。`status`を持つ429件の分布は`SUCCESS` 244件、`ABORTED` 70件、`NO_DATA` 66件、`FAILED` 29件、`SKIPPED` 16件、`TIMEOUT` 4件で、観測した全statusはD-06 fixtureでカバーされ、fixtureにない想定外statusは0件だった。

fixture側の`CANCELLED`は現行実ログに存在しない。特に`explicit_external_stop`の入力`current_status: CANCELLED`は今回の実データに実在しない値である。「外部からの明示停止」行の入力定義は、移行ツール実装時に実データ根拠で再確認し、必要ならfixture修正候補とする。

`record_type`と`log_detail`は実ログに同名フィールドとして存在するが、`timeout_source`と`actor`はフィールドとして存在せず導出値である。移行ツールは、stale回収などを示す`log_detail`の記録文言と`record_type`等から発生源・主体を導出し、確定できない場合はfail-closedにする必要がある。`job_key`と`job_key_done`も実在し、キー退避による現行ロック解放プロトコルのフィールド構成を確認した。

## 3. 凍結ゲート「現行status移行fixtureの全ケースに合格」

`spikes/c-status-migration/scripts/convert.mjs`による変換試作は、D-06 fixture全14ケースに合格した。原因情報が欠落・矛盾する4ケースと未知status 1ケースを暗黙変換しないfail-closedも確認した。

ただし、これは試作レベルの検証である。凍結ゲートを閉じるのは本実装（M7）で移行fixture全件を実行した時点とし、現時点では未チェックを維持する。

## Superseded一覧

今回の提案にSupersededはない。D-10は既存案への固定・検証記録、D-06はDECIDED済み判断への実データ検証記録、status移行の凍結ゲートは試作進捗と閉鎖条件の追記であり、すべて追記として扱う。
