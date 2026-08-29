# Spike B: 実行バンドル

## 位置付け

本ディレクトリはFDR D-12のbundle保持・archive・復元判断を閉じるための準備物であり、実測結果ではない。

## 検証環境と前提

- kintone: `https://devenxyfi.cybozu.com`（timezone: `Asia/Tokyo`）
- profile: `my-ksql-jobs/ksql.config.json`の`prod`
- 認証環境変数: `KSQL_TOKEN_LOGS`。bundle内SQLが案件・顧客appを検査する場合のみ`KSQL_TOKEN_DEALS`、`KSQL_TOKEN_CUSTOMERS`
- 新規のNetwork Run保存先アプリと、候補archive先をユーザーが作成・許可済みであること
- 添付の追加・取得・差替え・削除を分離して確認できる主体

秘密、`.env`、token値、顧客データをbundleまたは測定記録へ含めない。

## 再実行可能な手順

1. 実施環境、version、新規app ID、archive先、権限主体を記録する。
2. 秘密を含まない決定的データから小・中・上限候補（暫定10MiBを含む）のZIPを生成し、元byte数とSHA-256を記録する。
3. 各サイズをupload/downloadし、API回数、payload byte数、所要時間、取得後SHA-256を記録する。
4. 1 byte破損、添付差替え、削除をそれぞれ試し、hash不一致と権限拒否を確認する。
5. archiveへ移送後、元のRunとの対応を保ったまま復元し、hashとresume可否を確認する。
6. 添付取得不能・archive取得不能・hash不一致を注入し、作業ツリーへfallbackせずfail-closedになることを確認する。
7. 容量分布、resume可能期間、監査保持、削除承認、定期復元試験の候補をまとめる。
8. `decision-template.md`へ測定行IDを根拠として記入する。

## 中止条件

- bundleまたはログに秘密情報・顧客データが含まれる。
- `resume_allowed = true`の検証済みbundleを回復不能にする操作が必要になる。
- hash、Run、添付、archive objectの対応を一意に追跡できない。
- 権限境界を確認できないまま差替え・削除操作へ進む。
