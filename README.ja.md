# kSQL-FlowNet

[English](./README.md) | 日本語

kSQL-FlowNetは、複数の[kSQL-Flow](https://www.npmjs.com/package/@rex0220/ksql-flow)ジョブをnetwork(DAG)として管理するControl Plane CLIです。network定義の検証、業務キー単位のRun一意性、依存関係に基づく直列実行、再開(resume)、Networkロック、状態保存、監査を担当します。分岐・合流を持つDAGを定義できますが、ノードは安定したトポロジカル順で1件ずつ直列実行します。

kintone上の「Run状況」ボードプラグインと操作要求アプリを組み合わせることで、リラン・停止・解除・新規実行(START)を画面から指示できます。

- **導入手順書**: [docs/installation.md](./docs/installation.md)(kintoneアプリ・トークン・プラグイン・サーバー・cronを0から本番運用まで)
- **仕様・運用文書**: [docs/README.md](./docs/README.md)(統合仕様書・一次対応1ページ・復旧runbook)
- **kintoneアプリの作成**: [templates/README.md](./templates/README.md)
- **ボードプラグイン**: [plugin/README.md](./plugin/README.md)
- **公開記事(Qiita)**: [kintone のバッチを「ジョブの網」として運用する — kSQL-FlowNet](https://qiita.com/rex0220/items/24470d6223c1b4ed4031)

## 動作環境

- kintone(APIトークン・プラグイン・関連レコード・アプリテンプレートを使用)
- 実行サーバー: Node.js 22以上。通信は実行サーバーからkintoneへのHTTPS発信のみで、kintoneから実行サーバーへの接続はない(受信ポート・固定IP・ドメイン不要)
- 詳細は[統合仕様書 §2 動作環境](./docs/specification.md)を参照

## インストール

```sh
npm install --global @rex0220/ksql-flownet
ksql-flownet --version
```

kintoneアプリ(同梱テンプレート)・APIトークン・ボードプラグイン・サーバー環境・cronまでの導入手順は[docs/installation.md](./docs/installation.md)にあります。

## 開発

```sh
npm install
npm run build
npm run format:check
npm run lint
npm run typecheck
npm test
```

## CLIの使い方

```sh
ksql-flownet --help
ksql-flownet --version
ksql-flownet validate path/to/network.yaml
ksql-flownet poll-requests --check
```

`validate`は、YAMLスキーマ・DAG規則・参照SQLファイルを、外部状態を変更せずに検証します。

`poll-requests`はkintone操作要求アプリのワンショットポーラーです。`REQUESTED`レコードをclaimし、`RERUN`・`STOP`・`RELEASE`・`START`を実行します。cron等のスケジューラから定期起動してください。設定は[`.env.example`](./.env.example)の`KSQL_FLOWNET_REQUEST_*`と、絶対パスのallowlistで行います:

```yaml
networks:
  - network_id: monthly_jobs
    definition_path: C:/srv/my-ksql-jobs/networks/monthly.yaml
    app_start: false
```

`app_start`はfail-closedです。省略は`false`と同じで、明示的なboolean `true`を設定したnetworkだけがSTART要求(アプリからの新規Run起動)の対象になります。このフラグは`RERUN`・`STOP`・`RELEASE`のRun検索対象からnetworkを外しません。

本番スケジュールを有効化する前に`poll-requests --check`を実行してください。これは読み取り専用の事前検査で、allowlistの全network定義と`network_id`を検証し、要求アプリへのGETアクセスを確認します。要求のclaim・更新や子プロセス(`status`・`run-network`・`cancel-run`)の起動は行いません。終了コードが0以外の場合はスケジュールを有効化しないでください。

各ノードは`KSQL_FLOWNET_PROFILE + ":" + nodes[].job_id`が64 UTF-16単位以内である必要があります。これはkSQL-Flowのジョブロックキーの実測上限です。現行の`validate`は超過を検出せず、実行時に`VALIDATION_ERROR`で失敗します。

WindowsでkSQL-Flowのソースビルドに対して`run-network`を実行する場合は、実行ファイルと先頭のCLIスクリプト引数を分けて設定します。引数に空白が含まれる場合はJSON配列形式を使ってください:

```powershell
$env:KSQL_FLOW_BIN = 'node.exe'
$env:KSQL_FLOW_BIN_ARGS = '["C:\\path\\to\\ksql-flow\\dist\\cli.js"]'
```

`KSQL_FLOW_BIN_ARGS`は空白区切りの引数も受け付けます。スタンドアロン実行ファイルを使う場合は、`KSQL_FLOW_BIN`へ実行ファイルを指定し、`KSQL_FLOW_BIN_ARGS`は未設定にできます。

## 実機E2E

[`tests/e2e/README.md`](./tests/e2e/README.md)に記載の実機環境を設定したうえで、各シナリオをPowerShellから直列に実行します。これらは設定済みのkintoneとkSQL-Flow環境へアクセスするため、CIでは実行しないでください。各シナリオは`tests/e2e/results/`へサニタイズ済みの結果JSONを書き出し、自分のスコープの状態を清掃します。

## ライセンス

MIT。[LICENSE](./LICENSE)を参照してください。
