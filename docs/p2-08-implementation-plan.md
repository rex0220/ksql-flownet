# P2-08: 案A v1 導出プラグイン 実装計画

- 文書状態: **DRAFT / 仕様レビュー完了・実装未着手**
- 作成日: 2026-09-01
- 対象仕様: [p2-08-activity-plugin-spec.md](./p2-08-activity-plugin-spec.md)
- 正本: [job-network-phase1-spec.md](./job-network-phase1-spec.md) §7.4、`tests/fixtures/status-activity/vectors.json`
- 制約: プラグイン実行時はレコード取得GETだけを使用し、レコードの登録・更新・削除を行わない。FlowNet orchestration本体は変更しない

## 1. 結論

P2-08は実現可能であり、`deriveRunActivity`のexport追加やFlowNet orchestration本体の変更は不要である。ただし、DRAFT仕様は次の4点を実装前提として補正する必要がある。

1. `deriveRunActivity`自体はブラウザで実行できる純関数だが、所在する`status.ts`は「依存なし」ではない。専用entryからnamed importし、esbuild後のbundleに`node:` import、`require`、`process`が残らないことを機械検査する。
2. カスタマイズビューの`html`へプラグイン専用root要素を置き、`app.record.index.show`で`viewType === "custom"`かつ`viewName === "00_Run状況"`のときだけ描画する。内部DOM classには依存しない。
3. `RUN_INVOCATION`を未終端Runごとに全件取得しない。現在の`NETWORK_LOCK.owner_invocation_id`だけを監査履歴アプリへ一括照合し、`invocation_id -> run_id`を作る。これは`deriveRunActivity`のowner所属判定と意味的に等価である。
4. `CANCEL_REQUEST`の状態は`status`フィールドではなく、`status_reason`内のJSONに格納されている。JSON構造、state、run_id、重複を検証し、異常時は該当activityを表示しない。

典型的なボード描画は、未終端Run、active Lock、Cancel、lock owner Invocationの4系統GETで完了する。500件またはクエリチャンク境界を超えた場合だけ呼数が増えるため、DRAFT §4の「3〜5 GET」は固定保証ではなく**通常件数での目安**として扱う。

管理者が行うカスタマイズビュー追加は`/k/v1/preview/app/views.json`への設定PUT、設定画面の保存は`kintone.plugin.app.setConfig()`である。これらは導入時の設定操作であり、プラグインの一覧・詳細画面でレコードを書き込む設計には含めない。実行時の`/k/v1/record(s).json`はGETだけとする。

## 2. 仕様レビュー所見

判定は次の意味で用いる。

- **CORRECT**: 正本・既存実装と整合し、そのまま実装可能
- **FLAWED**: 記述どおりでは不正確、非効率または受入不能であり、実装前の補正が必要
- **NEEDS-CLARIFICATION**: 複数の解釈が成立し、受入判定が一意にならない

### 2.1 導出関数とbundle境界

1. **CORRECT — activityの優先順位と共有vectorは凍結定義に一致する。**
   - 凍結仕様は、終端なら`null`、未終端ではSTOPPED、LIVE、IDLE、INTERRUPTEDの順に判定する（`docs/job-network-phase1-spec.md:580`）。
   - 実装も同じ順で、`REQUESTED / ACCEPTED`をLIVEより優先し、leaseを60秒保守判定する（`src/orchestration/status.ts:131`、`src/persistence/kintone/design-notes.ts:13`）。
   - 共有vectorは15ケースあり、終端4値、STOPPED優先、RELEASED、leaseの-59/-60/-61秒境界、foreign owner、IDLE/INTERRUPTEDを含む。プラグインbundleも同じJSONを直接読む。

2. **FLAWED — DRAFT §3の「依存なしの純関数」は、関数と所在moduleを混同している。**
   - `ActivityInput`の`NetworkRun`、`CancelRequestState`、`NetworkLockStatus`はtype-only importなのでbundle時に消える（`src/orchestration/status.ts:1-11,56-62`）。関数本体が実行時に参照するrepo定数は`KINTONE_DATETIME_TRUNCATION_MS`だけで、Node組込みAPI、I/O、現在時刻取得、共有可変状態を使わない。この意味では、同じ入力に同じ結果を返すブラウザ実行可能な純関数である。
   - 一方、`status.ts`全体には`RepositoryError`と`detectReconciliation`のruntime importがあり（`src/orchestration/status.ts:13,18`）、後者のmoduleは`node:crypto`をimportする（`src/orchestration/reconciliation.ts:1`）。従ってmodule自体を「依存なし」とは呼べない。
   - 補正: `plugin/src/activity-entry.ts`は`deriveRunActivity`だけをnamed import/re-exportする。esbuildのtree shaking後にブラウザ非互換依存が消えることを、metafileとbundle文字列検査、Node `vm`実行で受入する。CLI側の実装を複製しない。

3. **CORRECT — 現在のexport状況で単体bundle可能であり、後方互換変更は不要である。**
   - `ActivityInput`と`deriveRunActivity`はいずれも既にexportされている（`src/orchestration/status.ts:56,131`）。
   - orchestration変更の予備案は現時点では起票しない。実際のesbuildでtree shaking不能が確認された場合だけ、ブラウザ中立moduleへの移動と`status.ts`からのre-exportを「必要な後方互換変更」として別レビューへ戻す。これはM1の失敗時条件であり、先回りして実装しない。

4. **CORRECT — esbuildとplugin-packerはbuild-only依存として追加できる。**
   - 現行のcompiler、lint、format関連はすべて`devDependencies`であり、実行時依存は`ajv`と`yaml`だけである（`package.json:28-39`）。`esbuild`と`@kintone/plugin-packer`も`devDependencies`に置く方針と衝突しない。
   - rootの`files`は`dist`と`schemas`だけなので、`plugin/`や署名鍵、zipが将来のnpm packageへ意図せず入らない（`package.json:12-15`）。加えてplugin出力と`*.ppk`を`.gitignore`へ明示する。
   - `npm run build`は既存TypeScript製品buildの意味を維持し、`build:plugin`、`test:plugin`、`pack:plugin`を別scriptにする。通常testで署名鍵やzip生成を要求しない。

### 2.2 カスタマイズビューと詳細画面

5. **FLAWED — DRAFT §2.1/§5だけではカスタマイズビューのHTML挿入点が定義されていない。**
   - 実現方式は、カスタマイズビューの`html`を`<div id="ksql-flownet-run-board" aria-live="polite"></div>`とし、この公開された自前要素だけを描画先にする。
   - `desktop.js`は`app.record.index.show`へ登録し、`event.viewType === "custom"`かつ`event.viewName === "00_Run状況"`でguardする。一覧IDは環境ごとに変わるためplugin設定へ保存しない。イベントはページ送り等でも再発火するため、rootを`replaceChildren()`して二重描画を防ぐ。
   - kintone内部のclass/id探索、一覧tableの置換、`kintone.app.getHeaderSpaceElement()`へのボード本体描画は採用しない。公式仕様上、一覧表示後イベントはcustom viewでも発火し、`viewId`、`viewName`、`viewType`を返す。

6. **CORRECT — REST APIで`type: "CUSTOM"`の一覧を追加できる。**
   - `templates/add-run-board-view.console.js`は既存一覧をGETして全件保持したまま、次の設定をmergeする。views PUTは省略した既存一覧を削除するため、追加対象だけをPUTしてはならない。
   - GET応答の`id`、`builtinType`等の読取専用propertyをPUTへ戻さない。組込み一覧は`type/index`だけ、通常一覧は更新APIが受け付けるpropertyだけに正規化する。
   - 追加値は`name: "00_Run状況"`、`type: "CUSTOM"`、上記`html`、`pager: false`、`device: "DESKTOP"`、未終端NETWORK_RUNの`filterCond`、既存実測に合わせた単一キー`sort: "updated_at desc"`、`index: "0"`とする。他の一覧は現在の相対順を保って1以降へ振り直す。
   - `name`はobject keyと同値で必須、API URLは`kintone.api.url("/k/v1/preview/app/views.json", true)`とする。既存の実測回帰（`templates/create-flownet-request-app.console.js:143-191`、`tests/unit/request-template.test.mjs:35-43,100-124`）を新テンプレートtestにも適用する。
   - CUSTOM一覧の追加にはkintoneシステム管理権限が必要である。Consoleスクリプトはpreview設定のPUTと明示確認後のdeployだけを行い、レコードAPIは呼ばない。

7. **CORRECT — 詳細画面の表示場所は公開APIで確保できる。**
   - `app.record.detail.show`で`event.record.record_type.value === "NETWORK_RUN"`のときだけ処理し、`kintone.app.record.getHeaderMenuSpaceElement()`へ専用containerを1個追加する。
   - 終端statusは依存データを取得せず「終端(activityなし)」を表示する。未終端だけboardと同じloader/assemblerを使う。
   - container IDで再発火時の増殖を防ぎ、表示値は`innerHTML`連結ではなく`textContent`/DOM APIで設定する。business key、run ID、reason等をHTMLとして解釈しない。

### 2.3 データ取得、CANCEL_REQUEST、fail-closed

8. **FLAWED — DRAFT §4をRun単位取得として実装するとN+1になり、3〜5 GETの目安を満たさない。**
   - 製品repositoryの`getInvocations(runId)`は1 Runずつ監査履歴アプリをページングする（`src/persistence/kintone/repository.ts:650-661`）。これを未終端Run数Nに対して呼ぶと、少なくともN GETにInvocation履歴ページ数が乗る。
   - activityに必要なのは「現在のlock ownerが当該RunのInvocation集合に含まれるか」だけで、過去Invocation全件ではない。active `NETWORK_LOCK`を一括取得し、その`owner_invocation_id`集合だけを監査履歴アプリの`invocation_id in (...)`で取得する。返った`run_id`が未終端Runと一致するときだけ、そのRunの`ActivityInput.invocationIds`へowner IDを1件入れる。
   - この縮約は`invocationIds.includes(lock.owner_invocation_id)`の真偽を保存するため、導出結果を変えない。未知owner、重複owner、同一ownerが複数runへ対応する異常はfail-closedにする。

9. **FLAWED — DRAFTの「NETWORK_LOCKはnetwork_id単位」という取得説明は実レコードと一致しない。**
   - active Lockレコードは`lock_key`、`profile`、`owner_invocation_id`を持つが、`network_id`は保存しない（`src/persistence/network-lock.ts:151-160`）。`lock_key`はprofile/network IDのSHA-256由来で、生成実装は`node:crypto`依存である。
   - pluginでlock key生成を複製せず、owner Invocationの`run_id`をjoin keyに使う。これによりNode暗号APIのbrowser移植も不要になる。
   - 同一Runへ複数active Lockが対応する、または1つのLock owner照合が複数Invocationを返す場合はデータ不整合として、そのRunのactivityを表示しない。

10. **FLAWED — ページング方式とquery chunkが未確定である。**
    - `/k/v1/records.json`は1回最大500件、offsetは10,000件上限があるため、全取得は`$id > lastId order by $id asc limit 500`のkeyset pagingとする。各pageで最後の`$id`が単調増加しない場合は中止する。
    - 未終端Run、active Lockはそれぞれ全pageを読む。Cancelのrun ID集合とowner Invocation ID集合は、件数とエスケープ後query長の両方で保守的にchunk化し、各chunk内もkeyset pagingする。
    - 取得fieldを必要最小限に限定する。典型呼数は4 GETだが、保証式は`P(run) + P(lock) + ΣP(cancelChunk) + ΣP(ownerChunk)`であり、件数依存である。
    - 手動再読込の多重clickと画面遷移には世代番号を付け、古い非同期応答で新しい表示を上書きしない。

11. **FLAWED — CANCEL_REQUESTの`cancel_state`を直接fieldとして読むことはできない。**
    - 永続化実装は`state`、要求者、理由、要求/受理/解除時刻等をJSON化し、`status_reason`へ保存する（`src/persistence/kintone/repository.ts:259-275`）。`decodeCancelRequest`もJSON parse後に`state`が`REQUESTED / ACCEPTED / RELEASED`のいずれかを検証する（同:278-301）。
    - plugin側parserも、fieldの存在と文字列型、JSON parse成功、非null objectかつ非Array、own propertyの`state`、許可3値を検証する。さらにrecordの`record_type`、`run_id`、`record_key === "CANCEL:" + run_id`、対象Runとの一致、1 Run 1件を検証する。
    - parse失敗、未知state、重複、run不一致を`null`扱いしてINTERRUPTED/LIVEへ倒してはならない。該当行を「判定不能」とし、エラー理由とCLI確認導線を表示する。

12. **CORRECT — 設定画面は監査履歴アプリIDの1項目で足りる。**
    - 実行管理アプリIDは`kintone.app.getId()`、viewはname/type guardで特定でき、API tokenは使用しない。追加のprofile、network、view ID設定は不要である。
    - 保存形式は`kintone.plugin.app.setConfig({ auditAppId: "<10進文字列>" })`とする。設定APIはvalueを文字列で保存するため、数値化して再保存しない。keyはASCII互換の`auditAppId`に固定する。
    - 保存時と読込時の両方で`^[1-9][0-9]*$`を検証する。未設定・空・不正なら一覧/詳細ともGETを開始せず、設定が必要であることを明示する。tokenや実アプリIDをsource、fixture、文書へ書かない。

13. **NEEDS-CLARIFICATION — fail-closedの表示単位を仕様へ固定する必要がある。**
    - 本計画では、Run/Lock/監査API全体の失敗はボード全体を判定不能とする。Cancelだけの構造異常は影響するRun行だけを判定不能とし、他Runの正しい結果は表示してよい。
    - ただし「一部だけ表示すると全件取得済みに見える」事故を避けるため、ページまたはchunkの通信失敗は部分結果を破棄する。判定不能行は4色badgeを使わず、最終成功判定時刻も更新しない。
    - 詳細画面も同じ原則とし、依存GET失敗時に推測値を表示しない。DRAFT受入5の「誤ったactivityを表示しない」はこの粒度で試験する。

14. **CORRECT — browser時刻のリスク説明とCLI優先は妥当である。**
    - `deriveRunActivity`へ渡す`nowMs`は1回の読込開始時に固定し、同じboard内の全Runで共有する。非同期取得完了ごとに`Date.now()`を取り直さない。
    - 表示する判定時刻もこの値と一致させる。時計ずれをpluginだけで解消しようとせず、不審時はCLIを正とするrunbook記述を維持する。

15. **NEEDS-CLARIFICATION — 「書込みゼロ」の観測範囲を実行時に限定して明記する必要がある。**
    - 一覧/詳細の`desktop.js`が呼べるkintone REST endpointを`GET /k/v1/records.json`だけに限定し、POST/PUT/DELETE、Bulk Request、cursor作成を実装しない。cursor作成はPOSTなので、ページングには使わない。
    - `config.js`の`setConfig`と管理者Consoleのpreview views PUT/deploy POSTは導入時設定であり、受入4のruntime network captureとは分けて証跡化する。
    - 「プラグイン由来」を設定画面まで含めて一律GET限定と解釈すると設定保存自体が不可能になるため、本計画では上記区分を仕様語彙として採る。

## 3. 実装前に固定する補正事項

既存DRAFTを直接変更せず、本計画を実装時の補足契約とする。仕様本文を改訂する場合は、次を一括反映してからM1へ進む。

| ID | 固定事項 | 採用値 |
| --- | --- | --- |
| G-01 | bundle entry | `status.ts`から`deriveRunActivity`だけをnamed import。browser非互換依存ゼロを成果物検査 |
| G-02 | CUSTOM view root | `#ksql-flownet-run-board`、`pager: false`、`device: "DESKTOP"` |
| G-03 | 一覧event guard | `app.record.index.show` + `viewType === "custom"` + `viewName === "00_Run状況"` |
| G-04 | detail挿入点 | `app.record.detail.show` + `kintone.app.record.getHeaderMenuSpaceElement()` |
| G-05 | owner所属判定 | active lock owner IDsだけを監査履歴アプリへbatch照合 |
| G-06 | paging | `$id` keyset、limit 500、ID集合はquery長も考慮してchunk |
| G-07 | Cancel parse | `status_reason` JSONの構造・state・run/key・一意性を検証 |
| G-08 | plugin config | `{ auditAppId: "<decimal>" }`、未設定/不正はGET前にfail-closed |
| G-09 | runtime read-only | `desktop.js`はGET recordsのみ。設定・導入操作を別区分で記録 |
| G-10 | partial failure | page/chunk失敗は部分結果破棄。構造異常は影響Runを判定不能 |

## 4. 実装方式

### 4.1 ボード読込フロー

1. configを読み、`auditAppId`を検証する。不正なら処理を中止して設定導線を表示する。
2. 1つの`nowMs`と読込世代番号を採番する。
3. 自アプリから未終端`NETWORK_RUN`を必要field限定・keyset pagingで取得する。
4. Runが0件なら空状態、判定時刻、再読込ボタンを表示して終了する。
5. 自アプリから`status in ("RUNNING")`の`NETWORK_LOCK`をkeyset pagingで取得し、非空owner IDを一意化する。
6. 自アプリから対象run IDの`CANCEL_REQUEST`をchunk+keyset pagingで取得し、安全にparseする。
7. owner IDがある場合だけ、監査履歴アプリから一致する`RUN_INVOCATION`の`invocation_id / run_id`をchunk+keyset pagingで取得する。
8. 各ownerをRunへ対応付け、Runごとに`ActivityInput`を組み立て、bundle済み`deriveRunActivity`を1回呼ぶ。
9. 全取得・検証に成功し、世代番号が最新の場合だけDOMを置換する。各cellはtext nodeとして描画する。

### 4.2 詳細画面フロー

1. `record_type !== "NETWORK_RUN"`なら何もしない。
2. 終端statusなら追加GETなしで「終端(activityなし)」を表示する。
3. 未終端なら対象Run、active Lock、対象Cancel、lock owner Invocationをboardと同じreader/assemblerで取得する。全未終端Run一覧は取得しない。
4. 取得不能または不整合ならbadgeを出さず「判定不能」を表示する。

### 4.3 表示モデル

rendererへkintone recordを直接渡さず、検証済みの次のview modelへ変換する。

| field | 内容 |
| --- | --- |
| `runId`, `businessKey`, `status`, `startedAt` | Run表示値 |
| `activity` | 4値または`null`。判定不能は別の`error`で表現 |
| `evidence` | LIVEはowner IDとlease、STOPPEDはCancelのrecord ID/state |
| `actionText` | `docs/ops-first-response.md`と一致する固定文言 |
| `judgedAt` | loader開始時の`nowMs` |

根拠値やerror detailは画面表示用に長さ上限を設ける。例外object全体、reason本文、設定値をconsoleへ無制限出力しない。

## 5. マイルストーン

### M1: bundle基盤、入力組立、read adapter — M

**目的**: 同一ソース導出と、recordから安全に`ActivityInput`を作る純粋ロジックを先に固定する。

新規ファイル（想定）:

- `plugin/manifest.json`
- `plugin/src/activity-entry.ts`
- `plugin/src/activity-input.ts`
- `plugin/src/kintone-record.ts`
- `plugin/src/kintone-reader.ts`
- `plugin/assets/icon.png`
- `plugin/scripts/build.mjs`
- `tests/unit/activity-plugin-bundle.test.mjs`
- `tests/unit/activity-plugin-input.test.mjs`
- `tests/unit/activity-plugin-reader.test.mjs`

変更ファイル:

- `package.json`: `esbuild`、`@kintone/plugin-packer`を`devDependencies`へ追加し、`build:plugin`、`test:plugin`、`pack:plugin`を追加
- `package-lock.json`: lock更新
- `.gitignore`: plugin build出力、zip、`*.ppk`

単体テスト:

- bundle済みentryが共有vector 15件すべてに合格する
- bundle/metafileに`node:`、`node:crypto`、`require(`、`process.`がなく、browser相当`vm`で評価できる
- terminal、STOPPED優先、lease境界が製品側testと同じJSONから検証される
- kintone field wrapperからRun/Lock/Invocationを型・必須値検証して変換する
- `status_reason`の正規Cancel、壊れたJSON、array、null、未知state、run/key不一致、重複を検証する
- ownerだけの縮約入力と全Invocation IDs入力が同じactivityになるproperty/table test
- 500件ちょうど/501件、複数chunk、`$id`非単調、途中GET失敗、query escapeを検証する

受入対応: 受入1、2の導出・入力・ページング部分。

リスク: 実esbuildが`status.ts`の未使用runtime importを除去できない場合はM1を止め、後方互換なshared module抽出案を別レビューする。M2へ回避実装を持ち込まない。

順序制約: **M1のbundle検査と全vector合格前にUIを実装しない。**

### M2: desktop表示と設定画面 — L

**目的**: ボード、詳細badge、設定、fail-closed表示をread-onlyで完成させる。

新規ファイル（想定）:

- `plugin/src/desktop.ts`
- `plugin/src/board-controller.ts`
- `plugin/src/detail-controller.ts`
- `plugin/src/render.ts`
- `plugin/src/config.ts`
- `plugin/config.html`
- `plugin/css/desktop.css`
- `plugin/css/config.css`
- `tests/unit/activity-plugin-controller.test.mjs`
- `tests/unit/activity-plugin-config.test.mjs`
- `tests/unit/activity-plugin-render.test.mjs`

変更ファイル:

- `plugin/manifest.json`: desktop JS/CSS、config HTML/JS/CSSを登録。mobile JSは登録しない
- `plugin/scripts/build.mjs`: desktop/configのbrowser bundle、source map方針、成果物検査を追加

単体テスト:

- view type/name guard、別一覧/別record typeでAPIを呼ばない
- terminal detailで追加GETを呼ばない
- 典型4 GETのbody、fields、query、app IDが正しく、POST/PUT/DELETE/Bulk/cursorを呼ばない
- configの未設定、空、0、負数、小数、空白、非数字をGET前に拒否し、正しい10進文字列だけを保存/利用する
- API権限エラー、監査アプリ不在、page/chunk途中失敗で部分badgeを出さない
- 再読込連打、event再発火、遅い旧応答でDOM/buttonが増殖・逆戻りしない
- 4色、固定文言、根拠、判定時刻、空状態、判定不能がview modelどおりである
- record値をHTMLとして解釈せず、長い値を制限して表示する

受入対応: 受入2、5。受入3の画面部分と受入4の静的/単体側。

リスク: kintone固有DOMとイベント再発火はNode単体だけでは保証できない。公開APIと自前root以外へ依存せず、M3で実機確認する。

順序制約: M1のreader/assemblerを再実装せず利用する。M2完了時点では実機合格を主張しない。

### M3: スパイク環境での実機受入 — L

**目的**: 実データ、権限、kintone event/DOM、ネットワークmethodを含めて受入1〜5を確定する。

新規ファイル（想定）:

- `tests/e2e/p2-08-support.mjs`
- `docs/test-results/p2-08-<実施日>/README.md`
- `docs/test-results/p2-08-<実施日>/activity-comparison.json`
- `docs/test-results/p2-08-<実施日>/network-methods.json`

変更ファイル:

- `tests/e2e/README.md`: 前提権限、実行順、試験Runの識別規則、証跡の秘匿化
- `plugin/README.md`: 開発用zip導入、設定、再build手順

実機受入:

1. 同じRunについて画面とCLI `status --json`を同一時刻帯で取得し、LIVE、STOPPED、INTERRUPTED、IDLEが一致する。
2. terminal Runがボードに出ず、詳細は「終端(activityなし)」になる。
3. 監査履歴アプリ閲覧権限なし、誤った監査アプリID、壊れたCancel fixture相当でbadgeを出さず、明示エラーになる。
4. DevTools/network記録で、一覧/詳細plugin実行時のkintone REST methodがGETだけである。config保存と管理者Console操作は別記録にする。
5. 実環境の取得が複数pageになる場合は最終件を欠落・重複しない。500/501境界自体の必須証跡はM1の自動testとする。
6. ボード再読込、他一覧との往復、詳細画面再表示でDOMが増殖しない。
7. browser時刻を意図的にずらせる試験端末では警告/runbook導線を確認する。CLIとの差が出た場合に画面を正として扱わない。

証跡:

- token、実アプリID、reason本文、個人識別値をredactしたCLI/画面対応表
- browser、plugin版、commit、試験時刻、各Run IDの匿名相関値
- network method集計。response bodyや認証headerは保存しない
- 未実施ケースと理由をREADMEへ明記

受入対応: 受入1〜5。

リスク: killでINTERRUPTEDを作る試験は対象Runを選別し、既存の停止確認・force unlock runbookに従う。pluginに復旧操作を追加しない。

順序制約: LIVE確認後にSTOPPED/INTERRUPTED試験を行い、試験状態をCLIで解決してから次へ進む。本番アプリへ未受入zipを入れない。

### M4: viewテンプレート、運用文書、pack・本番適用 — M

**目的**: 再現可能なview追加、署名・配布、本番導入手順、一次対応文言を揃え、npm公開ゲートを判定する。

新規ファイル（想定）:

- `templates/add-run-board-view.console.js`
- `tests/unit/run-board-view-template.test.mjs`
- `plugin/README.md`（M3で未作成の場合）
- `docs/test-results/p2-08-<本番確認日>/README.md`

変更ファイル:

- `templates/README.md`: CUSTOM view追加、必要権限、preview/deploy、既存一覧保持、rollback
- `docs/ops-first-response.md`: 4値の意味、一次対応、判定不能、CLI優先
- 該当する復旧runbook: STOPPED/INTERRUPTED分岐、停止要求はノード境界まで効かないこと
- `README.md`: pluginの位置づけと導入入口
- `docs/implementation-plan.md`: P2-08完了・証跡・npm公開ゲート判定（実受入完了後だけ）

単体・静的確認:

- viewテンプレートが既存viewsを保持し、`00_Run状況`を1件だけ追加/更新する
- GET応答の`id`/`builtinType`を正規化し、組込み一覧を壊さず、既存一覧の相対順を維持してtargetをindex 0にする
- CUSTOMの`name/type/html/pager/device/filterCond/sort/index`を固定する
- 全viewのname、index一意性、単一sort、`/k/v1/...json` URLを既存実測回帰と同じtestで検証する
- 2回適用して重複せず、確認拒否時はdeployしない
- zip内manifest/file一覧を検査し、mobile bundle、source map、ppk、token、実アプリIDを含めない
- `npm test`、`npm run lint`、`npm run typecheck`、`npm run format:check`、plugin build/vector testを全実行する

本番適用順:

1. M3証跡レビューを完了する。
2. 署名鍵の保管先と復旧手順を確認し、同じ鍵でrelease zipをpackする。ppkとzipはcommitしない。
3. 本番実行管理アプリの現行viewsを控え、管理者ConsoleでCUSTOM viewをpreviewへmergeし、内容確認後にdeployする。
4. pluginをインストールし、監査履歴アプリIDを設定してアプリ設定を反映する。
5. 既存の未終端/終端RunでCLIとのread-only smoke比較とGET-only確認を行う。
6. runbook/一次対応文書を公開し、rollback手順（plugin無効化/削除、view設定復元）を確認する。
7. 受入1〜6と本番smokeが全て合格した時点だけ、`docs/implementation-plan.md`のnpm公開ゲートを解除する。

受入対応: 受入4、6、配布・本番適用。

リスク: views PUTは指定漏れ一覧を削除するため、GET結果の全件merge、revision、適用前控えを必須にする。plugin runtimeのread-only性とは別の管理変更として実施する。

順序制約: 文書文言はM3で確定した実表示と一致させる。本番smoke前にnpm公開ゲートを解除しない。

## 6. 受入基準との対応

| 仕様受入 | 主担当 | 自動確認 | 実機確認 |
| --- | --- | --- | --- |
| 1. bundle済み導出がvector 15件合格 | M1 | bundleを直接importして共有JSONを実行 | M3でCLI/画面比較 |
| 2. 入力組立、終端除外、ページング | M1/M2 | record fixture、owner縮約、500/501、chunk、異常Cancel | M3で境界fixture |
| 3. LIVE/STOPPED/INTERRUPTED/IDLE/終端 | M2/M3 | controller/view model test | M3の5ケース |
| 4. 書込みゼロ | M2/M3/M4 | API method allowlist test、bundle scan | runtime network記録 |
| 5. 監査閲覧不可のfail-closed | M2/M3 | reject/partial failure test | 権限なしユーザー |
| 6. 一次対応/runbook整合 | M4 | 固定文言の参照testまたはレビュー | 本番smoke時の手順確認 |

## 7. リスク一覧

| リスク | 影響 | 対策 | ゲート |
| --- | --- | --- | --- |
| `status.ts`経由でNode組込みがbundleへ残る | browserで起動不能 | 専用entry、metafile/文字列/vm検査。失敗時だけshared module抽出を別レビュー | M1 |
| RunごとのInvocation全件取得 | API負荷、表示遅延 | active owner IDsだけをbatch照合 | M1 |
| 途中page/chunk失敗で部分表示 | activity誤認 | 部分結果破棄、判定不能表示 | M1/M2 |
| 壊れたCancel JSONをholdなし扱い | STOPPEDをINTERRUPTED/LIVEと誤表示 | 構造・state・相関・一意性検証 | M1 |
| custom view eventの再発火・応答逆転 | DOM重複、古い結果表示 | 固定root、replace、世代番号 | M2/M3 |
| views PUTで既存一覧削除 | アプリ設定破損 | 全views GET+merge、revision、適用前控え | M4 |
| browser時計ずれ | LIVE/INTERRUPTED誤差 | 1判定時刻固定、時刻表示、CLI優先 | M2/M3 |
| plugin設定誤り/監査権限不足 | 判定不能 | GET前validation、明示error、権限受入 | M2/M3 |
| record値によるHTML injection | 画面改変 | DOM API/textContent、長さ上限 | M2 |
| ppk/token/実ID混入 | 秘密漏えい | ignore、zip内容scan、証跡redact | M4 |

## 8. 見積り

| マイルストーン | 見積り | 根拠 |
| --- | --- | --- |
| M1 | **M** | bundle境界、3種record parse、batch/keyset paging、vector/異常系test |
| M2 | **L** | 一覧・詳細・設定の3画面境界、非同期競合、fail-closed、DOM安全性 |
| M3 | **L** | 4 activity+終端、権限、GET-only、kill/停止を含む実機証跡 |
| M4 | **M** | CUSTOM view merge、pack、文書、本番smoke、release gate |
| 全体 | **L** | 新規plugin配布系と実機受入を含み、M1→M2→M3→M4の順序を短縮できない |

## 9. 外部仕様の確認先

- [レコード一覧画面を表示した後のイベント](https://cybozu.dev/ja/kintone/docs/js-api/events/idx/index-show-event/): custom view、`viewId`、`viewName`、`viewType`
- [一覧の設定を変更する](https://cybozu.dev/ja/kintone/docs/rest-api/apps/view/update-views/): `CUSTOM`、`html`、`pager`、`device`、既存views全件指定、必要権限
- [複数のレコードを取得する](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/): 1回500件、offset 10,000件上限
- [プラグインの設定情報を保存する](https://cybozu.dev/ja/kintone/docs/js-api/plugins/set-config/): ASCII互換key、文字列value

本計画は上記公開APIだけをDOM/event/config境界に用い、kintone内部DOM構造には依存しない。
