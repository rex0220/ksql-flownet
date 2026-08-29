# Spike A: 1アプリ対2アプリ

## 位置付け

本ディレクトリはFDR D-08を閉じるための実機スパイク準備物であり、まだ実測結果ではない。同じ3ノードDAGをFlowNet 1アプリ案と2アプリ案で比較する。既存のkSQL-Flow実行ログアプリ（app 4249）は比較対象へ統合しない。

## 検証環境と前提

- kintone: `https://devenxyfi.cybozu.com`（timezone: `Asia/Tokyo`）
- 既存アプリ: 案件管理（4247）、顧客管理（4246）、実行ログ（4249、kSQL-Flow所有）
- job repository: `my-ksql-jobs`の`ksql.config.json`にあるprofile `prod`
- 認証: APIトークン。参照する環境変数は`KSQL_TOKEN_DEALS`、`KSQL_TOKEN_CUSTOMERS`、`KSQL_TOKEN_LOGS`のみ
- 新規アプリ: [2アプリ案](./app-design-2app.md)または[1アプリ案](./app-design-1app.md)に従い、ユーザーが作成する
- 権限: 新規アプリのレコード追加・閲覧・編集、添付操作、revision競合を起こす2主体、ACL・通知・一覧設定を確認できる管理権限

トークン値、`.env`、Authorization header、顧客データを記録・commitしない。

## 再実行可能な手順

1. 実施者、日時、ホスト、OS、Node.js・kSQL-Flow・FlowNetのversion、各新規app IDを`measurements.md`へ記録する。
2. 3ノード直列DAGと、同一のNetwork Run・Invocation・Node State・Attemptデータセットを両案へ用意する。
3. NEW成功、中間Node失敗、resumeを各案で同じ回数だけ実行し、kintone API呼出数とrequest/response payload byte数を採取する。
4. Node Attemptのterminal更新後、Node State更新前に障害を注入し、再起動時のreconciliation結果と追加API数を記録する。
5. 同じrevisionからNode Stateを並行更新し、成功・競合・再GET・fail-closedの結果を記録する。
6. app 4249への到達不能を注入し、SQL開始前ゲート、復旧後の再GET、状態・監査側への影響を記録する。
7. 一覧、通知、ACL分離、archive、保持期間、テンプレート配布・移行、Network Lockの配置と回収操作を両案で確認する。
8. payloadからtoken、Authorization header、顧客値を除去し、API回数とpayload集計の算定方法を添える。
9. `decision-template.md`へ測定行IDを根拠としてD-08の判断候補を記入する。

## 中止条件

- 秘密情報または実顧客データがpayload・ログへ出力された。
- 対象app ID、profile、検証主体、障害注入点のいずれかを一意に確認できない。
- 既存app 4247／4246／4249を破壊的に変更する必要が生じた。
- AttemptやStateが一意に照合できず、追加書込みがデータ不整合を拡大するおそれがある。
- 片方の案だけ条件・回数・DAGが異なり、公平な比較を継続できない。
