# kSQL-FlowNet Run Activityプラグイン

実行管理アプリのカスタマイズビュー「00_Run状況」とNETWORK_RUNの詳細画面へ、read-onlyのactivity表示を追加するデスクトップ用プラグインです。画面は補助表示であり、判断が割れた場合はCLI `status --json`を正とします。

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
3. プラグイン設定を開き、対象環境の監査履歴アプリIDを入力して保存し、アプリ設定を反映します。APIトークンは使用しません。
4. [`templates/add-run-board-view.console.js`](../templates/add-run-board-view.console.js)を[`templates/README.md`](../templates/README.md)の手順で実行し、「00_Run状況」を追加します。
5. ボードとNETWORK_RUN詳細を表示し、CLI `status --json`とのread-only smoke比較を行います。

## 実機で確定した設定画面の制約

- **`config.html`はフラグメントにする**: kintoneはファイル内容を設定ページへ埋め込むため、doctypeや`html` / `head` / `body`を含む完全なHTML文書ではDOMが展開されません。
- **DOMContentLoadedまで待つ**: 設定画面ではHTMLのDOM挿入前にJavaScriptが実行される場合があります。`document.readyState === "loading"`では、要素の取得とイベント登録を`DOMContentLoaded`まで遅延します。
- **`$PLUGIN_ID`は読込時に捕捉する**: `kintone.$PLUGIN_ID`はプラグインJavaScriptの同期読込中に取得し、後から実行される処理へ値を渡します。DOMContentLoaded後に読み直しません。
- **設定コードをdesktop bundleから分離する**: 設定画面の設置処理には副作用があります。desktop側が共有する検証処理は副作用のない`config-validation.ts`へ置き、`config.ts`をdesktop bundleへ混入させません。

プラグインはデスクトップ専用です。mobile bundleはありません。
