# 利用者向け文書レビュー（2026-09-04）

## 総評

対象3文書と `specification.md` の追補を、レビュー時点の `HEAD`（`8d42aff`）の実装・schema・テストおよび既存運用文書に照合した。
再実行3方式、STARTのallowlist／冪等性ゲート、保存bundle利用、`DONE` と Run 成否の分離など、主要契約の多くは実装と一致している。
一方、Run状態遷移図、CSVの実パス例、同一Runの出力上書き、先行完了ゲートには、手順や監視判断を誤らせる重要な不整合がある。
以下の「高」を先に直し、その後に既存runbookとのドリフトと説明上の例外条件を解消することを推奨する。

## 指摘

| # | 対象(ファイル・節) | 重要度(高/中/低) | 指摘 | 根拠(参照した実装ファイル:行 など) | 修正案 |
| --- | --- | --- | --- | --- | --- |
| 1 | `docs/specification.md` §3.2（215-231行） | 高 | 状態遷移図の `RUNNING -> CANCELLED: STOP hold を境界で受理` は実装どおりではない。境界でSTOPを受理した場合、schedulerはInvocationを`CANCELLED / STOP_REQUESTED`で閉じるが、Node Stateを`CANCELLED`へ変更せずRun集約も更新しないため、Run自体は通常`RUNNING`のままholdされる。また、既存Runのresumeでは `started_at` が非nullなら開始時にRunを`RUNNING`へ更新せず、再実行Nodeの結果確定後に集約するため、`FAILED -> RUNNING`／`CANCELLED -> RUNNING`が常に永続化されるわけでもない。 | `src/orchestration/sequential-scheduler.ts:315-354,495-525,871-883`、`src/orchestration/ensure-run.ts:407-445`。STOP境界の挙動は `tests/unit/sequential-scheduler.test.mjs:674-701` でも確認される。 | Run状態とInvocation状態を分けて図示する。STOPは「Run状態は据え置き、InvocationがCANCELLED、activityがSTOPPED」とする。resume後のRun状態は「Node State集約時に再計算」とし、永続化されない中間矢印を削るか破線・注記にする。 |
| 2 | `docs/specification.md` §3.2（231行） | 中 | 集約規則の要約が優先順位を欠く。「FAILED／BLOCKEDがあればFAILED」は、同時に`RUNNING`がある場合には成立しない。実装の優先順は `UNKNOWN > RUNNING > FAILED/BLOCKED > CANCELLED > SUCCESS` である。 | `src/domain/run-aggregate.ts:3-17`。複数枝を扱うテストは `tests/unit/sequential-scheduler.test.mjs:821-903`。 | 「優先順は `UNKNOWN`、`RUNNING`、`FAILED/BLOCKED`、`CANCELLED`、全件`SUCCESS`」と明記する。 |
| 3 | `docs/specification.md` §5.2（539行） | 中 | 「SUCCESSで終端したRunにはresumeもrerun-fromもできない」は両者を同じ拒否挙動に読めるが、実装では通常resumeは拒否ではなくInvocationを作らない`NOOP_ALREADY_SUCCESS`（exit 0）、rerun-fromだけが`RERUN_FROM_SUCCESS_RUN`で拒否（exit 1）である。同じ文書の547行とも不整合。 | `src/orchestration/ensure-run.ts:270-281,813-818`、`src/cli/run-network-command.ts:113-129,152-168`、`tests/unit/ensure-run.test.mjs:450-474,757-780`。 | 「SUCCESS RunへのresumeはNO-OPで実行されない。rerun-fromは拒否される。どちらもNodeを再実行しないため、再集計は補正キーを使う」と分ける。 |
| 4 | `docs/csv-io-operations.md` §3（70-79行） | 高 | パス例がplaceholderのpercent encodingを反映していない。`business_key=monthly_sales@2026-09` の `@` は `%40` になるため、記載どおりのraw `@` パスへSCPするとFlowNetが読むパスと一致せず、`INPUT_FILE_MISSING`になる。 | `src/io/io-path.ts:150-172`（許可文字以外をUTF-8 percent encode）、`tests/unit/ensure-run.test.mjs:946-952`（`net%40one`）、`docs/specification.md:380`。 | 73行・78行を `/sales/monthly_sales%402026-09/prod/input.csv` に直し、「実パスはplaceholder値をpercent encodingしたもの。`plan`等が実パスを表示しないため、記号を含むキーでは変換を確認する」と注記する。 |
| 5 | `docs/csv-io-operations.md` §2・§4（64,106,108行） | 高 | `{run_id}`を「再実行ごとに別ファイル」「上書きしない」ためのplaceholderとして案内しているが、resume／rerun-fromは同じRun IDを使う。同一Runのrerun-fromでは同じ出力pathへ全量置換されるため、履歴ファイルは分かれず既存ファイルは上書きされる。106行の「同一Run」とも、`specification.md` §4.5の正しい説明とも矛盾する。 | `src/orchestration/sequential-scheduler.ts:397-408`（保存Runの`run_id`で出力解決）、`src/io/io-path.ts:175-184`、`docs/specification.md:382`、`docs/execution-contract-v1.md:116-120`。 | 64行を「`{run_id}`は別Runを分離する。同一Runのrerun-fromは同一pathを置換する」に変更する。108行も「別Run間では上書きを避けられるが、同一Runの再実行履歴を残す機能ではない」とする。 |
| 6 | `docs/specification.md` §4.5（384行）、`docs/csv-io-operations.md` §3（88-90行） | 中 | 「resume時に同一バイトを要求」は対象範囲が広すぎる。通常resumeはSUCCESS済み入力Nodeを保持し、その入力baselineを照合しない。照合対象は再実行される冪等FAILED／CANCELLED入力Node、またはrerun-fromで選択された入力Nodeである。また保持期限はbaseline作成時刻ではなくRunの`created_at`から計算される。 | `src/orchestration/ensure-run.ts:365-382,859-886,889-923`、`src/orchestration/sequential-scheduler.ts:604-617,756-817`、`tests/unit/sequential-scheduler.test.mjs:567-603`、`tests/unit/ensure-run.test.mjs:901-944`。 | 「再実行対象となる入力Nodeは同一baselineが必要」と限定し、保持期限を「Run作成から既定90日」と明記する。終端まで保持する推奨自体は残す。 |
| 7 | `docs/specification.md` §4.7（444-485行） | 中 | 表示した構成では共有`jobs/`は `flownet/monthly-summary/network.yaml` から2階層上だが、配置規則484行は共有SQLを `../jobs/...` で参照するとしている。直前の正しい例 `../../jobs/00_intake_count.sql` と食い違い、記載どおりなら存在しない `flownet/jobs/` を参照する。 | `docs/specification.md:416-450`、相対解決実装は `src/domain/validate-network-path.ts:17-29` および `src/orchestration/ensure-run.ts:536-541`。 | 484行を「network YAMLからの相対path（この構成例では`../../jobs/...`）」に直し、固定の`../`と断定しない。 |
| 8 | `docs/specification.md` §7.4・§7.6（795,865,927-932行） | 中 | テンプレート説明がモード別挙動を正確に表していない。`explicit`（任意キー）で日付placeholderを含むテンプレートは展開されず、入力欄は空になる。`scheduled`（定期）はテンプレート自体が設定禁止なので、`{年}{月}{日}`が展開されるのは実質`correction`だけである。一方、任意キーでも`{ネットワークID}`だけの固定テンプレートは展開できる。 | `plugin/src/start-request-dialog.ts:393-413`、`plugin/src/config-validation.ts:120-150`、`tests/unit/activity-plugin-start-dialog.test.mjs:316-388`。 | 795行を「補正では対象期間を含むテンプレートを展開。任意キーでは日付placeholderを含むテンプレートは適用せず、`{ネットワークID}`等の日付不要テンプレートだけを適用」にする。865行の「定期・補正」を「補正」に直す。 |
| 9 | `docs/scheduling-patterns.md` §4の2b（65-89行） | 高 | 「対象日」の検索条件が `as_of >= @TODAY()` だけで上限を持たないため、将来日付のSUCCESS Runでも主条件を満たし、将来日付のFAILED等が補助条件を止める。対象日を一意に検証するゲートになっていない。 | 当該SQL `docs/scheduling-patterns.md:71-86`。FlowNetがRunの固定`as_of`をkSQL-Flowへ渡すことは `src/orchestration/sequential-scheduler.ts:434-445` と `src/executor/run-subprocess.ts:105-123` で確認できる。日付関数と日付演算の正確な構文は本リポジトリ内では未確認。 | kSQL-Flowが正式にサポートする構文で、`as_of >= 対象日開始 AND as_of < 翌日開始`の半開区間にする。月次は既記載どおりmonth start／next month startの半開区間にする。修正前に外部kSQL-Flow仕様で翌日境界関数を確認する。 |
| 10 | `docs/scheduling-patterns.md` §3（43-45行） | 低 | cronの`MAILTO`を「非0終了を通知」と説明しているが、一般的なcronメールはexit status自体ではなく標準出力／標準エラーがあると送られる。さらに`run-network`は失敗時にstderrへエラーを書くため「exit 1で無言終了」も通常挙動と合わない。監視設計をexit codeだけに依存させる表現は曖昧。 | CLIは失敗時にstderrへ `Error [code]` を書く: `src/cli/run-network-command.ts:153-168`。文書の記述は `docs/scheduling-patterns.md:43-44`。cron実装ごとの差は本リポジトリ内では未確認。 | 「stderrをcronメールで受ける（cron設定に依存）」と表現し、確実な非0監視が必要ならwrapperの`trap`、監視コマンド、systemd timer等の明示的な通知経路を使うよう分ける。 |
| 11 | `docs/runbook-recovery.md` §6（96行）と `docs/specification.md` §5.1 | 高 | 復旧runbookのコマンドが `run-network <network_id>` となっているが、CLI第1引数はnetwork定義ファイルのpathでありIDではない。記載どおりでは定義ファイルを読めず、復旧resumeに失敗する。今回追補の§4.7と§5.1に照らしても文書間不整合。 | `src/cli/index.ts:19-27`、`src/cli/run-network-command.ts:182-259`、`src/domain/load-network.ts:11-27`、`docs/specification.md:496-498`。 | `<network.yamlのpath>`（例: `/opt/ksql/my-ksql-jobs/flownet/monthly-summary/network.yaml`）へ変更する。`network_id`を取る`status`等と混同しない注記を付ける。 |
| 12 | `docs/runbook-recovery.md` 151行・177行、`docs/specification.md` §5.4／§6.7 | 中 | 同じrunbook内で151行は`RETRY_BRAKE`を現行機能として説明する一方、177行は「連続失敗ブレーキは未実装」としている。後者は現実装と追補仕様に対して古く、定期resumeが無制限にAttemptを増やすという案内も現在は正しくない。 | `src/orchestration/sequential-scheduler.ts:782-840`、`docs/specification.md:569-570,732`、`tests/unit/sequential-scheduler.test.mjs:643-775`。 | 177行の未実装記述とP2-03参照を削除し、151行へ統合する。「3連続後は通常resumeでブレーキされ、原因修正後にrerun-fromで明示解除」と現行挙動に揃える。 |
| 13 | `docs/csv-io-operations.md` §2・§3（30-40,75-81行） | 中 | 「rootのみアクセス可を推奨」し、転送例も`root@VPS`に固定しているため、CSV授受のたびにroot SSH資格情報を使う運用を促す。実装が要求するのはIO rootの存在・読書き権限でありroot実行そのものではない。権限事故と鍵漏えい時の影響が大きい。 | `src/io/io-config.ts:9-44` は絶対pathの既存directoryだけを要求し、rootを要求しない。危険な案内箇所は `docs/csv-io-operations.md:30-40,75-81`。 | 専用サービスアカウント／転送アカウントを作り、IO directoryだけに最小権限を与える例を基本にする。root運用が既存本番の制約なら「限定された管理者のみ・root SSH鍵を一般担当者へ配らない」を明記する。 |
| 14 | `docs/scheduling-patterns.md` 全体（23,44,49,63,90行等） | 低 | `§5.1`、`§7.2`、`§9`、`§8.1`がどの文書の節か明示されず、この文書自身には該当小節がないものもある。63行だけは「kSQL-Flow仕様 §5.3」と書き分けているため、参照先の体系がさらに判別しにくい。 | 参照表記は `docs/scheduling-patterns.md:23,44,49,63,90`。参照先候補は `docs/specification.md:492-506,751-773,952-986,988-1010`。 | FlowNet統合仕様への参照はすべて `[統合仕様書 §x.y](../specification.md)` 形式に統一する。kSQL-Flow外部仕様には取得可能なURLまたは文書名・versionを付ける。 |

## 確認済み一覧

- `run-network` はRun集約`SUCCESS`と成功済みRunのNO-OPでexit 0、それ以外の集約・引数不正・拒否・例外でexit 1になる（`src/cli/run-network-command.ts:85-90,113-129,136-168`）。したがって、Aの非0終了でBへ進まない `set -e` の直列連結自体は妥当。
- `--resume`／`--resume-run`はSUCCESS Nodeを保持し、冪等なFAILED／CANCELLEDとBLOCKEDを再評価する。UNKNOWNと実行済み非冪等Nodeは自動再実行しない（`src/orchestration/ensure-run.ts:365-383,725-765`、`src/orchestration/sequential-scheduler.ts:756-817`）。
- `--rerun-from`は指定Nodeと子孫を選び、対象中の未解決UNKNOWN、実行済み非冪等Node、SUCCESS Runを拒否する（`src/orchestration/ensure-run.ts:775-856`）。
- resume／rerun-fromは作業ツリーの新しいSQLではなく、Runに保存したbundleをdownload・hash検証して使う（`src/orchestration/ensure-run.ts:315-355`、`tests/unit/ensure-run.test.mjs:381-392`）。
- `nodes[].sql`はnetwork YAMLのdirectory基準で解決される（`src/domain/validate-network-path.ts:17-29`、`src/orchestration/ensure-run.ts:536-541`）。
- 入力は`<IO root>/in`、出力は`<IO root>/out`へ封じ込め、絶対path、traversal、symlink／junctionを拒否する。placeholder集合と既定保持日数90日も文書どおり（`src/io/io-path.ts:57-112,165-200,299-399`、`src/io/io-config.ts:9-44`、`schemas/network-definition.schema.json:81-90`）。
- 入出力pathエラーコード `INPUT_FILE_MISSING`、`INPUT_FILE_MUTATED`、`INPUT_PATH_REJECTED`、`OUTPUT_PATH_REJECTED` と、resume保持期限の `INPUT_RETENTION_EXPIRED` は実装に存在する（`src/io/io-path.ts:6-27,387-398`、`src/orchestration/ensure-run.ts:859-886`）。
- FlowNetはkSQL-Flowへbusiness keyそのものを引数として渡さず、Runの`as_of`、相関ID、Attempt ID、期待job ID、必要なCSV情報を渡す（`src/executor/run-subprocess.ts:5-15,105-157`）。ASSERTの `ASSERT (subquery) 比較, 'message';` 形式は実機用fixtureとE2E結果に存在する（`tests/e2e/fixtures/jobs/m6-assert-fail.sql:1-6`、`tests/e2e/fixtures/jobs/p211-scheduled-aggregate.sql:5-14`）。
- プラグインCSVの1列目=表示名、2列目=network ID、3列目=初期モード、4列目=business keyテンプレートという説明、および任意キーモードで日付placeholderを展開しない挙動は実装と一致する（`plugin/src/config-validation.ts:90-160,165-206`、`plugin/src/start-request-dialog.ts:393-413`）。
- ポーラーはallowlistの`network_id`を照合し、STARTには明示booleanの`app_start: true`と全Nodeの`idempotent: true`を要求する。定義は準備時と子起動直前に再読込する（`src/requests/poll-requests-config.ts:99-151`、`src/requests/request-poller.ts:195-250`、`src/requests/start-request.ts:25-59`）。§6.4・§7.4の三重ゲートの説明はこの範囲で正しい。
- `request_state=DONE`は要求処理の終端であってRun SUCCESSとは限らない。Invocationを作成できたFAILED等もDONEとして結果codeを保存する（`src/requests/request-result.ts:7-32`）。§6.7の強調は正しい。
- network間の`depends_on`はschemaに存在せず、Nodeの`depends_on`だけが定義される（`schemas/network-definition.schema.json:55-93`）。§9の「network間依存は未対応」は正しい。
- 今回の根拠確認として、`ensure-run`、sequential scheduler、IO path、START dialog、START poller、allowlistの対象unit test 98件を実行し、98件すべてpassした。文書本文・コード・schemaは変更していない。

## 未確認事項

- kSQL-Flow本体はこのリポジトリに含まれないため、`@TODAY()`／`@MONTH_START()`等が`as_of`基準で評価される厳密なSQL意味論、profile内の実ジョブロック競合、CSV出力側のtemp cleanup・fsync・atomic rename、`cli-kintone record import`との値表現互換は、FlowNet側のCLI契約と既存文書までは確認したが実装コードには直接照合できていない（境界: `src/executor/run-subprocess.ts:105-157`、契約: `docs/execution-contract-v1.md:114-120,257-265`）。
- `docs/scheduling-patterns.md:116` の「APIトークン作成レコードの作成者はAdministrator」はkintone側の現在仕様・実環境設定に依存するため、本リポジトリ内では未確認。
- `docs/csv-io-operations.md:107` の「実機検証済み」および同一Run出力SHA-256の実測結果は既存テスト結果文書に記録があるが、今回のレビューでは外部kintone／kSQL-Flowを使う実機E2Eを再実行していない。

## 採否(Claude・2026-09-05)

全14件を採用し、同日中に反映した。実装との突合結果と反映内容:

| # | 採否 | 反映 |
| --- | --- | --- |
| 1 | 採用 | `src/domain/run-aggregate.ts` と scheduler の STOP 境界処理(Invocation `CANCELLED / STOP_REQUESTED`・Run 据え置き)を確認。§3.2 の遷移図から STOP 矢印を外し、CANCELLED はノード CANCELLED(PREPARE_FAILED 等)由来へ修正。STOP は Run 状態不変・activity STOPPED と明記 |
| 2 | 採用 | 集約優先順(UNKNOWN > RUNNING > FAILED/BLOCKED > CANCELLED > 全件 SUCCESS、他は started_at で CREATED/RUNNING)を §3.2 に明記 |
| 3 | 採用 | §5.2 を「resume は NOOP_ALREADY_SUCCESS(exit 0)、rerun-from は RERUN_FROM_SUCCESS_RUN で拒否(exit 1)」へ分離 |
| 4 | 採用 | `percentEncodePathSegment`(英数字と `-_~` 以外を `%XX`)を確認。csv-io-operations のパス例を `%40` に修正し、encoding の注記を追加 |
| 5 | 採用 | `{run_id}` の説明を「別 Run 間の上書き防止。同一 Run の rerun-from は同一パスを全量置換」へ修正(§2・§4) |
| 6 | 採用 | baseline 照合を「再実行対象の入力ノード」に限定、保持期限を「Run 作成から既定90日」へ(`assertInputRetention` で確認)。仕様書 §4.5 と csv-io-operations 双方 |
| 7 | 採用 | §4.7 の配置規則を「network YAML からの相対パス(構成例では `../../jobs/…`)」へ |
| 8 | 採用 | §7.4 本文と具体例の表を「日付テンプレート展開は補正モードのみ。定期は指定不可、任意キーは `{ネットワークID}` のみのテンプレートなら適用」へ |
| 9 | 採用(例を月次へ変更) | kSQL の時刻関数は `@NOW()/@TODAY()/@MONTH_START()/@NEXT_MONTH_START()` のみで翌日境界がないため、2b の例を月次の半開区間(`@MONTH_START()`〜`@NEXT_MONTH_START()`)へ書き換え、日次粒度の 2b は書けない(2a を使う)と明記 |
| 10 | 採用 | cron メールは出力の有無で送られること、`run-network` が stderr にエラーを書くこと、確実な非0監視は trap/監視コマンドで、と書き分け |
| 11 | 採用 | runbook §6 の第1引数を `<network.yamlのパス>` へ修正し、network ID を取る `status` との混同注意を追記 |
| 12 | 採用 | runbook 177行の「ブレーキ未実装」を現行挙動(3連続で RETRY_BRAKE、`rerun_from_node` で明示解除)へ差し替え |
| 13 | 採用 | csv-io-operations §2 を転送用アカウント(`csvxfer`)+IO ルート限定権限を基本とし、root 鍵運用を続ける場合の制限を明記。scp 例も転送用アカウントへ |
| 14 | 採用 | scheduling-patterns の節参照を `[統合仕様書 §x.y](../specification.md)` 形式へ統一。kSQL-Flow 仕様は文書名・節名を明記 |

未確認事項3点(kSQL-Flow 実装コードの直接照合・Administrator 作成者・実機再実行)は、それぞれ kSQL-Flow 仕様書・kintone 仕様・既存 test-results を根拠とし、本レビューでは再実行していない。
