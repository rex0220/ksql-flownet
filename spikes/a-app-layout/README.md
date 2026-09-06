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

## Consoleスクリプトによるアプリ作成

ブラウザ用スクリプトは[`console/`](./console/)にある。2アプリ案と1アプリ案は比較対象なので、同じスペースへ次の順で作成する。

1. kintoneへアプリ作成・管理権限のあるアカウントでログインし、作成先スペースのポータル（URLが`/k/#/space/<spaceId>`となるページ）を開く。
2. ブラウザの開発者ツールでConsoleを開き、[`create-spike-apps-2app.console.js`](./console/create-spike-apps-2app.console.js)の内容を丸ごと貼り付けて実行する。
3. スクリプトがフィールド追加、record type別フォームレイアウト設定、record type別一覧設定をpreviewへ順に行う。表示されたアプリ名・ID・フィールド数・レイアウトセクション数・一覧数を確認し、確認ダイアログでOKを押して2アプリをデプロイする。
4. デプロイ完了後、同じスペースポータルで[`create-spike-app-1app.console.js`](./console/create-spike-app-1app.console.js)を同様に実行し、フィールド・レイアウト・一覧のサマリを確認してデプロイする。
5. 各アプリの設定画面からAPIトークンを手動生成する。APIトークンはREST APIでは生成できない。変数名の正は[`tests/e2e/env.e2e.example`](../../tests/e2e/env.e2e.example)とする。書込可トークン（閲覧・追加・編集・削除）は`KSQL_SPIKE_TOKEN_EXEC`／`KSQL_SPIKE_TOKEN_AUDIT`／`KSQL_SPIKE_TOKEN_INTEGRATED`としてOS環境変数へ、閲覧のみトークンは`_RO`付きの同名変数として`.env`へ設定する（OS環境変数が優先）。値はリポジトリやConsoleへ記録しない。
6. 作成された3つのapp IDを`KSQL_SPIKE_APP_EXEC`／`KSQL_SPIKE_APP_AUDIT`／`KSQL_SPIKE_APP_INTEGRATED`として`.env`へ設定し、[`measurements.md`](./measurements.md)の環境欄へも記録する。

スクリプトはURLからスペースIDを自動判定する。判定できないURL構成では、各ファイル冒頭の`SPACE_ID_OVERRIDE`へスペースIDを指定する。同名アプリが既にある場合は既存アプリを変更せず中止する。処理順は「フィールド追加 → レイアウト設定 → 一覧設定 → `console.table`による作成サマリ → 確認 → デプロイ」である。レイアウト設定時はpreviewレイアウトを取得し、kintoneの自動生成フィールドをSystemセクションへ保持してから全レイアウトを更新する。レイアウトと一覧は各設計書の「フォームレイアウト」「一覧（ビュー）」を正とし、一覧更新は新規アプリの既定一覧を設計書記載の一覧で置き換える。途中で失敗またはデプロイ確認をキャンセルした場合は、Consoleの「失敗したステップ」と表示されたapp IDを確認し、kintoneのアプリ管理画面からpreviewの「変更を中止」を行う。

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

## スクリプトによる実行

リポジトリ直下で、次の順に実行する。各スクリプトは1アプリ案、2アプリ案の順に同一データと同一操作列を適用し、両案を1つの結果JSONへ並記する。Node.jsの`--env-file`で`.env`を読むが、同名のOS環境変数が設定されている場合はそちらが優先される。

```powershell
node --env-file=.env spikes/a-app-layout/scripts/scenario-new-success.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-mid-failure.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-resume.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-reconciliation.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-state-revision-conflict.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-audit-unreachable.mjs
```

結果は`spikes/a-app-layout/results/<UTC日時>-<スクリプト名>.json`へ保存される。各layoutにはAPI呼出数、request/response payload byte合計とcall別内訳、所要時間、操作順、D-08向けfinding、清掃結果が入る。監査到達不能シナリオは2アプリ案だけが対象で、fetch wrapperによる障害注入でありkintone実挙動ではないことも結果へ明記される。

`measurements.md`への転記対応は次のとおり。

| 実行スクリプト                         | 測定行     |
| -------------------------------------- | ---------- |
| `scenario-new-success.mjs`             | A-01、A-12 |
| `scenario-mid-failure.mjs`             | A-02、A-12 |
| `scenario-resume.mjs`                  | A-03、A-12 |
| `scenario-reconciliation.mjs`          | A-04       |
| `scenario-state-revision-conflict.mjs` | A-05       |
| `scenario-audit-unreachable.mjs`       | A-06       |

通常のNetwork lock解放はrevision付きUPDATEによる一意キークリア方式であり、DELETEは使わない。スクリプト終了時のDELETEは作成レコードを片付けるテスト清掃専用である。失敗時は警告と残置IDが結果JSONおよび標準エラーへ出るため、対象のスパイクアプリで手動清掃する。

## 中止条件

- 秘密情報または実顧客データがpayload・ログへ出力された。
- 対象app ID、profile、検証主体、障害注入点のいずれかを一意に確認できない。
- 既存app 4247／4246／4249を破壊的に変更する必要が生じた。
- AttemptやStateが一意に照合できず、追加書込みがデータ不整合を拡大するおそれがある。
- 片方の案だけ条件・回数・DAGが異なり、公平な比較を継続できない。
