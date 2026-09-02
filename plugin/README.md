# kSQL-FlowNet Run Activityプラグイン

実行管理アプリのカスタマイズビュー「00_Run状況」とNETWORK_RUNの詳細画面を拡張するデスクトップ用プラグインです。配布version 2ではactivity表示、RERUN/STOP/RELEASE要求、未終端Runと要対応(終端)の2セクションに加え、ボードヘッダーの「新規実行」からSTART要求を起票できます。ヘッダーには「処理待ちのSTART要求 N件」も表示します。画面は補助表示であり、判断が割れた場合はCLI `status --json`を正とします。

## 設定と権限

プラグイン設定は次の4項目です。アプリIDは通常は空欄にし、実行管理アプリの`related_audit_events`、`related_requests`、`related_job_logs`から参照先を自動検出します。自動検出を上書きする場合だけ、対象環境のアプリIDを指定します。

1. **監査履歴アプリID**: activityのlock owner照合に使います。
2. **操作要求アプリID**: START/RERUN/STOP/RELEASEの起票、重複ガード、pending表示に使います。
3. **JOBログアプリID**: 任意。終了済み・対応が必要なRunのエラー本文表示に使います。
4. **STARTを許可するネットワーク**: 任意。VPSのallowlistで`app_start: true`を付けたネットワークを、`ネットワーク名, network_id[, 入力モード[, business_keyテンプレート]]`のCSV形式で1行ずつ登録します。3列目は`定期`、`補正`、`任意キー`のいずれかで、選択時の入力モードを初期設定します。4列目は`補正`または`任意キー`だけに指定でき、`{ネットワークID}`、`{年}`、`{月}`、`{日}`を使って対象期間からbusiness_keyを自動入力します（`定期`には指定不可）。例: `月次案件集計(当月分の起動), monthly_deal_summary, 定期`、`月次案件集計(補正), monthly_deal_summary, 補正, {ネットワークID}@{年}-{月}-correction-1`。旧形式の`network_id`だけ、または`ネットワーク名, network_id`の行も使用できます。二重管理ですが、起動可否の正はサーバー側です。一覧にない値も「その他(自由入力)」から起票でき、許可外の値はポーラーが拒否します。

一次対応者には、実行管理・監査履歴・検出または設定したJOBログアプリの閲覧権限と、操作要求アプリの閲覧・追加権限が必要です。runtimeでは自動検出用のフォームフィールドGET、実行管理・監査履歴・JOBログ・操作要求アプリのレコードGET、操作要求アプリの単票POSTだけを使用します。APIトークン、cursor、Bulk、PUT、DELETEは使用しません。フォームフィールドGETが権限またはAPIエラーで失敗した場合は、保存済み設定だけで動作します。

操作要求アプリIDが未設定の場合、「新規実行」を含む起票ボタン・要求GET・pending表示は無効です。STARTの参考候補はダイアログを開いた時だけ、操作要求アプリの`DONE`実績と実行管理アプリのRun実績から取得します。候補はallowlistではなく入力支援であり、起動可否はサーバー側の`app_start`、network定義、冪等性検証が決定します。

JOBログアプリIDが未設定、GET失敗、または該当ログなしの場合、エラー概要は従来のnode/result_code/status_reason表示へfail-openします。JOBログへの書込みは行いません。

## 開発

リポジトリルートで実行します。

```powershell
npm run build:plugin
npm run test:plugin
```

`build:plugin`は`plugin/dist/`へdesktop・config・activityのbundleを生成します。`test:plugin`はbundleを再生成し、共有activity vectorを含むプラグイン単体テストを実行します。

## packと署名鍵

署名秘密鍵はリポジトリ外へ保管します。保管先の例は`C:\Users\rex02\.ksql-flownet\flownet-activity-plugin.ppk`です。秘密鍵と生成zipはcommitしません。

```powershell
npm run build:plugin
npm exec -- kintone-plugin-packer --ppk "C:\Users\rex02\.ksql-flownet\flownet-activity-plugin.ppk" --out plugin/zip/ksql-flownet-activity.zip plugin
```

初回に確定した同一の秘密鍵を、更新版のpackでも必ず指定してください。プラグインIDは署名鍵から決まるため、同じ鍵でpackし続ければ既存プラグインを同じIDのまま更新できます。鍵を紛失して別の鍵でpackすると別プラグイン扱いになるため、保管先のバックアップと復元確認を行います。鍵を指定しないpackは更新用releaseでは使用しません。

## インストール

1. kintoneシステム管理の「プラグイン」で、生成したzipを読み込みます。
2. 対象の実行管理アプリの設定で、このプラグインを追加します。
3. プラグイン設定では、関連レコードと異なるアプリを使う項目だけアプリIDを入力し、VPSで`app_start: true`にしたネットワークをSTART許可ネットワーク一覧へ登録して、アプリ設定を反映します。APIトークンは使用しません。
4. [`templates/add-run-board-view.console.js`](../templates/add-run-board-view.console.js)を[`templates/README.md`](../templates/README.md)の手順で実行し、「00_Run状況」を追加します。
5. ボードとNETWORK_RUN詳細を表示し、CLI `status --json`とのread-only smoke比較を行います。

## 更新手順(version 2)

1. 更新前に、「新規実行」ボタンと処理待ちSTART件数が追加されることを一次対応者へ周知します。
2. 同じ署名鍵で作成したversion 2のzipをkintoneシステム管理へ読み込み、既存プラグインを更新します。
3. 本番の実行管理アプリでプラグイン設定を開き、監査履歴アプリに加えて**本番の操作要求アプリ**とSTART許可ネットワーク一覧を指定し、保存・アプリ設定反映を行います。
4. ボードが2セクションで表示され、「新規実行」、処理待ちSTART件数、既存のpendingバッジと状態別ボタンが仕様どおりであることを確認します。操作要求アプリIDを空にした環境ではSTART UIが表示されないことも確認します。
5. 「新規実行」を開き、3モード、候補2群、ネットワーク名の選択肢、選択中のnetwork_id補助表示と「その他(自由入力)」、注意文を確認します。許可済みの最小STARTを1件起票し、操作要求レコードの`network_id`、作成者、最終`DONE/REJECTED`と`result_code`、作成されたRunを相関します。実行管理・監査履歴アプリへのwriteがないことも確認します。

切戻しは、直前の同一プラグインIDのzipへ更新し、アプリ設定を反映します。操作要求アプリIDを空にすれば、新規STARTを含む起票UIだけを先に無効化できます。

## 実機で確定した設定画面の制約

- **`config.html`はフラグメントにする**: kintoneはファイル内容を設定ページへ埋め込むため、doctypeや`html` / `head` / `body`を含む完全なHTML文書ではDOMが展開されません。
- **DOMContentLoadedまで待つ**: 設定画面ではHTMLのDOM挿入前にJavaScriptが実行される場合があります。`document.readyState === "loading"`では、要素の取得とイベント登録を`DOMContentLoaded`まで遅延します。
- **`$PLUGIN_ID`は読込時に捕捉する**: `kintone.$PLUGIN_ID`はプラグインJavaScriptの同期読込中に取得し、後から実行される処理へ値を渡します。DOMContentLoaded後に読み直しません。
- **設定コードをdesktop bundleから分離する**: 設定画面の設置処理には副作用があります。desktop側が共有する検証処理は副作用のない`config-validation.ts`へ置き、`config.ts`をdesktop bundleへ混入させません。

プラグインはデスクトップ専用です。mobile bundleはありません。
