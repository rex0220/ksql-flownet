# kSQL-FlowNet 導入手順書(Claude Code 併用版)

[導入手順書](./installation.md)の手順を、Claude Code に任せる部分と人が行う部分に分け、そのまま貼れる指示文と、AI に守らせる規約を示す。手順番号は導入手順書と同じである。本文の手順そのものは導入手順書が正であり、本書は分担と指示文だけを扱う。

## 前提

- Claude Code を **ジョブ資材リポジトリ**(ksql-flow-template から作った自分のリポジトリ)で開く。kSQL-Flow のジョブ作成と同じ作業場所であり、`CLAUDE.md` に下記の規約断片を追記しておく
- 作業 PC から実行サーバーへ SSH 鍵で root 接続できる(`ssh -i <鍵> root@<サーバー>`)。Claude Code はこの SSH を使ってサーバー上のコマンドを実行する
- Claude Code のコマンド実行は既定どおり**ユーザーが 1 件ずつ承認する**。サーバーに対する変更を無承認で流す設定にはしない
- API トークンの値は AI に渡さない。AI が作る環境ファイルはトークン値が空の雛形であり、値の転記は人が SSH でエディタを開いて行う

## 分担

| 手順 | Claude Code | 人 |
| --- | --- | --- |
| 1 前提 | サーバーの初期設定(タイムゾーン・git・ufw・Node.js 22)と、Node.js・git・外向き HTTPS の確認を SSH で行い報告 | VPS の作成・SSH 鍵の登録・受信は SSH のみ許可(事業者のコンソール)、kintone の用意 |
| 2 プラグイン読込・テンプレートから 4 アプリ作成 | なし(ブラウザ操作) | 実施。4 アプリの ID を AI に伝える |
| 3 API トークン | なし | 発行。値は AI に渡さず、手順 8 で自分が転記 |
| 4 アクセス権 | Console スクリプトの説明。適用後に API でフィールド構成を確認して報告 | Console スクリプトの実行 |
| 5 プラグイン設定 | START 許可 CSV の行を allowlist と同じ内容で作文 | 設定画面へ貼り付けて保存 |
| 6 kSQL-Flow とジョブ資材 | clone、`npm install`、`.env` 雛形、`validate --check-logapp` の実行と報告 | `.env` へトークン値を転記 |
| 7 kSQL-FlowNet 本体 | clone、`npm ci`、`npm run build`、`--version` の確認 | なし |
| 8 環境ファイル・network 定義・allowlist・起動スクリプト | 雛形作成(0600・LF)、既存ジョブからの network.yaml 起案、`validate`・`plan`、allowlist・起動スクリプトの作成 | 環境ファイルへトークン値を転記。network.yaml と `app_start` のレビュー |
| 9 検証と初回 smoke | `poll-requests --check`、初回定期実行、`status --json`、取消済み確認と手動ポーラー実行、結果照合 | 一次対応者アカウントでのボードからの起票と取消 |
| 10 cron 登録 | crontab のバックアップと 2 行の追加、次周期のログ確認 | 発火時刻の決定 |
| 11 引き継ぎ | 文書の所在を整理して報告 | 一次対応者への周知 |

## 指示文(手順順)

サーバーの接続情報は最初に 1 度だけ伝える。以降の指示文は `<サーバー>` を含めなくてよい。

**手順 1**(サーバーが素の状態なら、先に初期設定)

```
実行サーバー(ssh -i <鍵> root@<サーバー>)に接続し、次の初期設定を行って。
1. timedatectl でタイムゾーンを Asia/Tokyo にする
2. apt update と git・ufw の導入、ufw で OpenSSH だけ許可して有効化
3. NodeSource の apt リポジトリから Node.js 22 を導入
4. node --version、git --version、timedatectl、ufw status の結果を報告して
コマンドは実行前に 1 つずつ見せて。パスワードやトークンは扱わないこと。
```

(初期設定済みなら確認だけ)

```
実行サーバー(ssh -i <鍵> root@<サーバー>)で Node.js のバージョン、git の有無、
https://<subdomain>.cybozu.com への HTTPS 疎通を確認して報告して。何も変更しないこと。
```

**手順 4**(人が Console スクリプトを実行した後)

```
操作要求アプリ <ID> のフィールド構成とフィールドアクセス権を kintone REST API で読み取り、
installation.md 手順 4 の表と一致するか報告して。閲覧のみのトークンを使い、書き込みはしないこと。
```

**手順 5**

```
allowlist で app_start: true にする network は <network_id> だけ。プラグインの
「START を許可するネットワーク」に貼る CSV 行を、表示名 <表示名>、入力モード <定期|補正|任意キー> で作って。
```

**手順 6**

```
installation.md 手順 6 に従い、サーバーの /opt/ksql に <ジョブ資材リポジトリ URL> を my-ksql-jobs として clone し、
npm install まで実行して。.env は .env.example からトークン値が空のまま 0600 で作成し、
私がトークンを転記したら validate --check-logapp を実行して結果を報告して。
```

**手順 7**

```
installation.md 手順 7 に従い、/opt/ksql/ksql-flownet に kSQL-FlowNet を clone、npm ci、npm run build して、
node dist/cli/index.js --version の出力を報告して。
```

**手順 8**

```
installation.md 手順 8.1 の形式で /root/.ksql-flownet.env をトークン値を空にした雛形で作成して(0600、LF、export 形式)。
アプリ ID は 実行管理=<ID> 監査履歴=<ID> 操作要求=<ID> JOBログ=<ID>、プロファイルは prod。
作成後、含まれる変数名の一覧だけを報告して(値は出力しない)。
```

```
jobs/<既存ジョブ>.sql を 1 ノードとする network を flownet/<flow 名>/network.yaml として起案して。
network_id は <network_id>、月次(scheduled_period, month, Asia/Tokyo)、全ノード idempotent: true。
SQL は flownet/<flow 名>/jobs/ へ移動せず、../../jobs/ の相対パスで参照して。
validate と plan --scheduled-for <当月 1 日 T00:00:00+09:00> を実行し、結果を報告して。
```

```
/root/flownet-request-allowlist.yaml を installation.md 手順 8.3 の形式で作成して(0600)。
app_start: true は <network_id> だけ。run_<flow 名>.sh を手順 8.4 の形式で作成し実行権限を付けて。
```

**手順 9**

```
installation.md 手順 9 に従い poll-requests --check を実行して exit code と出力を報告して。
exit 0 でなければ cron 登録に進まず、原因を報告して止まって。
```

```
初回の定期実行 ./run_<flow 名>.sh を実行し、exit code、status <network_id> --profile prod --json の Run 状態、
監査履歴とJOBログに相関付きレコードができたことを報告して。
```

(人が一次対応者のアカウントでボードから START を起票して取消した後)

```
操作要求アプリの未処理要求が #<ID> の 1 件だけで、その request_state が REQUESTED、cancel_requested が 取消 であることを
API で確認して。確認できなければポーラーを実行せず報告して。確認できたらポーラーを 1 回手動実行し、
出力の requested/claimed/cancelled と、操作要求レコードの request_state と result_code を報告して。
```

**手順 10**

```
crontab を /root/crontab.bak-<日付> にバックアップしてから、installation.md 手順 10 の 2 行を追加して
(定期実行は <cron 式>、ポーラーは */5)。5 分後に /var/log/ksql/flownet-requests.log の末尾を確認して報告して。
```

## 期待する報告

AI の報告はこの表と突き合わせる。一致しない場合は次の手順へ進まない。

| 手順 | 確認するもの | 期待 |
| --- | --- | --- |
| 6 | `validate --check-logapp` | `OK: ログアプリ … 8.2 のフィールド定義を満たしています` |
| 7 | `--version` | 導入したい版(例: `1.0.0`) |
| 8 | `validate` / `plan` | exit 0。`plan` の業務キーが `<network_id>@YYYY-MM` |
| 9 | `poll-requests --check` | exit 0 |
| 9 | 初回定期実行 | exit 0。`status --json` の Run が `SUCCESS` |
| 9 | 手動ポーラー | `requested=1 claimed=0 … cancelled=1`。要求は `CANCELLED / CANCELLED_BY_REQUESTER`、Run は作られない |
| 10 | ポーラーログ | 5 分ごとに `poll-requests: requested=0 …` が増える |

## CLAUDE.md へ追記する規約断片

ジョブ資材リポジトリの `CLAUDE.md` 末尾に貼る。ksql-flow-template の既存規約(ジョブ SQL の作成・dry-run まで、本実行は人)に FlowNet の分担を足すものである。

````markdown
## kSQL-FlowNet(network 実行・サーバー構築)の規約

- 手順の正は ksql-flownet の docs/installation.md。手順番号で指示されたら該当節を読んでから作業する
- **トークン値を扱わない。** 環境ファイル(`/root/.ksql-flownet.env`、`.env`)は値を空にした雛形だけを作り、値の転記は人が行う。
  ファイルを読むときは変数名だけを報告し、値をチャット・ログ・コミットへ出さない
- サーバー上のファイルは **LF・root 所有・0600**(環境ファイル・allowlist)。Windows の改行を混入させない
- `git add` は明示パスのみ。`.env`・鍵・環境ファイルを追加しない
- network 定義: 1 network = 1 YAML(`flownet/<flow>/network.yaml`)。SQL は YAML からの相対パス。
  全ノード `idempotent: true` を明示(ボードから START する条件)。`<profile>:<job_id>` は 64 文字以内。
  作成後は `validate` と `plan` を実行してから報告する
- allowlist の `app_start: true` は人が名指しした network だけに付ける。省略は false
- **cron を登録する前に `poll-requests --check` が exit 0 であること**を報告し、非 0 なら止まる
- 初回の定期実行(`run-network`)は業務データへ書き込む。人の指示があるときだけ実行し、dry-run 済みの SQL 以外を network に載せない
- サーバー変更(crontab・環境ファイル・allowlist)は変更前にバックアップを取り、変更後に内容(値を除く)を報告する
````
