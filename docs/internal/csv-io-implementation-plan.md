# CSV 入出力 実装計画

- 作成日: 2026-09-03
- 対象: kSQL-FlowNet と kSQL-Flow（別リポジトリ）
- 基準: `csv-io-proposal.md` v2、同レビュー X-1〜X-6、Execution Contract v1、Phase 1 凍結仕様、P2-11 三重ゲート
- 状態: **M0 の設計判断を本書で確定。段階1は代替案比較のユーザー判断と、エンジン `/flow` 公開APIのIMPORT供給ギャップ解消の両方を得てから着手する**

## 0. 代替案との比較と着手判定

| 選択肢 | 見積り | 監査 | 実行順序 |
| --- | ---: | --- | --- |
| 取込アダプタ | 数人日 | 取込マーカーのみ | 先頭`ASSERT` |
| 段階1 | 19〜33人日 | Node AttemptとkSQL-Flow Execution ResultをRun監査へ統合 | DAG |

**着手判定(2026-09-03 確定): 段階1を採用する(ユーザー判断)。** 監査と操作をボードへ一元化する製品方針を優先し、19〜33人日の投資を承認。取込アダプタ案は不採用(ただしマーカー+先頭ASSERTの型は段階1でも維持)。

## 1. 結論と不変条件

実装順は **M0 → 段階1 import → 1万件実測 → 段階2 export** とする。段階1が完了し、1万件でメモリ、所要時間、API回数、サブテーブル有無による差を実測するまで段階2へ進まない。

次を全段階の不変条件とする。

1. FlowNetはsha256/bytes算出のため入力ファイルを**ストリーミング読み**する。全量をメモリへ保持せず、内容をログ、Execution Result、kintone、bundleのいずれにも出力しない。FlowNetが永続化するのはパスを除くsource名、sha256、bytes、rows、encoding等の安全なメタデータだけとする。
2. 入力パターンで使用できるプレースホルダは `{business_key}` と `{profile}` のみ。`{run_id}` は出力限定とする。
3. importノードを `idempotent: true` とするには、SQLが単一の重複禁止キーを用いる `ON DUPLICATE` upsertでなければならない。単なるINSERTや「重複をエラー表へ送るだけ」はP2-11三重ゲート③を満たさない。
4. 通常resumeは成功済みノードを保持する。入力同一性検証は、実際に再実行されるimportノードにだけ行い、resumeと`--rerun-from`の両方へ適用する。
5. capability確認はExecution Contract §9どおりNetworkロック取得前に行う。入力ファイルの存在・同一性確認はDAG到達後のノード実行直前に行い、全ノード一律の存在pre-flightは行わない。
6. START開放はP2-11の三重ゲート（人の権限、`app_start: true`、全対象ノードの明示的な`idempotent: true`）を維持する。CSV対応を理由に条件を緩めない。

## 2. M0（着手ゲート）

### 2.1 コード確認結果

確認対象は `C:\Users\rex02\Projects\ksql-flow` のソースと、同checkoutにインストールされた `@rex0220/kintone-sql-tools` 3.74.0である。kSQL-Flowリポジトリおよび依存物には書き込んでいない。

| ID | 現行コードの確認結果 | 確定する実装方針 |
| --- | --- | --- |
| C-2: IMPORT / ENCODING | engineのCLIには既にrepeatableな`--import-csv <name=path>` / `--import-json <name=path>`がある。parserは `IMPORT ... FROM CSV <sourceName> ENCODING UTF8\|SJIS ...` の順で句を受理し、JSONへの`ENCODING`は拒否する。ASTも`encoding?: "utf8" \| "sjis"`を保持する。一方、kSQL-Flow 0.7.0のCLI、`RunOptions`、`RunJobParams`、`createExecutionContext`呼出しにはnamed sourceの配線がない。さらに現在の公開`@rex0220/kintone-sql-tools/flow`型は`enableImport`/`importSource`を公開せず、kSQL-Flowの`parseScript`ではIMPORTが`KSQL1202`で拒否される | **文字コードはSQLで指定するためContract v1.1へ`--import-encoding`を追加しない。** kSQL-Flowの配線前に、engine `/flow` 公開APIへnamed import sourceを安全に渡せる正式な型・parse/validate/execute経路を公開する。内部CLI bundleへの直接importや非公開optionの型キャストは禁止する。従ってv2の「engine無改修」はv3で撤回する |
| C-1: 識別子の綴り | `SELECT FooBar FROM APP1`はASTと結果`columns`の`FooBar`を保持する。`AS MixedAlias`は`mixedalias`となり、バッククォート付き`AS \`AliasCase\``も`aliascase`となる。つまり直接フィールド参照は綴りを保持するが、明示aliasは保持しない | 段階2の初期実装は **(b) `getFields`方式** とする。1:1のフィールド列はform metadataの正式なfield codeへ解決し、計算列・式・明示aliasは現行結果列名を使用する。「任意aliasの入力時綴りまで保持」が要件化された場合だけ(a) AST metadata方式へ切り替える |
| C-3: `ON DUPLICATE`と部分適用後の収束 | **確認済み。** kSQL-Flowに導入済みのengine 3.74.0では、IMPORT由来または`ON ERROR SKIP`付きUPSERTはnative upsert対象外となる。`executeOnErrorSkip`は書込前にキーをGETしてcreate/updateを振り分け、createをPOST、updateをPUTでそれぞれ100件chunk実行する。重複エラーのUPDATE変換方式ではない | 同一sourceを再実行すると、既適用キーは次回の事前GETでupdate側、未適用キーはcreate側となる。従って単一重複禁止キー、同一sha256、Network排他の下で収束する。kSQL-Flowの250件UPSERTテストは3chunk目失敗時に先2chunk/200件が残る部分適用も固定している。ただしIMPORT + `ON ERROR SKIP`の中断→再実行は受入18のfault injectionで必ず実証する |

C-3の証跡はengine 3.74.0の`src/execute.ts`（`executeImport`、`executeOnErrorSkip`、native eligibility判定）と、kSQL-Flowの`test/__tests__/run.test.ts`（3chunk目失敗時の200件部分適用）で確認した。リポジトリと依存物は読み取りのみとした。

C-2のAPIギャップは段階1のblocking prerequisiteである。必要な公開契約は少なくとも次のとおりとする。

- `parseScript` / `validateScript` / `createExecutionContext`でIMPORTを同じcapability設定により有効化できる。
- source resolverは名前から遅延loaderを返し、loaderは`Uint8Array`と任意の既定encodingを返す。SQLの`ENCODING`がloader metadataより優先する既存規則を維持する。
- source名不在、重複CLI指定、読取不能、通常ファイル以外、サイズ超過を安定したエラーコードでfail-closedにする。
- kSQL-Flowはファイルパスをengineへ直接解釈させず、自身が検証済みloaderへ変換する。

### 2.2 X-1〜X-6の設計確定

| ID | M0での決定 | 実装・運用上の帰結 |
| --- | --- | --- |
| X-1 | 入力は`{business_key}` / `{profile}`だけを許可し、`{run_id}`は出力だけに許可する | network schemaの入力pattern validatorは未知・出力専用placeholderをエラーにする。placeholder値はUTF-8 percent encodingで1 path segmentへ封じ、値中の`/`・`\\`・`.`・`..`をpath構造として扱わない |
| X-2 | 推奨型は単一の重複禁止キーを指定する `ON DUPLICATE (<key>)` + `ON ERROR SKIP INTO #err` + `ASSERT` とする | `idempotent: true`のimportノードについて、静的inspectionでIMPORTの`keyFields`が単一であることを確認し、form metadataで対象が重複禁止の文字列1行または数値であることを検証する。検証不能・素のIMPORTはSTART対象外。途中クラッシュ後のresumeで同じ行数・同じキー集合となり、重複がないことを受入へ追加する |
| X-3 | sha256比較はresumeと`--rerun-from`の双方で、再実行対象importノードだけに適用する | 通常resumeで保持されるSUCCESSノードはファイルへ触れない。`--rerun-from`でSUCCESSをWAITINGへ戻した場合は必ず比較する |
| X-4 | **段階1は専用の`input_files` / `output_files`監査列を追加しない。** kSQL-FlowのExecution Result JSONを実行結果の正本とし、subprocess起動前のbaseline `{source名, sha256(64hex), bytes}` はNode Attemptレコードの既存の安全化済み文字列フィールドへ機械的にparse可能な安全な要約として記録する | アプリtemplateとrecord schema versionは変更しない。専用FS receiptを作らず、resume時は過去Attemptのbaselineと照合する。これにより単一ホスト前提を置かず、baselineの共有FS依存もない。専用監査列は需要と検索要件が確定した将来のschema migrationへ切り出す |
| X-5 | `INPUT_FILE_MISSING`、`INPUT_FILE_MUTATED`、`INPUT_RETENTION_EXPIRED`を区別する。resume可能期間は既定90日、環境変数で明示変更可とし、Run作成日時から期限を過ぎたRunはresume/`--rerun-from`しない | 入力ファイルの保持（アダプタ側）とresume可能期間（FlowNet側）は別概念であり、アダプタは90日より長く保持してよい。期限内の不在はFAILEDとして再試行可能で、同一failure kindが3回連続すれば既存`RETRY_BRAKE`。baselineと異なるsha256はMUTATEDとしてfail-closed。期限超過はファイル状態を調べず拒否し、補正business keyで新Runを作る |
| X-6 | rootはorchestrator環境変数 `KSQL_FLOWNET_IO_DIR` で指定し、resume可能日数は `KSQL_FLOWNET_IO_RETENTION_DAYS`（既定90）とする | rootは起動時に絶対path、既存directoryであることを検証する。network定義とSQLには絶対pathを持たせない。入力は`in/`、出力は`out/`に分離する。baselineはNode Attemptへ永続化するため、ホスト間共有FSを要件としない |

### 2.3 X-1 / X-2の提案書文言差分案

X-1は提案§1-3の次の文を置換する。

```diff
- プレースホルダは `{business_key}` `{profile}` `{run_id}` に限定。
+ 入力パターンのプレースホルダは `{business_key}` `{profile}` のみに限定する。
+ `{run_id}` はRun作成後にorchestratorが生成する出力ファイル名だけで使用でき、入力では検証エラーとする。
```

X-2は提案§1-6の推奨SQLを次へ置換し、§4の冪等性説明を限定する。

```sql
IMPORT INTO APP100 (取込キー, 顧客コード, 金額)
FROM CSV sales BY NAME
ON DUPLICATE (取込キー)
ON ERROR SKIP INTO #err;
ASSERT (SELECT COUNT(*) FROM #err) = 0; -- または承認済み許容件数
```

```diff
- exportノードもimportノードも `UPSERT` / 上書きで冪等
+ importノードは、重複禁止の単一キーを `ON DUPLICATE` に指定し、途中クラッシュ後の再実行がupsertになる場合だけ冪等と宣言できる。
+ 素のIMPORT、複合キー、重複隔離だけに依存するIMPORTはP2-11三重ゲート③を満たさない。
```

## 3. 段階1 — import

### 3.1 kSQL-Flow側（別リポジトリ）

#### 3.1.1 Contract v1.1

1. `run`へrepeatableな`--import-csv <name>=<absolute-path>`を追加する。今回のFlowNet schemaはCSVだけを対象とするが、既存engine契約との対称性を保つためstandalone kSQL-Flowの`--import-json`も同じloader層へ配線する。`--import-json`もCLI parser、loader、秘匿、上限のcontract test対象に含める。
2. orchestrator modeへrepeatableな `--expected-import-sha256 <name>=<64-hex>` を追加する。各`--import-csv`と同名の期待値を必須とし、kSQL-Flowが実際にloaderへ読んだbytesをSQL開始前に照合する。これによりFlowNetのpath検査後からsubprocess読取までの差替えも書込前に拒否する。standalone modeでは省略可とする。
3. capability `features.importCsv: true`を、CLI parse、source loader、engine `/flow` execution、期待sha256検証の全てが利用可能なbuildでだけ返す。実装不完全なbuildがtrueを返してはならない。
4. C-2の結論により`--import-encoding`は追加しない。文字コード指定の正はSQLの`ENCODING UTF8|SJIS`とし、省略時はloader metadata、次にUTF-8とする。
5. Execution Resultへ `input_files: [{ name, sha256, bytes, rows, encoding }]` をadditive propertyとして追加する。`name`はsource名と秘密を含まない相対表示名だけで、絶対pathは含めない。読込み済みsourceだけを記録し、失敗時も取得済みの範囲は返す。
6. 同名sourceのCLI重複、SQLが要求するsourceの未供給、期待sha256の欠落・余剰・重複、未使用の供給sourceを検査する。重複、未供給、sha不整合は実行前エラー、未使用は少なくとも警告とし、contract testで固定する。

#### 3.1.2 flow配線

`src/cli.ts`で引数を失わず複数収集し、`src/commands/run.ts` → `RunOptions` / `RunJobParams` → `src/executor.ts`へnamed source mapを渡す。`runJob`は検証済みpathから遅延loaderを構成し、parse、validate、executionへ同じIMPORT capabilityを渡す。

source loaderは次を満たす。C-3で確認した現行実装と同じく、IMPORT + `ON ERROR SKIP`のupsertは事前GET振り分けとし、重複エラーからUPDATEへ変換する方式に変えない。

- `lstat`で通常ファイルを要求し、openしたhandleからbytesを読む。
- sha256とbytesは実際にengineへ渡す同一bytesから計算し、orchestrator modeでは期待sha256一致後にだけ最初のSQL文を開始する。
- rowsはengineがRFC 4180解析後に確定したdata row数を返し、改行文字の単純countで求めない。
- token、実アプリID、絶対path、CSVセル値をログ・Execution Resultへ出さない。
- `ON DUPLICATE`の書込chunkが途中まで成功してprocessが落ちても、同じsourceの再実行がupsertとして収束する既存engine意味論を維持する。

#### 3.1.3 contract testと言語リファレンス

contract testはCLI parser、capability、Execution Result schema、stdout純度、source loader、IMPORT実行を分ける。最低限、CSVのUTF-8/SJIS、JSON、repeatable引数、source未供給、同名重複、期待sha256の欠落・不一致、通常ファイル以外、10MiB等のengine上限、`maxRecords`、途中クラッシュ後の再実行を含める。

`docs/ksql_flow_spec.md`へ独立したIMPORT節を追加し、次を正本化する。

- `FROM CSV <name> [ENCODING UTF8|SJIS] [HEADER句] [BY NAME等]`の句順。
- `ON DUPLICATE`、`ON ERROR SKIP INTO`、`CHECK WHEN`、`ASSERT`、`VALIDATE ONLY`の完全例。
- 推奨は重複禁止単一キーによるupsertであり、素のIMPORTは再実行で重複し得ること。
- 複数値、空セル、数値、日時、サブテーブル、上限の現在の取込規則。

#### 3.1.4 変更ファイル候補

| 種別 | ファイル | 変更内容 |
| --- | --- | --- |
| CLI | `src/cli.ts` | repeatable `--import-csv` / `--import-json` / `--expected-import-sha256`、構文・重複検証、orchestrator mode許可 |
| command | `src/commands/run.ts` | option伝播、startup failure、Execution Result組立て |
| execution | `src/executor.ts` | named loaderとIMPORT capabilityをparse/executionへ配線、rows等の収集 |
| types | `src/commands/run.ts`, `src/executor.ts` | source定義と結果metadata型 |
| capability | `src/commands/capabilities.ts` | `importCsv` |
| result contract | `src/contract/executionResult.ts`, `schema/execution-result-v1.schema.json` | additive `input_files` |
| docs | `docs/ksql_flow_spec.md`, `README.md`, `CHANGELOG.md` | Contract v1.1とIMPORT節 |
| tests | `test/__tests__/cli_contract.test.ts`, `execution_result_contract.test.ts`, `orchestrator_run.test.ts`, `run.test.ts`、新規IMPORT fixture/test | parser、loader、実行、秘匿、冪等性 |

これに先行して、`@rex0220/kintone-sql-tools/flow`の公開型と実装へ §2.1記載のIMPORT source APIを追加し、そのversionへkSQL-Flowの依存を更新する。具体的なengine側変更ファイルはengineリポジトリで別計画にする。

### 3.2 kSQL-FlowNet側

#### 3.2.1 network schemaとpattern検証

ノードへ次を追加する。

```yaml
nodes:
  - id: import_sales
    job_id: import_sales
    sql: jobs/import_sales.sql
    inputs:
      sales: "sales_{business_key}_{profile}.csv"
```

- `inputs`はsource名をkey、相対patternをvalueとするobject。省略時は空。
- source名はengineのidentifier規則に合わせ、空、重複、制御文字を拒否する。
- patternは空、絶対path、NUL、drive/UNC prefix、未知placeholder、`{run_id}`、未閉じbraceを拒否する。
- literal部のsubdirectoryは許可するが、`.` / `..` segmentは禁止する。placeholder値はpercent encodingして単一segment化する。
- schema検証後、bundleにはpatternだけを格納し、解決済み絶対pathやファイルmetadataは格納しない。

#### 3.2.2 capabilityと設定

`ensureRun`の既存capability確認をdefinition-awareにし、1件でも`inputs`を持つ場合だけ`importCsv`を必須featureへ加える。確認順は **network読込・schema検証 → capability取得・検証 → Networkロック取得** とする。

production dependency生成時に `KSQL_FLOWNET_IO_DIR` と `KSQL_FLOWNET_IO_RETENTION_DAYS` を検証する。CSV未使用networkではIO rootを要求せず、既存networkの後方互換性を保つ。

#### 3.2.3 path解決とallowlist

ノードが実行対象になった直後、Attempt作成後かつkSQL-Flow subprocess起動前に、各patternを `<IO root>/in` 配下へ解決する。

1. patternを構文解析し、placeholderへpercent encoding済み値を代入する。
2. lexical `resolve` / `relative`でroot外、絶対path、drive変更、traversalを拒否する。
3. rootから最終要素まで各既存componentを`lstat`し、symlink、junction/reparse point、通常directoryでない中間要素を拒否する。
4. final pathは通常ファイルだけを許可する。`realpath`後にもcanonical root内であることを再確認する。
5. handleをopenしてsha256/bytesを計算し、baselineを確定する。subprocessにはpathと同時に `--expected-import-sha256` を渡し、kSQL-Flowが実際に読み込んだbytesをSQL開始前に再照合する。

path違反は `INPUT_PATH_REJECTED`、期限内の不在は`INPUT_FILE_MISSING`とする。全DAG一律pre-flightは実装しないため、到達しない下流ノードの入力を要求しない。

#### 3.2.4 Node Attempt baseline、resume、`--rerun-from`

入力を持つノードごとに、最初のsubprocess起動前に `{source名, sha256(64hex), bytes}` の配列をsource名順でcanonical化し、Node Attemptレコードの既存の安全化済み文字列フィールドへbaseline要約としてrevision付きで記録する。専用列とFS receiptは追加しない。

- baseline要約はsource名、64hexのsha256、非負整数のbytesだけを受理する厳密なversion付き形式とし、パス、CSVセル値、token、実アプリIDを含めない。安全化済み要約の最大長も検証する。
- baseline記録のrevision競合または応答消失時はAttemptを再GETし、同じ要約が一意に確認できた場合だけ続行する。異なる値または一意に確定できない場合はfail-closedにする。
- 通常resumeではFAILED/CANCELLEDからWAITINGへ戻るimportノードだけ、`--rerun-from`では選択集合内のimportノード（元SUCCESSを含む）だけを過去Node Attemptのbaselineと比較する。
- fileなしは`INPUT_FILE_MISSING`、fileありかつhash不一致は`INPUT_FILE_MUTATED`。いずれもsubprocessを起動せずAttemptを終端するため、`execution_started_at`はnullのままにする。
- kSQL-Flowへ各baseline hashを `--expected-import-sha256` で渡す。期待値不一致はkSQL-Flowが最初のSQL文より前に `INPUT_FILE_MUTATED` としてfail-closedにする。
- kSQL-FlowからExecution Resultを受けたら、`input_files`のname/sha256/bytesがpreflight値と完全一致することも検証する。不一致は`INVALID_EXECUTION_RESULT`としてUNKNOWNへ倒す。これは`--expected-import-sha256`に続く二重検証であり通常発生しない。発生時は実装バグの可能性があるため、一次対応で自動resumeせず二次対応者へエスカレートする。
- Execution Result JSONはattempt IDで決定的に索引できるmetadata領域へ保存する。専用kintone列は追加しない。監査要約にはsource名、区分、sha256先頭12文字、bytes/rowsだけを含め、絶対pathと値を含めない。
- Run作成からresume可能日数を超えたresume/`--rerun-from`は、ファイルの有無にかかわらず `INPUT_RETENTION_EXPIRED` でInvocation作成前に拒否する。新しい補正business keyを案内する。

途中クラッシュ時はExecution Resultが無くてもNode Attemptのbaselineが残る。同じCSVでresumeすればC-3の事前GET振り分けによる`ON DUPLICATE` upsertが同じキーへ収束し、差替えCSVならsubprocess前にMUTATEDで止まる。この永続性はNode Attemptによるため、単一ホストや共有FSに依存しない。

#### 3.2.5 Attempt終端とRETRY_BRAKE

path/hash preflightはAttemptを作成した後に行うが、`AttemptExecutor`の`setAttemptExecutionStarted`より前に置く。これにより不在も物理試行として監査・連続回数へ数えつつ、SQL未開始を証明できる。

| 条件 | Node Attempt / Node State | Invocation・再試行 |
| --- | --- | --- |
| 不在 | `FAILED / INPUT_FILE_MISSING`、execution startedなし | resume可。同一kind 3連続で既存RETRY_BRAKE |
| hash不一致 | `FAILED / INPUT_FILE_MUTATED`、execution startedなし | fail-closed。元ファイルへ戻すか補正keyの新Run |
| path規律違反 | `FAILED / INPUT_PATH_REJECTED`、execution startedなし | 設定修正まで再試行しない |
| 保持期限超過 | Attempt/Invocationを作らず `REJECTED / INPUT_RETENTION_EXPIRED` | 補正keyの新Runのみ |
| kSQL-Flow結果とpreflight不一致 | `UNKNOWN / INVALID_EXECUTION_RESULT` | 自動resume禁止、突合・手動解決 |

「`REJECTED / INPUT_FILE_MUTATED`」というv2表現は現行状態モデルと合わないため、v3では上表のとおりNode Attemptの`FAILED`と起動前の`REJECTED`を区別する。

#### 3.2.6 変更ファイル一覧と単体テスト方針

| 種別 | ファイル | 変更内容 / 主な単体テスト |
| --- | --- | --- |
| schema/type | `schemas/network-definition.schema.json`, `src/domain/network-definition.ts` | optional `inputs`; map形、source名、pattern型 |
| validation | `src/domain/validate-network.ts`, `tests/unit/network-validation.test.mjs` | 許可placeholder2種、`{run_id}`・未知・brace不正・絶対path・traversal拒否、旧定義互換 |
| 新規IO helper | `src/io/io-config.ts`, `src/io/io-path.ts`, `src/io/input-baseline.ts` | env、percent encoding、Windows/Posix containment、symlink/junction、realpath、regular file、streaming hash、baseline要約の厳密parse |
| capability | `src/executor/preflight.ts`, `src/executor/ksql-flow-cli.ts`, `src/orchestration/ensure-run.ts` | inputありだけ`importCsv`必須、ロック取得前拒否、inputなし後方互換 |
| scheduling | `src/orchestration/sequential-scheduler.ts` | 到達ノードだけ検査、SUCCESS保持、resume/`--rerun-from`対象差、期限判定 |
| subprocess | `src/executor/run-subprocess.ts` | source名順をcanonical化し`--import-csv`と期待sha256をrepeatable argvへ追加、shell=false維持、ログへ絶対path非露出 |
| result / persistence | `src/executor/result-classifier.ts`, `src/executor/attempt-executor.ts`, `src/persistence/*` | Node Attempt既存文字列へのbaseline要約記録、`input_files` shape・preflight一致、MISSING/MUTATED/INVALIDの終端、SQL未開始、schema変更なし |
| production wiring | `src/cli/run-network-command.ts` | 2環境変数、CSV未使用時の互換、IO root注入 |
| fixtures/tests | `tests/fixtures/execution-result/*`, `tests/unit/run-subprocess.test.mjs`, `attempt-executor.test.mjs`, `sequential-scheduler.test.mjs`, `ensure-run.test.mjs`, `execution-result-schema.test.mjs` | argv、result、Node Attempt baseline、resume/rerun、ホスト変更、秘密・業務値非出力 |
| docs | `docs/execution-contract-v1.md`, `docs/internal/job-network-phase1-spec.md`, `docs/specification.md`, `docs/runbook-recovery.md`, `docs/ops-first-response.md`, `docs/internal/job-network-examples.md` | Contract v1.1、schema、90日のresume期限、月次networkは90日以上推奨、入力保持とresume期限の分離、二次対応、冪等IMPORT例 |

単体テストでは実token・実アプリIDを使わない。symlink/junctionテストはOS capabilityを検出し、作成可能環境では必須、作成権限がないWindowsでは理由付きskipとし、CIの少なくとも1環境で必ず実行する。

## 4. 段階2 — export

### 4.1 C-1分岐

#### (a) AST metadata方式（初期不採用、切替条件付き）

parserが全てのselect itemへ `sourceSpelling` / `aliasSpelling` と引用有無を保持し、temp tableのcolumn metadataまで伝播する。任意の明示aliasで入力時の大小文字をCSV headerへ再現できるが、parser、AST、planner、temp table、union/CTE/wildcardの伝播改修が必要になる。

次のいずれかが必須要件になった場合だけ採用する。

- 計算列・式aliasの入力時綴りを忠実に保持する。
- backtick aliasのcase保持を言語契約へ追加する。
- `getFields`で1:1に解けない列も外部schema名として安定させる。

#### (b) `getFields`方式（M0採用）

serializerがselect itemとresult columnを対応付ける。単一field refで、metadata上1:1に一致する列は`getFields`が返す正式field codeをheaderにする。式、計算列、複数sourceで曖昧な列、明示aliasは現行result column名を使用する。日本語field codeにcase変換はなく、ASCII field codeも正式codeへ戻せる。

曖昧な自動復元はしない。field codeのcase-insensitive候補が複数、wildcard由来の出自不明、同名衝突はexport前にエラーとする。round-trip受入1は1:1のfield列を対象とし、計算aliasをIMPORT先fieldへ暗黙対応させない。

### 4.2 engine / kSQL-Flow側

#### 4.2.1 値表現6項目

| 項目 | Contract v1.1の方針 | 必須テスト |
| --- | --- | --- |
| 列名 | C-1(b)。1:1 fieldは正式field code、その他はresult列名。重複headerは拒否 | ASCII大小文字、日本語、alias、計算列、重複 |
| 複数値 | 1セル内をLFで連結。CSV quotingはRFC 4180 | checkbox/multi-select/user等、LFを含む値 |
| 空セル / NULL | どちらも空文字。round-tripで区別不能であることを明記 | null、空文字、欠落 |
| 数値 | engine結果の生値を文字列化し、追加丸めをしない。IEEE 754注意を明記 | 整数、小数、演算誤差、指数表記方針 |
| 日時 | kintone保持形式（ISO/UTC）を既定。timezone変換は明示optionだけ | date/datetime、UTC、指定timezone |
| 文字コード | UTF-8既定、Shift_JIS option。表現不能文字はfail-closed | UTF-8 BOMなし、SJIS成功、不可能文字で完成fileなし |

serializerはengine層へ1回だけ実装し、CLI、kSQL-Flow、MCP、pluginが別方言を持たないようにする。全件メモリと既存上限を維持し、ストリーミングは別案件とする。

#### 4.2.2 名前付きシンク

```sql
CREATE TEMP TABLE #export AS SELECT ...;
UPDATE ... SET 状態 = '処理済' WHERE ...;
```

```text
--export-csv export=<path>
```

- optionのsource名`export`はtemp table `#export`へ対応する。
- 単文SELECTだけは名前省略を許可できる。複文で名前なし、存在しないsink、同名重複、DML結果指定は実行前エラーとする。
- 「最後のSELECT」は選ばない。
- SQL全文成功後にだけserializeする。同一directoryの一時fileへwrite、flush/fsync、close後にatomic renameする。
- 既存出力は同一pathへの全量置換を契約とする。renameの上書き差があるOSでは、安全なreplace手順をplatform別contract testで固定する。
- kSQL-Flowの`--result-json -`時もCSV stdoutは禁止する。FlowNetは常に絶対file pathを渡す。
- Contract capabilityは `features.resultCsv: true`。Execution Resultへ `output_files: [{ name, sha256, bytes, rows, encoding }]`を追加する。

### 4.3 kSQL-FlowNet側

network nodeへoptionalな出力sink定義を追加する。出力patternでは`{business_key}`、`{profile}`、`{run_id}`、`{node_id}`を許可する。入力用validatorと共用せず、許可集合を文脈別に固定する。

`{node_id}`を出力だけに許可できるのは、出力がRun作成後にorchestratorによって生成され、確定済みノード文脈を持つためである。

FlowNetは `<KSQL_FLOWNET_IO_DIR>/out`配下へ同じallowlist規則で解決し、`--export-csv`を渡す。kSQL-FlowのExecution Result `output_files`を検証し、既存のExecution Result保存と安全な監査要約へ反映する。段階1のX-4決定と同じく専用kintone列とFS receiptは追加しない。

同一Runの`--rerun-from`では同一pathへ全量置換し、同じas-of、同じsnapshot、同じ入力sha256なら同じ出力sha256になることを検証する。export直後に後続が失敗しても配信可とはみなさず、最終publish markerだけを配信ゲートとする。

変更対象は段階1の実行経路に加え、engineのserializer / sink resolver、kSQL-Flowの`src/cli.ts`・`src/commands/run.ts`・結果schema、FlowNetのnetwork schema・IO helper・scheduler・subprocess・result classifier・Execution Result保存、各contract test、言語リファレンスである。

## 5. 受入対応表

「自動」はunit/contract test、「実測」はfixtureだけで代替せず対象CLI・実kintone環境で行うことを表す。

| # | 受入内容 | 段階 | 主担当リポジトリ | 検証 |
| --- | --- | --- | --- | --- |
| 1 | kSQL export → kSQL import、`BY NAME`で内容一致 | 2（1のimport完了が前提） | engine + kSQL-Flow | UTF-8/SJIS、1:1 field code、複数値をcontract/E2E |
| 2 | cli-kintone export → kSQL import | 1 | kSQL-Flow | R12互換fixture + 実測 |
| 3 | kSQL export → cli-kintone import | 2 | engine + kSQL-Flow | 公式CLIで実取込 |
| 4 | 1万件importのメモリ・所要時間 | 1 gate | kSQL-Flow | サブテーブル有/無を実測し推奨値を文書化 |
| 5 | Shift_JIS import | 1 | engine + kSQL-Flow | SQL `ENCODING SJIS`で実測。CLI encoding optionなし |
| 6 | `maxRecords`超過fail-closed | 1 | engine + kSQL-Flow | 書込・silent truncateなし |
| 7 | サブテーブル既存走査が`maxRecords`超過でfail-closed | 1 | engine + kSQL-Flow | R12回帰 + 実測 |
| 8 | 差替え後resumeはMUTATED、成功済み非対象nodeは読まない | 1 | kSQL-FlowNet | Node Attempt baselineとsubprocess呼出し有無をunit/E2E |
| 9 | 手動配置した入力ファイルを元pathへ保持し、失敗後resumeで読める | 1 | kSQL-FlowNet | 取込アダプタは本計画のスコープ外。手動配置で期限内E2E |
| 10 | 手動配置したmarkerがない場合は先頭ASSERTで止まりimport Attemptなし | 1 | network SQL + kSQL-FlowNet | 取込アダプタは本計画のスコープ外。手動配置のscheduler/E2Eで入力の一律pre-flightがないことも確認 |
| 11 | `ON ERROR SKIP INTO #err` + `ASSERT`、件数が監査へ載る | 1 | engine + kSQL-Flow | `#err`件数がExecution Result経由で`result_message`の秘密・業務値を含まない安全な要約に載ることをE2E |
| 12 | allowlist外、symlink/junction、traversal拒否 | 1 | kSQL-FlowNet | Windows/Posix unit + E2E、subprocess未起動 |
| 13 | Node Attempt baselineと`input_files`記録、result/監査に業務値なし | 1 | 両リポジトリ | 監査アプリtemplate/record schema変更なし、別ホストresume、schema/secret test + 実network |
| 14 | 複文で名前なしexportは実行前エラー | 2 | engine + kSQL-Flow | contract test |
| 15 | 全文成功前に完成fileなし | 2 | engine + kSQL-Flow | statement失敗・kill・disk error fault injection |
| 16 | Shift_JIS表現不能文字をfail-closed | 2 | engine | 完成fileなし、一時file cleanup |
| 17 | `output_files`記録、同一Run再実行で同一sha256 | 2 | 両リポジトリ | Execution Result/監査要約 + `--rerun-from` E2E |
| 18 (X-2) | import書込chunk途中クラッシュ → resumeで行重複なし | 1 gate | engine + kSQL-Flow + kSQL-FlowNet | 100件境界を跨ぐfault injection。keyごと1件、件数不変、同一sha256 |
| 19 (X-5) | MISSING / MUTATED / RETENTION_EXPIREDを区別 | 1 | kSQL-FlowNet | 3経路のresult code、SQL未開始、MISSING 3連続RETRY_BRAKE |
| 20 (B-3) | `importCsv` capabilityを返さないkSQL-Flowで`inputs`付きnetworkを実行すると安全に拒否 | 1 | kSQL-FlowNet | Networkロック取得前の検証エラー、Run/Invocation/Attempt・業務書込なしをE2E |

受入18はC-3確定まで設計gateとする。本計画改訂時点でC-3は確認済みのためこの設計gateは解除するが、受入18自体は段階1完了gateとして維持する。単なる「再実行が成功した」では合格にしない。クラッシュ直前までの部分適用を意図的に作り、対象アプリを重複禁止keyで集計して全keyの件数が1であることを確認する。

## 6. 見積りと順序制約

見積りは1人日を実装・review修正・自動testまでとし、実機環境の待ち時間とリリース承認は含めない。X-4のNode Attempt baseline要約、result JSON保持、二重照合を明示的に加算した。

| 区分 | 作業 | 見積り |
| --- | --- | ---: |
| M0 | C-1/C-2/C-3証跡固定、Contract/API設計、X-1〜X-6確定 | 1〜2人日 |
| engine前提 | `/flow` named import source公開API、型、test、publish | 2〜4人日 — ****公開済み(v3.75.0、2026-09-03 npm registry確認)**。ただしkSQL-Flow側計画が`input_files[].rows`用のreceipt公開APIの不足を検出 — **B178(additive callback)をengineへ追加依頼**(これが揃うまでkSQL-Flowはfeatures.importCsvを出さない)** |
| 段階1 kSQL-Flow | CLI/flow配線、capability、Execution Result、contract test、IMPORT文書 | 4〜7人日 — ****完了・v0.8.0 npm公開済み(2026-09-04)**。Codexダブルレビュー(リリース可判定)・混在回帰テスト込み** |
| 段階1 FlowNet schema/security | inputs schema、placeholder、IO env、allowlist、symlink/traversal | 3〜5人日 |
| 段階1 FlowNet監査/X-4 | Node Attempt baseline要約、revision競合・応答消失対応、result JSON索引、hash照合、resume/rerun | **4〜7人日** |
| 段階1回復・結合 | MISSING/MUTATED/期限、RETRY_BRAKE、途中クラッシュE2E | 3〜5人日 |
| 1万件gate | UTF-8/SJIS、サブテーブル有無、測定・文書化 | 2〜3人日 |
| **段階1合計** | M0とengine前提を含む | **19〜33人日** |
| 段階2 engine | serializer、値表現6項目、C-1(b)、名前付きsink、temp+rename | 7〜12人日 |
| 段階2 kSQL-Flow | CLI/flow配線、Contract/capability/result、文書 | 3〜5人日 |
| 段階2 FlowNet | outputs schema、path、argv、Execution Result保存・監査要約、`output_files` | 3〜5人日 |
| 段階2互換/E2E | round-trip 3方向、SJIS、kill/disk fault、冪等sha | 4〜7人日 |
| **段階2合計** | 初期採用(b) | **17〜29人日** |
| C-1(a)差分 | AST/alias spellingと全伝播経路（採用時のみ） | 追加5〜9人日 |
| 別作業（本計画のスコープ外） | 最小取込アダプタ（ファイル配置 + 取込マーカー + sha256重複禁止INSERT） | 小 |

厳守する順序は次のとおり。

```text
M0確定
  → 代替案比較のユーザー判断
  → engine /flow IMPORT API公開
  → kSQL-Flow Contract v1.1 import
  → FlowNet inputs・security・Node Attempt baseline・resume
  → 段階1受入2, 5〜13, 18〜20
  → 1万件実測（受入4、サブテーブル有無）
  → gate review
  → 段階2(b)
  → round-tripとexport受入1, 3, 14〜17
```

段階1の1万件実測でメモリ上限、engineの10MiB source上限、`maxRecords`、kintone API時間のいずれかが対象規模を満たさない場合、段階2へ進まず上限・分割取込・ストリーミングを再設計する。

### 6.1 リリース順序と版互換

リリース順序は **engine → kSQL-Flow → FlowNet** とする。各段階での安全性は次のとおり。

| リリース状態 | engine | kSQL-Flow | FlowNet | `inputs`付きnetworkの扱い |
| --- | --- | --- | --- | --- |
| 開始前 | IMPORT公開APIなし | `importCsv`なし | `inputs`未対応 | 定義検証で拒否 |
| engineのみ新 | IMPORT公開APIあり | `importCsv`なし | `inputs`未対応 | 定義検証で拒否。既存networkは継続可 |
| engine + kSQL-Flowが新 | 対応版 | Contract v1.1、`importCsv: true` | `inputs`未対応 | FlowNetは新定義を受理しない。standalone importのみ利用可 |
| FlowNetのみ先行または古いkSQL-Flowが混在 | 任意 | `importCsv`なし | `inputs`対応 | capability検証エラー。Networkロック取得前に停止し、Run/Invocation/Attempt・業務書込なし |
| 全て新 | 対応版 | Contract v1.1、`importCsv: true` | `inputs`対応 | 段階1を利用可 |

必要最低版は実装・publish時に具体的なversionへ固定し、engine依存版、kSQL-Flow capability、FlowNetのContract要求版をrelease noteと運用文書で一致させる。

## 7. 提案書v3への修正指示（差分のみ）

提案書自体は本作業では編集しない。v3作成時は次だけを差分適用する。

| ID | 修正箇所 | 差分指示 |
| --- | --- | --- |
| X-1 | §1-3、§4、受入、例示YAML | 入力placeholderから`{run_id}`を削除し、`{business_key}` / `{profile}`限定へ置換。`{run_id}`は出力限定と明記。placeholder値のsegment encodingも追記 |
| X-2 | §1-6、§4、§5、§7 | 推奨SQLへ単一重複禁止keyの`ON DUPLICATE`を追加。「全importが冪等」を条件付き表現へ修正。受入へ「途中クラッシュ→resume→key重複なし」を追加。P2-11三重ゲート③との対応を明記 |
| X-3 | §1-4、受入8 | 「resumeで再実行対象」を「resumeまたは`--rerun-from`で再実行対象」へ置換。通常resumeのSUCCESS非対象は維持 |
| X-4 | §1-4、§4、§8 | 専用監査列は追加せずExecution Result JSONを実行結果の正本とし、pre-execution baselineはNode Attemptの既存安全化済み文字列フィールドへ要約記録する。FS receiptは廃止し、単一ホスト/共有FS依存を除去。段階1全体の位置づけを修正 |
| X-5 | §1-4、§1-5、§7、受入 | `INPUT_FILE_MISSING` / `INPUT_FILE_MUTATED` / `INPUT_RETENTION_EXPIRED`を分離。resume可能期間は既定90日、期限後はresumeせず補正keyの新Runとする。アダプタ側の入力保持とFlowNet側のresume可能期間を分け、月次networkは90日以上を推奨 |
| X-6 | §1-2、§1-3、§4、§7 | `KSQL_FLOWNET_IO_DIR`、`in/`・`out/`、networkは相対patternのみを追記。`KSQL_FLOWNET_IO_RETENTION_DAYS`も運用設定として追加。`.flownet-meta/`は作らない |
| C-2確認差分 | 0-1、§1-2、§3、§8 | SQL `ENCODING UTF8\|SJIS`あり、従って`--import-encoding`不要へ分岐確定。現行`/flow`公開APIにはsource供給経路がなく「engine無改修」は撤回し、先行API公開を追加 |
| C-1確認差分 | 0-1、§2-2、§8 | field codeは保持、aliasはbacktickでも小文字化という確認結果を記載。初期採用を(b)`getFields`、(a)は任意alias綴り保持が必要な場合の切替案とする |
| C-3確認差分 | 0-1、§1-6、受入18 | IMPORT + `ON ERROR SKIP`の`ON DUPLICATE`は事前GETでINSERT/UPDATEを振り分ける実装であり、同一入力の再実行は単一重複禁止keyと排他の下で収束すると追記。実証は受入18のgateとする |
| 状態表現補正 | §1-4、受入8 | 現行FlowNet状態モデルに合わせ、MUTATED/MISSINGはAttempt `FAILED`、保持期限超過だけInvocation前`REJECTED`とする |

## 8. 完了条件

段階1の実装着手判定は、§0の代替案比較に対するユーザー判断が段階1を選択し、engine `/flow` APIの公開versionとContract v1.1のsource/error/result schemaがreview済みであること。段階1の完了判定は受入2、4〜13、18〜20が合格し、1万件実測値が文書化されていること。段階2の完了判定は受入1、3、14〜17が合格し、同一Run再実行のoutput sha256一致と配信marker境界が実機で確認されていることとする。

## 9. レビュー対応記録（2026-09-03 Claude第1巡）

| 指摘 | 採否 | 反映した裁定 |
| --- | --- | --- |
| A-1 | 採用 | 取込アダプタと段階1の見積り・監査・順序を§0で比較し、ユーザー判断を段階1の着手条件とした |
| A-2 | 採用 | `.flownet-meta`のFS receiptを廃止し、`{source名, sha256(64hex), bytes}`をNode Attemptの既存安全化済み文字列フィールドへ記録。schema変更、単一ホスト前提、baseline共有FS依存を不要とした |
| A-3 | 採用 | C-3を実コードで確認。IMPORT + `ON ERROR SKIP`は事前GET振り分けであり、部分適用後の再実行収束根拠を記載し、実機実証は受入18のgateとした |
| B-1 | 採用 | resume可能期間の既定を90日とし、アダプタ側入力保持と分離。月次networkは90日以上を推奨した |
| B-2 | 採用 | 受入9・10は手動配置で実施し、最小取込アダプタをスコープ外の別作業（小）として起票した |
| B-3 | 採用 | engine → kSQL-Flow → FlowNetのリリース順序・版互換表と、古いkSQL-FlowをNetworkロック取得前に拒否する受入20を追加した |
| B-4 | 採用 | FlowNetはhash/bytes算出のためstreaming読みするが、全量保持や内容出力をしないことを不変条件にした |
| 軽微-1 | 採用 | `INVALID_EXECUTION_RESULT` → `UNKNOWN`は通常発生せず、実装バグの可能性があるため二次対応者へエスカレートとした |
| 軽微-2 | 採用 | `#err`件数はExecution Result経由で`result_message`の安全な要約に載ると受入11へ明記した |
| 軽微-3 | 採用 | 出力のみ`{node_id}`を許可できる理由を§4.3へ追記した |
| 軽微-4 | 採用 | standalone kSQL-Flowの`--import-json`は同一loader層へ配線すると確定し、contract test対象に含めた |
