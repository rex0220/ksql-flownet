# kSQL-FlowNet Run Activityプラグイン

実行管理アプリのカスタマイズビュー「00_Run状況」とNETWORK_RUNの詳細画面を拡張するデスクトップ用プラグインです。v5ではactivity表示に加え、ボード/詳細からの操作要求起票、未終端Runと要対応(終端)の2セクション表示、処理中の要求を示すpendingバッジを提供します。画面は補助表示であり、判断が割れた場合はCLI `status --json`を正とします。

## 設定と権限

プラグイン設定は次の3項目です。いずれも対象環境の役割名に対応するアプリIDを指定し、文書やコードへ実値を固定しません。

1. **監査履歴アプリID**: activityのlock owner照合に使います。
2. **操作要求アプリID**: RERUN/STOP/RELEASEの起票、重複ガード、pendingバッジに使います。
3. **JOBログアプリID**: 任意。終了済み・対応が必要なRunのエラー本文表示に使います。

一次対応者には、実行管理・監査履歴・設定時のJOBログアプリの閲覧権限と、操作要求アプリの閲覧・追加権限が必要です。runtimeでは実行管理・監査履歴・JOBログアプリはGET限定、操作要求アプリはGETと単票POSTだけを使用します。APIトークン、cursor、Bulk、PUT、DELETEは使用しません。

操作要求アプリIDが未設定の場合、起票ボタン・要求GET・pendingバッジは無効です。ただし要対応(終端)セクションは設定に関係なく追加されるため、zip更新だけでもボードの表示は変わります。

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
3. プラグイン設定を開き、対象環境の監査履歴アプリID、操作要求アプリID、任意のJOBログアプリIDを入力して保存し、アプリ設定を反映します。APIトークンは使用しません。
4. [`templates/add-run-board-view.console.js`](../templates/add-run-board-view.console.js)を[`templates/README.md`](../templates/README.md)の手順で実行し、「00_Run状況」を追加します。
5. ボードとNETWORK_RUN詳細を表示し、CLI `status --json`とのread-only smoke比較を行います。

## 本番への更新手順(v5)

1. 更新前に、要対応(終端)セクションが追加されてボードの見た目が変わることを**一次対応者へ表示変更を周知**します。
2. 同じ署名鍵で作成したv5のzipをkintoneシステム管理へ読み込み、既存プラグインを更新します。
3. 本番の実行管理アプリでプラグイン設定を開き、監査履歴アプリに加えて**本番の操作要求アプリ**を指定し、保存・アプリ設定反映を行います。
4. ボードが2セクションで表示されること、pendingバッジと状態別ボタンが仕様どおりであることを確認します。
5. テスト用Runから要求を1件起票し、操作要求レコードの作成者、最終`DONE/REJECTED`と`result_code`を確認します。実行管理・監査履歴アプリへのwriteがないことも確認します。

切戻しは、直前の同一プラグインIDのzipへ更新し、アプリ設定を反映します。操作要求アプリIDを空にするだけでも起票機能は無効になりますが、v5の要対応(終端)セクションは残ります。

## 実機で確定した設定画面の制約

- **`config.html`はフラグメントにする**: kintoneはファイル内容を設定ページへ埋め込むため、doctypeや`html` / `head` / `body`を含む完全なHTML文書ではDOMが展開されません。
- **DOMContentLoadedまで待つ**: 設定画面ではHTMLのDOM挿入前にJavaScriptが実行される場合があります。`document.readyState === "loading"`では、要素の取得とイベント登録を`DOMContentLoaded`まで遅延します。
- **`$PLUGIN_ID`は読込時に捕捉する**: `kintone.$PLUGIN_ID`はプラグインJavaScriptの同期読込中に取得し、後から実行される処理へ値を渡します。DOMContentLoaded後に読み直しません。
- **設定コードをdesktop bundleから分離する**: 設定画面の設置処理には副作用があります。desktop側が共有する検証処理は副作用のない`config-validation.ts`へ置き、`config.ts`をdesktop bundleへ混入させません。

プラグインはデスクトップ専用です。mobile bundleはありません。
