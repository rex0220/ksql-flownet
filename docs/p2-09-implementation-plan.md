# P2-09: ボードからの操作要求起票 実装計画

- 作成日: 2026-09-01
- 対象仕様: [p2-09-board-request-spec.md](./p2-09-board-request-spec.md) DRAFT v4
- 正本参照: [p2-08-activity-plugin-spec.md](./p2-08-activity-plugin-spec.md)、[p2-01-app-rerun-spec.md](./p2-01-app-rerun-spec.md) §3〜§5、`src/requests/request-model.ts`
- 本文書の範囲: 仕様レビューと実装・検証計画。**コード、P2-08仕様、一次対応文書、本番設定はまだ変更しない**

## 1. 結論

方向性は妥当である。操作要求アプリへの単票POSTだけを新しい書込み境界とし、実行管理・監査アプリはGET限定のまま、正の受理判定をポーラーとCLIに残す設計は維持できる。

ただし、DRAFT v4のまま実装へ進むのは不可とする。M0で少なくとも次を仕様と受入へ固定する必要がある。

1. 起票body、人間欄、アプリ既定値、作成後レコードが`parseRequestRecord()`を通ること。
2. 要対応(終端)GETの正確なquery、安定順序、20件上限、総件数、セクション単位の失敗表示。
3. 処理待ちGETと起票直前ガードGETのchunk上限、全chunk失敗時の部分結果破棄、複数要求時の表示規則。
4. `status × activity`全30組合せと、処理待ち・再開無効・判定不能を含む表示優先順位。
5. §2〜§5の条件に対する受入不足を追加し、M3対象を「1〜11」から単体専用・文書専用を除く全実機項目へ直すこと。
6. P2-08受入4を、runtimeのAPI allowlist、bundle検査、実機network記録の3層で`GET + 要求アプリPOST`へ更新すること。

全体見積りは**L**とする。既存readerとP2-01 E2E資産は再利用できるが、2セクションの独立失敗、全matrix、ダイアログ、権限分岐、一気通貫受入16項目が支配的である。

## 2. 仕様レビュー所見

### 2.1 要求レコード契約

1. **CORRECT — 書込先と判断境界は正しい。**
   - P2-09 §1・§3共通4は、プラグインを要求レコード作成だけに限定し、受理・拒否をP2-01のポーラーとCLIへ残している(`docs/p2-09-board-request-spec.md:13,43`)。
   - P2-01の正の受理条件はrequest typeごとに固定されている(`docs/p2-01-app-rerun-spec.md:49-58`)。プラグイン側へlock、hold、UNKNOWN裁定等を再実装しない。

2. **FLAWED — 「人間欄だけ」の記述だけでは、作成レコードがポーラーのparseを確実に通る契約になっていない。**
   - P2-09が許可するフィールド名`request_type`、`run_id`、`reason`、`rerun_from_node`はP2-01 §3およびparserと一致する(`docs/p2-01-app-rerun-spec.md:30-40`、`src/requests/request-model.ts:291-308`)。
   - `request_type`は`RERUN/STOP/RELEASE`、`run_id`と`reason`はtrim後非空、`rerun_from_node`はRERUNだけ、各長さ上限は128/128/65,535文字である(`src/requests/request-model.ts:3-23,163-223`)。
   - 初期`REQUESTED`ではclaim/resultの全機械欄が空でなければならない(`src/requests/request-model.ts:224-265`)。ところがPOST APIの応答はid/revisionだけであり、P2-09は要求アプリの`request_state=REQUESTED`既定値と他機械欄空への依存を受入へ落としていない。
   - M0補正: POST bodyを`{app: requestAppId, record: {request_type, run_id, reason, rerun_from_node?}}`に固定し、`request_state`と機械欄、作成者を送信禁止にする。`rerun_from_node`は詳細RERUNで非空の場合だけ送る。作成後に実レコードをGETし、`parseRequestRecord()`がissueなしで通ることを受入へ追加する。

3. **CORRECT — 作成者を代筆しない方針は真正性の正本と一致する。**
   - P2-01はkintoneのシステム作成者を根拠とする(`docs/p2-01-app-rerun-spec.md:40`)。P2-09のPOST bodyへ作成者フィールドを入れない設計で一致する。

### 2.2 要対応(終端)と処理待ちGET

4. **FLAWED — 要対応(終端)のquery、同順位順、総件数、失敗粒度が未固定である。**
   - 抽出条件自体は`NETWORK_RUN`、`FAILED/CANCELLED/UNKNOWN`、`ACTIVE`で正しい(`docs/p2-09-board-request-spec.md:22`)。
   - 実装queryは次に固定する。

     ```text
     record_type in ("NETWORK_RUN")
       and status in ("FAILED", "CANCELLED", "UNKNOWN")
       and lifecycle_status in ("ACTIVE")
       order by updated_at desc, $id desc limit 20
     ```

   - 20件で打ち切る仕様なので、このGETに全件keyset pagingやchunkは使わない。`totalCount: true`を同じGETへ付け、`max(0, totalCount - records.length)`を「他N件(決着済みを含む)」に使う。`updated_at`同値時の`$id desc`がないと表示が不安定になる。
   - fieldsは`$id,record_type,run_id,business_key,status,lifecycle_status,resume_allowed,updated_at`に限定する。
   - M0補正: このGETの失敗は要対応セクションだけを「読込失敗」にし、既存未終端セクションの正しく導出済みの行を捨てない。逆方向も同様とする。現在のP2-08はボード全体error modelなので(`plugin/src/board-controller.ts:223-260`)、2セクション化では失敗状態を分離する。

5. **CORRECT — P2-08のkeyset readerを無制限取得へ再利用する判断は妥当である。**
   - 既存実装は1ページ500件、`$id > lastId order by $id asc`、非単調/無進行を拒否する(`plugin/src/kintone-reader.ts:85-127`)。
   - 未終端Run、Lock、Cancel、Invocationの既存読取は変更せず、終端20件取得だけを別のlimited readerにする。終端表示順のために既存keyset readerを変形しない。

6. **FLAWED — 処理待ちバッジGETは「同じchunk化」だけではquery長と異常系が決まらない。**
   - 表示中Runは未終端全件+終端最大20件なので、`run_id in (...)`は無制限に長くなり得る。既存helperの既定値は1chunk 100値・条件文字列1,000文字、各chunk内500件keysetである(`plugin/src/kintone-reader.ts:50-82,130-145`)。
   - base queryを`request_state in ("REQUESTED", "ACCEPTED")`、fieldsを`$id,run_id,request_state`、chunk fieldを`run_id`に固定する。全chunk成功時だけ結果を採用し、1 page/chunkでも失敗したら全pending mapを破棄してfail-openする。
   - 既存helperの1,000文字制限は`run_id in (...)`条件だけを測る。base query、keyset、order、limitを含む最終query長もテストで上限内と確認する。将来base queryが増えた場合の余白を守る。

7. **NEEDS-CLARIFICATION — 同じRunに複数のREQUESTED/ACCEPTED要求がある場合の表示が未定義である。**
   - fail-open、手動起票、競走により複数件は現実に起こり得る。DRAFT v4の「要求処理待ち #id」ではどのidを出すか決まらない。
   - M0推奨: `$id`昇順の最古を主リンクにし、1件なら「要求処理待ち #id」、複数なら「要求処理待ち N件(最古 #id)」と表示する。重複を隠さず、プラグインはどちらが正しいか判定しない。

8. **FLAWED — 起票直前の重複ガードGETにも、安定順序と複数件処理がない。**
   - pending一括GETと同じquery builderを単一run_idで使用し、全REQUESTED/ACCEPTEDを取得する。既存が1件以上ならPOSTしない。複数なら前項と同じ最古リンク+件数を出す。
   - GET失敗時のfail-openはP2-09 §3共通2と哲学が一致する。ただし警告確認後にのみPOSTへ進むUI状態を固定し、GET 403をPOST 403へ誤分類しない。

### 2.3 状態連動matrix

9. **FLAWED — §3の表は正常系を説明しているが、全`status × activity`組合せを閉じていない。**
   - statusは6値(`plugin/src/activity-input.ts:16-23`)、activityは4値+`null`(`src/orchestration/run-activity.ts:8,19-31`)なので30セルある。
   - M0で次を単一の純view model判定表として固定する。`—`はボタンなし、`INVALID`は判定不能表示・起票不可である。

     | status | `null` | `IDLE` | `LIVE` | `STOPPED` | `INTERRUPTED` |
     | --- | --- | --- | --- | --- | --- |
     | `CREATED` | INVALID | — | STOP | RELEASE | RERUN |
     | `RUNNING` | INVALID | — | STOP | RELEASE | RERUN |
     | `SUCCESS` | — | INVALID | INVALID | INVALID | INVALID |
     | `FAILED` | RERUN | INVALID | INVALID | INVALID | INVALID |
     | `CANCELLED` | RERUN | INVALID | INVALID | INVALID | INVALID |
     | `UNKNOWN` | 連絡+Run IDコピー | INVALID | INVALID | INVALID | INVALID |

   - RERUNセルはさらに`resume_allowed=true && lifecycle_status=ACTIVE`が必要で、偽なら「再開が無効化されています」。STOP/RELEASEへこのRERUN gateを流用しない。
   - terminal statusはderiveで必ず`null`になる(`src/orchestration/run-activity.ts:20-21`)。不整合を便宜的なボタンへ倒さない。

10. **NEEDS-CLARIFICATION — action表示の優先順位が未定義である。**
    - M0推奨順は、`行/セクション判定不能 > 処理待ち要求 > RERUN無効 > matrixのaction/案内`とする。
    - UNKNOWNやIDLEにも別経路でpending要求が存在し得るため、pendingは「ボタン置換」ではなく行の最優先運用状態として表示し、UNKNOWNの二次対応案内とRun IDコピーは併記する。

11. **FLAWED — 詳細画面の非終端4activityと無効化条件の受入が不足している。**
    - 現行詳細loaderは終端4statusを一律`terminal`で早期returnする(`plugin/src/detail-controller.ts:10-24`)。P2-09では終端FAILED/CANCELLEDを区別し、`lifecycle_status`と`resume_allowed`も読む必要がある。
    - 受入4は終端だけ、受入5は場所を限定していない。ボードと詳細の両方で30セル、pending、RERUN無効を同じ純関数へ通し、詳細独自実装を作らないことを単体受入へ明記する。

### 2.4 UI、権限、文書

12. **CORRECT — 要求アプリID未設定時の後方互換境界は明確である。**
    - 起票ボタンと要求GETだけを無効化し、要対応セクションは表示するという区別は自己矛盾を解消している(`docs/p2-09-board-request-spec.md:48`)。
    - `requestAppId`は任意の空文字または正の10進整数、`auditAppId`は従来どおり必須とする。保存時に既存`auditAppId`を消さない回帰テストが必要である。

13. **FLAWED — dialogとPOST後動作の条件が受入へ十分に反映されていない。**
    - 受入11はreason空と二重clickだけを扱う。操作内容確認、成功文言、要求リンク、自動再読込が正確に1回、汎用POST失敗時に自動retryしないことは未受入である(`docs/p2-09-board-request-spec.md:40-42,51`)。
    - 自前DOMと`textContent`規律(`docs/p2-09-board-request-spec.md:50`)にも受入がない。run_id、business_key、reason、停止要求者/理由、APIエラーを攻撃文字列にしたXSS単体を追加する。

14. **CORRECT — 403分岐とfail-openは受理判定をプラグインへ移さない。**
    - ガードGET失敗は警告付きでPOST可能、POST 403だけ専用文言、その他POST失敗は明示してretryしない、という分離は妥当である(`docs/p2-09-board-request-spec.md:41-43`)。

15. **FLAWED — P2-08受入4の改訂方法がbundle検査と単体テストまで具体化されていない。**
    - 現行desktop API型はGET `/k/v1/records.json`だけを許す(`plugin/src/desktop.ts:57-83`)。現行bundle testはNode tokenと設定画面混入を検査するが、REST method/endpoint allowlistを直接検査していない(`tests/unit/activity-plugin-bundle.test.mjs:19-48,90-106`)。
    - 改訂後はruntimeで次だけを許す。
      - 実行管理アプリ: `GET /k/v1/records.json`
      - 監査アプリ: `GET /k/v1/records.json`
      - 操作要求アプリ: `GET /k/v1/records.json`、`POST /k/v1/record.json`単票
    - 単体はadapterへ渡った`app/path/method/body`を全call記録してallowlist照合する。bundle/build検査はdesktop成果物にcursor、Bulk、PUT、DELETE endpoint/methodがないこと、および許可endpoint以外がないことを検査する。文字列scanだけを安全性の主証拠にせず、型+call記録+bundle+実機network captureを重ねる。

16. **FLAWED — §2〜§5の全条件は受入1〜16でカバーされていない。**
    - 現行受入で明確にカバーされるのは主要一気通貫、代表action、拒否、重複、POST 403、runtime書込境界、未設定、二重送信、文書、RERUN無効、fail-open、pending、UNKNOWN copyである。
    - 次が未カバーまたは部分カバーである。
      1. 作成レコードの正確なbody、REQUESTED既定値、機械欄空、長さ上限、`parseRequestRecord()`合格。
      2. 終端queryのACTIVE filter、CANCELLED表示、20件、`updated_at/$id`安定順、「他N件」総数、終端GET失敗。
      3. pendingのREQUESTED/ACCEPTED両方、100値/1,000文字chunk、500件paging、途中失敗時の部分結果破棄、複数pending。
      4. 全30セル、異常組合せfail-closed、表示優先順位、詳細画面の非終端4activity。
      5. 操作確認、成功文言+リンク、再読込1回、汎用POST失敗のno retry。
      6. STOPPEDの停止要求者/理由が欠落・不正な場合のfail-closed表示。
      7. XSSと表示長制限。
      8. requestAppIdの設定保存互換と不正値。
      9. 改訂後P2-08受入4のunit/bundle allowlist。
    - 受入13は単体専用、受入12は文書確認であり、節見出し「実機E2E」と一致しない。またM3が受入1〜11だけを対象とし、実機対象の14〜16を落としている(`docs/p2-09-board-request-spec.md:61-78,87`)。

17. **CORRECT — §5の既存文書改訂対象と変更哲学は妥当である。**
    - P2-08仕様、`docs/ops-first-response.md`、P2-08受入4を同時に整合させる対象選定は正しい。今回の計画作成時点では改訂せず、M0で仕様差分を確定し、M4で実表示・実機証跡と一致させて反映する。

## 3. M0で仕様へ反映する補正

コード着手前にDRAFT v4へ次を反映し、レビューを再実施する。

1. §2へ終端GETのquery、fields、`totalCount`、安定順、20件、セクション単位失敗を追記する。
2. §2へpending GETのbase query、fields、100値/1,000文字chunk、500件keyset、全結果破棄、複数件表示を追記する。
3. §3へ30セルmatrix、RERUN gate、invalid pair、action優先順位を追記する。
4. §3/§4へ正確なPOST body、送信禁止欄、値上限、作成後parse合格を追記する。
5. §6を「実機E2E」「単体」「文書・成果物検査」に分類し直す。受入1〜16を残す場合は不足9群を17以降へ追加するか、既存項目へ明示的に統合する。
6. §7のM3を、単体専用・文書専用を除く全実機項目へ変更する。M0は仕様改訂、M4は既存文書と公開物への反映・最終整合確認と役割を分ける。

順序制約: **上記補正と再レビューが完了するまでM1へ進まない。** 特に複数pending表示、終端GET失敗粒度、action優先順位を実装者判断で決めない。

## 4. 実装方針

### 4.1 読込と表示モデル

1. 既存未終端loaderはP2-08のkeyset、Cancel構造検証、Invocation照合を保持する。
2. 終端loaderを別関数にし、20件+総件数を取得する。activityを導出しない。
3. 両セクションの表示対象run_idをdedupeし、要求アプリ設定済みの場合だけpendingをchunk取得する。
4. pending失敗はpending mapだけを空へ戻して警告状態を保持し、Run/activityを壊さない。
5. `decideBoardAction({status, activity, resumeAllowed, lifecycleStatus, pending})`を純関数にし、ボードと詳細で共有する。
6. Board view modelは`activeSection`と`attentionSection`にそれぞれ`ready/error`を持たせ、footerの再読込と判定時刻は1個に保つ。

### 4.2 起票フロー

1. 行actionからrequest type/run_idを固定し、詳細FAILED/CANCELLEDのRERUNだけ`rerun_from_node`入力を許す。
2. reason trim後空、値上限超過、RERUN以外のrerun-fromをクライアント入力エラーにする。これは受理判定ではなくrequest-model形式保証である。
3. 確認前に単一run_idのpending GETを行う。既存ありならPOSTしない。GET失敗なら警告を確認画面へ加える。
4. 送信中flagを立て、POST単票を1回だけ行う。API errorでflagを戻すが自動retryしない。
5. 成功id/revisionから要求リンクを構成して成功文言を表示し、ユーザーが確認できる状態を作った後、boardは1回だけreloadする。詳細画面はaction領域だけpending表示へ更新し、画面全体の強制navigationはしない。

### 4.3 API境界

- record読取adapterと単票作成adapterを分離する。
- app IDは設定由来の正の10進文字列だけを使う。実行管理、監査、要求のapp roleを型/引数名で区別する。
- API token、固定app ID、実行管理・監査へのwrite methodをコード・fixture・文書へ入れない。
- cursor、Bulk Request、PUT、DELETEはplugin runtimeへ追加しない。

## 5. マイルストーン

### M0: 仕様確定 — S

変更文書:

- `docs/p2-09-board-request-spec.md`: §2〜§7へ本計画§3の補正を反映。
- `docs/p2-09-implementation-plan.md`: 再レビュー結果に応じて指摘をclose/update。

検証:

- §2〜§5の各規範文を受入IDへ対応付け、未対応0件を確認。
- P2-01のフィールド名、choice、状態機械、値上限を機械的に再照合。
- P2-08のreader既定値とquery生成を再照合。

リスク: DRAFTの判断記録を残したまま本文だけ変えると§8が旧判断になる。補正ごとに判断記録も追記する。

順序制約: M0再レビュー合格前にコード、P2-08仕様、ops文書を変更しない。

### M1: データ・起票基盤 — L

変更/新規ファイル(予定):

- `plugin/src/config-validation.ts`: `requestAppId`の任意設定検証とconfig全体型。
- `plugin/src/config.ts`、`plugin/config.html`、`plugin/css/config.css`: 2項目保存、既存値保持、エラー表示。
- `plugin/src/kintone-reader.ts`: `totalCount`応答型と終端20件用limited read。既存keyset契約は変更しない。
- `plugin/src/request-client.ts`(新規): pending query、重複guard、単票POST、403分類、要求リンク材料。
- `plugin/src/board-action.ts`(新規): 全30セルと優先順位の純view model。
- `plugin/src/terminal-run-loader.ts`(新規): 終端query、parse、20件、総件数。
- `plugin/src/activity-input.ts`: 必要なRun表示属性の厳格parse。ただしactivity導出関数は変更しない。
- `plugin/scripts/build.mjs`: 新規純moduleのNode test build、desktop API allowlist検査。

単体テスト:

- `tests/unit/activity-plugin-config.test.mjs`: 未設定/不正/正数、auditAppId保持、config fragment回帰。
- `tests/unit/activity-plugin-reader.test.mjs`: 終端query完全一致、totalCount、同順位、20件、pending 100/1,000/500境界、escape、途中失敗。
- `tests/unit/activity-plugin-request.test.mjs`(新規): 3 request typeのbody、送信禁止欄、値上限、重複、複数pending、GET fail-open、POST 403/一般失敗/no retry。
- `tests/unit/activity-plugin-action.test.mjs`(新規): 30セル、RERUN 2条件、pending/invalid/error優先順位。
- `tests/unit/request-template.test.mjs`と連携し、plugin bodyにテンプレート既定値・システム欄を補ったfixtureが`parseRequestRecord()`を通るcontract test。STOP/RELEASEへrerun-fromを入れた負例も置く。

対応受入: 5、6、7、8、10、13、14、15と、M0で追加するrequest contract/query/chunk/matrix項目。

リスク: `request-model.ts`をbrowser bundleへ直接取り込むとbundle境界が広がる。製品runtimeでvalidatorを複製せず、共有定数/純関数を安全にimportできるかM1でbundle検査し、難しければNode contract testでドリフトを止める。

順序制約: exact bodyが`parseRequestRecord()`を通り、全30セルとchunk境界が合格するまでM2へ進まない。

### M2: ボード・詳細UI結線 — L

変更/新規ファイル(予定):

- `plugin/src/board-controller.ts`: 2セクション独立load、pending集約、部分失敗、既存generation制御。
- `plugin/src/detail-controller.ts`: terminal一律returnを廃止し、全statusを共有action判定へ渡す。activity読取は非終端だけ。
- `plugin/src/render.ts`: 2表、操作列、pendingリンク、disabled理由、UNKNOWN案内/copy、section error。
- `plugin/src/request-dialog.ts`(新規): reason、任意rerun-from、STOP/RELEASE注意、停止要求者/理由、確認、送信状態、成功/失敗。
- `plugin/src/desktop.ts`: request config、GET/POST adapter、board/detail action callback。実行管理・監査writeは型で不可能にする。
- `plugin/css/desktop.css`: 2セクション、action、dialog、focus、error/pending表示。
- `plugin/manifest.json`: version/説明を読取専用表現から要求起票対応へ更新。

単体テスト:

- `tests/unit/activity-plugin-controller.test.mjs`: セクション独立成功/失敗、pending fail-open、generation、詳細全status。
- `tests/unit/activity-plugin-render.test.mjs`: DOM非増殖、2表、全action、copy fallback、button disable、成功reload 1回、XSS、表示長。
- `tests/unit/activity-plugin-bundle.test.mjs`: Node token/設定混入の既存回帰に加え、endpoint/method allowlist、cursor/Bulk/PUT/DELETE不在。
- API spyで全runtime callのapp role/path/method/bodyを照合する。

対応受入: 3、4、5、7、8、9、10、11、13〜16と、M0追加のUI・失敗・XSS項目。

リスク: detail eventのrecord fieldsが不足する環境では判定不能になる。必要fieldsが詳細eventで取得できることをM3前smokeで確認し、内部DOMや別の暗黙GETへ逃げない。

順序制約: boardとdetailは同じaction純関数を使う。M2のNode DOM test合格だけで実機合格を主張しない。

### M3: スパイク環境の実機受入 — L

変更/新規ファイル(予定):

- `tests/e2e/p2-09-support.mjs`(新規): P2-01 supportの要求GET/parse、poll、cleanupを再利用する薄い層。実値は環境変数だけから読む。
- `tests/e2e/p2-09-board-request.mjs`(新規): RERUN/STOP/RELEASEの状態fixture作成と要求/Run終端待機。
- `tests/e2e/p2-09-terminal.mjs`(新規): FAILED/CANCELLED/UNKNOWNと20件境界の安全なfixture/確認補助。
- `docs/test-results/p2-09-<date>/README.md`と機械可読証跡(新規): CLI、要求レコード、画面、network callの相関。トークンと実app IDはマスクする。

実施順:

1. 受入10(未設定)と既存P2-08 smokeを先に行う。
2. 設定後、受入15/14/8の権限・fail-open分岐を実行する。
3. 受入1のINTERRUPTED RERUN、受入2のLIVE STOP→STOPPED RELEASEを逐次実行する。
4. 受入3/4の終端FAILED/CANCELLED/UNKNOWN/SUCCESS、rerun-fromを実行する。
5. 受入7/11の再読込・二重click、受入16のcopyを確認する。
6. DevTools network保存で受入9を確認する。許可call以外が1件でもあれば不合格とする。
7. 作成要求を再GETし、`request_state=REQUESTED`時点の機械欄空と作成者、最終DONE/REJECTEDを保存する。

受入1〜16のうち、実機対象は1〜11、14〜16を実施する。12はM4文書検査、13と全30セルの実機不能値はM1/M2単体を正証拠とする。M0で追加した項目も同じ分類表へ載せる。

リスク: STOP、kill、権限変更、20件fixtureは共有環境へ状態を残す。E2E prefix、対象Run確認、逐次実行、終了時cleanup、残件0確認を必須にする。実行管理・監査へpluginからcleanup writeを追加しない。

順序制約: 一気通貫は稼働中ポーラーとP2-01受入済み環境を前提とする。本番plugin更新はM3合格後だけ行う。

### M4: 文書・pack・本番適用準備 — M

変更予定(この段階で初めて実施):

- `docs/p2-08-activity-plugin-spec.md`: INTERRUPTED一次対応、§4 runtime API境界、受入4、作業分割を改訂。
- `docs/ops-first-response.md`: ボード起票推奨/直接起票従来、STOP後のセクション移動、エスカレーション条件を改訂。
- `plugin/README.md`: 設定2項目、必要権限、API境界、未設定時挙動、更新手順を改訂。着手時点でファイルが存在しない場合は、既存削除の意図を確認してから復元/代替先を決める。
- `plugin/manifest.json`、pack成果物、配布手順: versionと説明、checksum、インストール/rollback手順を整合。
- 一次対応者向け周知: プラグイン更新だけで要対応セクションが追加されることを本番設定前に通知。

検証:

- P2-08受入4の文言、unit allowlist、bundle scan、M3 network記録が同じ境界を示す。
- §5の3文書改訂がP2-09の固定文言と一致する(受入12)。
- zip展開物、manifest version、desktop/config bundle、不要な秘密値・実app ID不在を検査する。
- 本番は設定保存→ボードsmoke→要求1件の作成/ポーラー結果確認後に完了とする。実行管理・監査へのwriteは行わない。

リスク: P2-08文書をM0とM4の両方で編集すると実表示前に文言が確定したように見える。M0はP2-09側の差分確定、M4は既存文書への反映とし、責務を分離する。

順序制約: M3証跡と表示文言が確定する前に既存運用文書・本番zipを確定しない。

## 6. 受入1〜16との対応

| 受入 | 主な実装 | 単体/成果物検査 | 実機 |
| --- | --- | --- | --- |
| 1. INTERRUPTED→RERUN→DONE | M1/M2 | action/body/parse | M3一気通貫 |
| 2. LIVE STOP、STOPPED RELEASE | M1/M2 | matrix、注意文、停止情報 | M3逐次 |
| 3. 終端FAILED/UNKNOWN | M1/M2 | terminal query/action | M3 |
| 4. 詳細FAILED rerun-from、SUCCESS/UNKNOWN抑止 | M1/M2 | detail matrix/body | M3 |
| 5. 出し分け直接検証 | M1 | 全30セル | M3代表セル |
| 6. すり抜け要求はポーラー拒否 | M1 | pluginは審査しない | M3 |
| 7. 重複、再読込後再押下 | M1/M2 | guard/複数pending | M3 |
| 8. POST 403専用文言 | M1/M2 | error分類 | M3権限ユーザー |
| 9. runtime API境界 | M1/M2 | 型、call spy、bundle | M3 network保存 |
| 10. requestAppId未設定 | M1/M2 | config/controller | M3更新直後smoke |
| 11. 二重click、reason必須 | M1/M2 | dialog状態機械 | M3 |
| 12. 文書整合 | M4 | 文言差分review | 本番前確認 |
| 13. resume=false/ARCHIVED | M1 | 純view model | 実機対象外 |
| 14. guard GET fail-open | M1/M2 | GET/POST error分離 | M3 |
| 15. pending badge/fail-open | M1/M2 | chunk、部分破棄、描画 | M3 |
| 16. UNKNOWN Run ID copy | M2 | clipboard成功/失敗 | M3 |

## 7. リスク一覧

| ID | リスク | 影響 | 対策 | gate |
| --- | --- | --- | --- | --- |
| R-01 | request app schema/default drift | ポーラーparse不能 | body禁止欄、template contract、作成後GET+parse | M1/M3 |
| R-02 | terminal上位20件の順序不安定 | 行の入替・取りこぼし誤認 | `updated_at desc,$id desc`、totalCount | M1 |
| R-03 | 長いrun_id集合 | query上限超過 | 100値/1,000文字chunk、最終query長test | M1 |
| R-04 | chunk途中失敗の部分pending | 一部だけボタンが出る | 全pending結果破棄+fail-open警告 | M1/M2 |
| R-05 | guard競走 | 重複要求 | pending表示+直前GET+送信中lock。正はポーラー | M1/M3 |
| R-06 | status/activity drift | 誤操作ボタン | 30セル純関数、invalid fail-closed | M1 |
| R-07 | runtime write境界拡大 | 機械専用アプリ汚染 | app-role allowlist、bundle、network capture | M2/M3 |
| R-08 | request理由等のXSS | 画面注入 | textContent、長さ制限、攻撃fixture | M2 |
| R-09 | P2-08回帰 | 既存activity表示破損 | 既存全test、未設定smokeを最初に実行 | M2/M3 |
| R-10 | 削除状態の`plugin/README.md`とM4衝突 | ユーザー変更上書き | 着手時にworktree確認、無断復元しない | M4 |

## 8. 順序制約とリリースgate

1. M0仕様補正・再レビュー。
2. M1のcontract/query/matrix合格。
3. M2のUI、API allowlist、全plugin unit合格。
4. M3のスパイク実機、network証跡、cleanup完了。
5. M4の既存文書改訂、pack、本番周知、smoke。

各gateで失敗した場合は後続へ進まない。とくに、ガードや表示matrixをポーラーの受理判定へ昇格させて回避しない。実行管理・監査アプリへのwrite、token埋込み、固定app IDは全工程で禁止する。

## 9. 見積り

| マイルストーン | 見積り | 主な不確実性 |
| --- | --- | --- |
| M0 | S | 複数pendingと失敗粒度の仕様確定 |
| M1 | L | request contract、limited/count GET、chunk、30セル |
| M2 | L | 2セクション、dialog、詳細共通化、bundle境界 |
| M3 | L | 長時間Run、権限分岐、一気通貫、20件fixture |
| M4 | M | 既存文書3系統、pack、周知、本番smoke |
| 全体 | **L** | 実装量より受入と境界証明が支配的 |

## 10. 非対象

- 実行管理・監査アプリへのPOST/PUT/DELETE。
- プラグインによる受理判定、lock裁定、hold裁定、UNKNOWN解決。
- P2-10のCLOSE要求、`archive-run`、ARCHIVED書込経路。
- resolve-node、force-unlock、`--approved-by`、即時実行、ポーラー周期変更。
- mobile対応。
- API token、実アプリID、環境固有URLの文書・コードへの固定。
