# P2-11: 不定期ジョブのアプリ起動（START要求）実装計画

- 対象仕様: [p2-11-adhoc-start-spec.md](./p2-11-adhoc-start-spec.md) FROZEN v6
- 作成日: 2026-09-02
- 対象範囲: M1〜M4の実装、単体試験、実機受入、文書・配布物更新
- 本書作成時点では実装コードを変更しない。本書をM0の成果物とする。

## 1. 仕様への質問・指摘

### P-01（BLOCKER）`--resume`なしでも現行`ensureRun`が同一キーの未完了Runを再開する

仕様§2・§4・受入4は、STARTのargvから`--resume` / `--resume-run`を除けば同一キーの未完了Runが案内で終了し、既存Runを再開しないことを前提にしている。しかし現行実装は、`src/orchestration/ensure-run.ts:237-301`で一致Runを見つけると`input.resume`を確認せず`outcome = "RESUME"`へ進む。`input.resume`が参照されるのは業務キー補完条件（同:780-786）だけである。このため、argvからresume系フラグを除くだけではI-01を満たさない。

実装前に次を確定する必要がある。

- 推奨案: `ensureRun`をPhase 1 §2.1どおりに補正し、SUCCESSは従来どおりNOOP、未完了一致Runは`input.resume !== true`かつ`resumeRunId`未指定ならInvocationを作らず拒否する。暫定コード名は`RUN_ALREADY_EXISTS`、`blockedBy=[既存run_id]`とする。
- この補正はアプリSTARTだけでなく、直接CLIで`--resume`を省略した呼出しにも効く。明示的な`--resume` / `--resume-run`、定期cronが現在使う明示resume経路は従来どおり維持する。
- 仕様は同一キー未完了時の結果コードを固定していない。`RUN_ALREADY_EXISTS`を正とするか、別名にするかを実装開始前に決める。

### P-02（BLOCKER）STARTのstale回収は空の`run_id`では現行方式を利用できない

現行`recoverStale`は要求の`runId`をallowlist全networkの`status --run-id`へ渡す（`src/requests/request-poller.ts:296-340`）。STARTは`run_id`空必須なので、このままでは作成済みRunのlive ownerを確認できず、受入8の「安全なSTALE終端、二重Run不作成」を検証できない。

推奨案は、STARTだけ要求の`network_id`を直接解決し、保存されたキー入力とnetwork policyから業務キーを再導出して、そのnetworkへ`status --business-key`を行うことである。該当Runがあれば既存のlive-owner判定を使い、status取得不能・キー再導出不能・複数一致は更新しない。live ownerがなければ`REJECTED / STALE`へ終端する。定義変更でキー再導出結果が変わり得るため、デプロイ中はポーラーを停止する運用制約もM4文書へ入れる。

将来の定義変更にも強い解決を求めるなら、要求レコードへ機械所有の「解決済みbusiness key」または「作成run_id」を書き戻す追加フィールドが必要になる。これはFROZEN v6の3欄追加を超えるため、本計画では採らず、上記の再導出案を前提とする。

### P-03（要確定）要求model検証と利用者向けresult codeの責務を分ける必要がある

現行では`parseRequestRecord`に失敗した要求は一律`REQUEST_INVALID`になる（`src/requests/request-poller.ts:98-107`）。一方、仕様matrixは`RUN_ID_NOT_ALLOWED`、`KEY_POLICY_MISMATCH`、`AS_OF_UNDEFINED`、`INVALID_TIMESTAMP_FORMAT`を要求レコードの`result_code`として区別する。またpolicy判定にはallowlist解決後のnetwork定義が必要なので、M1のmodel parserだけでは完結しない。

本計画では次の責務分割を採る。

- M1の`request-model.ts`: 新3欄の型、長さ、機械所有欄、STARTで必要になる構造をparseする。意味判定に必要な不正値も、識別可能な要求としてM2へ渡せるようにする。
- M2のSTART事前審査: `run_id`、network policy、入力組合せ、日時、冪等性を順序付きで判定し、matrixの個別result codeを返す。
- RERUN/STOP/RELEASEの既存`REQUEST_INVALID`規則は変更しない。

仕様§7の「request-model検証（キー規則）」を「modelで入力を保持し、policy依存のキー規則はM2で検証」と解釈してよいか確認する。parser段階で拒否する場合は、`rejectInvalid`にSTART専用のcode写像を追加する必要がある。

### P-04（要確定）競合敗者と同一キー未完了のresult codeが未定義

受入3は「ほぼ同時2件で1件のみ作成」を要求するが、敗者が`LOCK_CONFLICT`になるか、ロック解放後に同一キーを見つけて`RUN_ALREADY_EXISTS`になるかはタイミングで変わる。Run一意性と非resumeはどちらでも保てるため、受入は「敗者codeを二者のいずれかに固定しない、ただし`blocked_run_ids`を返せる場合は返す」とするのが堅い。単一コードへ固定するなら仕様追補が必要である。

### P-05（安全上の残余リスク）冪等性ゲートと実行bundleのTOCTOU

ポーラーがnetwork定義を読んで全ノードの`idempotent: true`を確認した後、子CLIが同じパスを再読込してbundleを作るまでに定義が差し替わる窓がある。FROZEN v6はCLIへ冪等性強制フラグを追加していないため、M2ではspawn直前に再読込して窓を最小化し、M4で「定義デプロイ中はポーラー停止、定義配備後に検証、最後に`app_start: true`」の順序を固定する。厳密な同一byte保証が必要ならCLI契約の追加審議が必要である。

### P-06（M4前に確定）参考候補の上限とラベル

仕様は候補取得のページングと「上限により欠落し得る」注記を要求するが、上限件数を定めていない。ブラウザ負荷を制限するため、各群の走査上限を定数化し、初期値を500件とする案で実装する。上限到達時だけ欠落注記を表示する。また「START DONE実績」にはNOOPも含まれるため、画面ラベルは意味が正確な「START要求実績（DONE）」を推奨する。文言を仕様どおり固定する場合は「START DONE実績」を使う。

## 2. 実装原則と判定順序

1. STARTはRERUN系と最初に分岐し、`network_id`からallowlistを直接解決する。RERUN/STOP/RELEASEのrun_id全network検索には`app_start`を一切使わない。
2. STARTの事前審査順は、`run_id`空必須 → allowlist掲載 → `app_start === true` → definition再読込 → 全対象node冪等 → policy別キー入力 → timestamp正規化、とする。先に成立した拒否を要求結果へ書く。
3. 合格した入力だけを`run-network`へ渡す。START用argv builderをRERUN用`runNetwork`から分離し、resume系文字列を受け取るAPI自体を持たせない。
4. Run一意性とactive上限の最終裁定は`ensureRun`に残す。UIとポーラーの確認は補助である。
5. Invocation作成前の拒否は`REJECTED`、Invocation作成後はaggregateが非SUCCESSでも`DONE`とする。NOOPは`DONE / NOOP_ALREADY_SUCCESS`で既存run_idを案内する。
6. STARTの結果文言はcodeごとの純関数に集約し、同一キー未完了、MAX_ACTIVE_RUNS、LOCK_CONFLICT、NOOPを混同しない。

## 3. M1: 要求モデル・テンプレート・allowlist拡張

### 3.1 変更ファイル

| ファイル | 変更内容 |
| --- | --- |
| `src/requests/request-model.ts` | `REQUEST_TYPES`へ`START`を追加。`RequestRecord`へ`networkId`、`businessKey`、`scheduledFor`を追加し、フィールド型・長さ・UTC日時形式をparseする。既存種別の`run_id`必須とSTARTの`run_id`空を後段で区別できるmodelにする。 |
| `src/requests/poll-requests-config.ts` | `PollRequestsNetwork`へ`appStart: boolean`を追加。allowlist entryの許可keyへ`app_start`を追加し、未指定は`false`、boolean以外はfail-closedとする。network検索helperはentry全体を返せる形にする。 |
| `templates/create-flownet-request-app.console.js` | `request_type`へSTART、`network_id`（文字列1行）、`business_key`（文字列1行）、`scheduled_for`（日時）を追加。`run_id`のアプリ必須制約を外し、レイアウト・処理待ち/拒否一覧へ新欄を追加する。機械所有欄と既存初期値は維持する。 |
| `templates/README.md` | 実装予定表現を実装済みのschema説明へ更新し、三重ゲートと既定falseを明記する。 |
| `README.md` | allowlist例へ`app_start`を追加し、省略時false、RERUN等の検索対象からは除外されないことを記載する。実値は書かない。 |
| `tests/unit/request-store.test.mjs` | START recordのparse、3欄の型・長さ・日時、既存3種の回帰、機械所有欄の状態規則を追加する。 |
| `tests/unit/poll-requests-config.test.mjs` | `true` / `false` / 省略 / 非boolean / 未知keyを検証し、既存allowlistが省略のまま読めることを固定する。 |
| `tests/unit/request-template.test.mjs` | START選択肢、3欄の型、`run_id`非必須、layout・view fieldを検査する。 |

### 3.2 新規ファイル

なし。STARTのpolicy依存判定はM2の専用moduleへ分離する。

### 3.3 後方互換性

- 既存allowlistの`network_id` / `definition_path`だけのentryは有効なまま読み、`appStart=false`へ正規化する。
- `appStart=false`はSTARTだけを拒否する。`resolveRun`、stale回収、RERUN/STOP/RELEASEのstatus探索は`config.networks`全件を従来どおり走査する。
- テンプレートで`run_id`を任意化しても、ポーラーmodelが既存3種では必須を維持するため、既存要求の安全性を弱めない。

### 3.4 M1完了条件

`npm run build`、`npm run typecheck`、対象単体、全`npm test`が合格し、旧allowlist fixtureと旧要求record fixtureが変更なしで合格すること。

## 4. M2: STARTポーラー・CLI表示境界・非resume保証

### 4.1 変更ファイル

| ファイル | 変更内容 |
| --- | --- |
| `src/requests/start-request.ts`（新規） | policy別入力検証、RFC 3339/UTC正規化、全node冪等判定、START argv入力model、code別結果文言を純関数として実装する。 |
| `src/requests/request-poller.ts` | STARTをrun_id検索より前に別分岐。直接allowlist解決、三重ゲート、専用事前審査、START child起動、結果分類を追加する。START staleはnetwork+再導出business keyでstatus照合する。既存3種の分岐は維持する。 |
| `src/requests/flownet-child-client.ts` | `startNetwork(network, request, normalizedInput)`を追加し、`run-network <path>`、キーflag、`--json`だけを組み立てる。`--resume`、`--resume-run`、`--rerun-from`を型・実装の両方から排除する。`status`へbusiness key指定経路を追加する。`RunNetworkJsonOutput`へoptionalな`blocked_run_ids`を追加する。 |
| `src/requests/request-result.ts` | START用classifierを追加。`blocked_run_ids ?? []`で旧CLI JSONも安全に扱い、NOOPのrun_id必須、同一キー、MAX_ACTIVE_RUNS、LOCK_CONFLICTの文言を分ける。RERUN classifierの既存結果は維持する。 |
| `src/domain/business-key.ts` | `scheduled_period`で両flag指定時の一律`BUSINESS_KEY_INPUT_CONFLICT`を撤廃。business keyとtimestampを両方検証し、business keyは指定値、scheduled_forはキー導出には使わずas-of入力として残す。explicit policyの両指定拒否と各単独経路は維持する。 |
| `src/orchestration/ensure-run.ts` | P-01の補正を実施。SUCCESS一致はNOOP、未完了一致かつresume非指定はInvocation・bundle download・Node state変更前に拒否し、既存run_idを`blockedBy`へ入れる。明示resumeの既存挙動は維持する。 |
| `src/cli/run-network-command.ts` | JSON resultへadditiveな`blocked_run_ids`を追加し、全正常/拒否経路は配列を返す。`EnsureRunError`では`error.blockedBy`、その他は空配列。text出力とexit codeは変えない。 |
| `tests/unit/business-key.test.mjs` | scheduled_period両指定の成功、business key保持、timestamp不正、business key不正、explicit両指定拒否を固定する。 |
| `tests/unit/ensure-run.test.mjs` | resumeなし同一キー未完了がInvocationを作らず拒否、明示resumeは従来どおり、SUCCESSはNOOP、blockedByを検証する。 |
| `tests/unit/cli.test.mjs` | correction両flagの`plan` / `run-network`受理、JSON schemaの`blocked_run_ids`、text/exit互換、旧NOOP run_idを検証する。既存の「plan rejects both」は成功試験へ更新する。 |
| `tests/unit/flownet-child-client.test.mjs` | START argvの完全一致、環境相関、shell=false、status business-keyを検証する。 |
| `tests/unit/poll-requests.test.mjs` | START分岐、既存種別回帰、stale照合、heartbeat、app_start=falseでもRERUN可能を検証する。 |
| `tests/unit/poll-requests-start.test.mjs`（新規） | §6の15行matrixをS01〜S15として1行ずつ固定する。 |

### 4.2 CLI後方互換拡張1: scheduled_periodの両flag受理

具体的な変更点は`resolveBusinessKey`の`src/domain/business-key.ts:240-247`である。次の互換境界を固定する。

- 変わるのは`policy.type === "scheduled_period"`かつ両flag指定だけであり、従来エラーだった入力を新たに受理するadditive変更である。
- `businessKey`は明示値をそのまま採用し、既存の長さ・制御文字検証を通す。
- `scheduledFor`は必ず明示offset付きtimestampとして検証する。業務キー生成には使わず、`ensure-run.ts:504`の`as_of: input.scheduledFor ?? null`へ渡す。
- scheduled_for単独の期間キー導出、business_key単独のCLI受理、explicit policyの規則は変えない。アプリSTARTだけは前者2経路のうちbusiness_key単独scheduled_periodを`AS_OF_UNDEFINED`で事前拒否する。
- 共通resolverを使う`plan`も同じ組合せを受理するため、CLI単体とhelp契約を同時に更新する。

### 4.3 CLI後方互換拡張2: `blocked_run_ids`

具体的な変更点は`RunNetworkJsonResult`（`src/cli/run-network-command.ts:281-288`）と各`writeJsonResult`呼出し、catch（同:149-172）である。

- JSONへ`blocked_run_ids: string[]`を追加するだけで、既存fieldの型・値、stdout 1行JSON、stderr、exit codeを変えない。
- schemaを安定させるため、blockerなしでも`[]`を出す。`MAX_ACTIVE_RUNS`とP-01の同一キー拒否では`EnsureRunError.blockedBy`を昇順のまま返す。
- ポーラー側typeはoptionalとし、`output.blocked_run_ids ?? []`で旧CLI・段階deployを許容する。未知の追加fieldを拒否しない既存JSON consumerとの互換を単体で確認する。

### 4.4 15行matrixの単体試験

全行を`tests/unit/poll-requests-start.test.mjs`で独立testにし、要求結果だけでなく「child呼出し回数」「argv」「Run/Invocation相当の変更なし」も確認する。CLI/orchestrator固有の境界は併記したtestでも二重に固定する。

| ID | 仕様matrix行 | 主なassert |
| --- | --- | --- |
| S01 | allowlist未掲載 | `REJECTED / NETWORK_NOT_ALLOWED`、message detail=`NOT_IN_ALLOWLIST`、child 0回 |
| S02 | app_start無効 | 同code、detail=`APP_START_DISABLED`、child 0回 |
| S03 | 非冪等 | `NETWORK_NOT_IDEMPOTENT`、`false`と未指定相当を各subcaseで確認 |
| S04 | run_id記入 | `RUN_ID_NOT_ALLOWED`、status/run child 0回 |
| S05 | explicit + business_key | NEW、DONE、相関、argv完全一致、resume系なし |
| S06 | explicit + scheduled_for含む | `KEY_POLICY_MISMATCH` |
| S07 | scheduled_period + scheduled_for単独 | NEW、正規化timestampだけを渡す |
| S08 | scheduled_period correction | NEW、両flag、business key保持、as-of入力保持 |
| S09 | scheduled_period + business_key単独 | `AS_OF_UNDEFINED`、child 0回 |
| S10 | 両方欠落 | `KEY_POLICY_MISMATCH` |
| S11 | 不正日時 | `INVALID_TIMESTAMP_FORMAT`、日付のみ・offsetなし・実在しない日時をsubcase化 |
| S12 | 同一キーSUCCESS | `DONE / NOOP_ALREADY_SUCCESS`、既存run_id入り固定文言、Invocationなし |
| S13 | 同一キー未完了 | REJECTED、暫定`RUN_ALREADY_EXISTS`、`blocked_run_ids`とRERUN案内、resumeなし |
| S14 | 別キー未完了max超過 | `MAX_ACTIVE_RUNS`、blocker id、専用案内 |
| S15 | 上限通過後の別キーlock競合 | `LOCK_CONFLICT`、「時間をおいて再起票」、MAX案内を含めない |

S05とは別に、`startNetwork`へ全3入力モードを渡して得た最終argvを走査し、要素の完全一致として`--resume`も`--resume-run`も存在しないことを固定する。substring検査だけにせず、`args.includes("--resume") === false`、`args.includes("--resume-run") === false`を明示する。`--rerun-from`も同時に不存在を確認する。

### 4.5 M2追加回帰

- `app_start: false`のnetwork上の既存RunをRERUN/STOP/RELEASEが従来どおり解決できる。
- STARTの事前拒否でstatus、Run、Invocation、Node stateを変更しない。
- 2 poller競合時にRunは最大1件で、敗者はREJECTEDとなり、既存Runをresumeしない。
- 旧形式JSON（`blocked_run_ids`欠落）を受けてもclassifierが例外を出さない。
- NOOP JSONは現行どおり既存`run_id`を持つ。
- build/typecheck/lint/全unitをM2 gateとする。

## 5. M3: 第1段の実機受入

### 5.1 新規ファイル

| ファイル | 目的 |
| --- | --- |
| `tests/e2e/p2-11-support.mjs` | P2-01 supportを再利用し、START要求作成、要求終端待機、Run/Invocation相関、cleanupを提供する。秘密値は環境変数からのみ読む。 |
| `tests/e2e/p2-11-01-explicit.mjs` | 受入1。一気通貫、DONE、`requested_by`、ボード対象Runを確認する。 |
| `tests/e2e/p2-11-02-scheduled.mjs` | 受入2a/2b。期間キー導出とcorrectionの補正名、`as_of`、対象期間の集計結果を直接確認する。 |
| `tests/e2e/p2-11-03-duplicates.mjs` | 受入3。同一SUCCESS NOOP、未完了blocker、ほぼ同時2要求でRun 1件を確認する。 |
| `tests/e2e/p2-11-04-rejections.mjs` | 受入4。allowlist detail、AS_OF_UNDEFINED、MAX_ACTIVE_RUNS、キー/日時/run_id、状態不変、非resumeを確認する。非冪等だけは単体証拠を参照する。 |
| `tests/e2e/p2-11-05-stale-regression.mjs` | 受入6/8。claim後クラッシュ、STALE、二重Runなし、再要求収束、`app_start:false` RERUN、cron相当CLI回帰を確認する。 |
| `docs/test-results/p2-11-<date>/README.md`ほか | コマンド、要求、Run、Invocation、集計断面、cleanupの証跡。tokenは記録せず、app IDは既存文書に既出のもの以外はマスクする。 |

### 5.2 変更ファイル

| ファイル | 変更内容 |
| --- | --- |
| `tests/e2e/README.md` | P2-11の実行順、前提、単体専用項目、cleanup、秘密値非記録を追記する。 |
| `tests/e2e/p2-01-support.mjs` | 必要な汎用helperだけを後方互換で公開する。P2-01シナリオの挙動は変えない。 |

### 5.3 実施順と合格条件

1. 受入4の拒否を先に実施し、全て状態不変であることを確認する。
2. explicit、scheduled単独、correctionを順に実施する。correctionはRunの`business_key`と`as_of`だけでなく、8月相当の入力が8月断面を集計した業務結果まで確認する。
3. SUCCESS NOOP、未完了block、並行要求を実施し、NETWORK_RUNの一意件数とInvocation件数を照合する。
4. claim後クラッシュでは自動再claimがないこと、STALE後の人による再要求がNOOPまたは既存案内へ収束することを確認する。
5. P2-01の代表RERUN/STOP/RELEASEと通常`run-network --scheduled-for ... --resume`を再実行し、回帰がないことを確認する。

M3は単体試験で代用しない。全fixtureと要求recordをcleanupし、cleanup不能を合格扱いにしない。

## 6. M4: ボードUI・文書・本番適用

### 6.1 plugin変更ファイル

| ファイル | 変更内容 |
| --- | --- |
| `plugin/src/start-request.ts`（新規） | 入力モード、UTC正規化、完全一致key、候補集約、表示用view modelを純関数化する。 |
| `plugin/src/start-request-dialog.ts`（新規） | 「新規実行」専用dialog。3モード切替、自由入力、理由、注意文、候補2群、送信中lock、成功リンクを実装する。 |
| `plugin/src/request-client.ts` | START POST bodyと作成後readbackを追加。pending START、DONE START候補、正確な重複guard GETをkeyset pagingで取得し、応答を完全一致で二重filterする。既存run_id guardは維持する。 |
| `plugin/src/request-dialog.ts` | 既存操作dialogの共通DOM/error表示を専用dialogから安全に再利用できるよう最小限整理する。既存RERUN/STOP/RELEASEの文言・挙動は変えない。 |
| `plugin/src/board-controller.ts` | request app設定時だけpending START件数を別GETし、header modelへ渡す。候補取得はdialog open時に行い、通常board描画を重くしない。 |
| `plugin/src/render.ts` | toolbarへ「新規実行」、pending START件数、要求一覧リンクを追加。未設定時はbuttonとpending表示を作らない。GET失敗は警告付きfail-openとする。 |
| `plugin/src/desktop.ts` | button callbackからSTART dialogへstate app ID、request app ID、GET/POST adapterを渡し、成功後にboardを1回再読込する。 |
| `plugin/css/desktop.css` | toolbar button、mode切替、候補、pending、警告、狭幅時のlayoutを既存意匠に合わせる。 |
| `plugin/manifest.json` | 配布versionを1だけ上げる。desktop専用・権限境界は維持する。 |

### 6.2 UI/API契約

- explicit guard: `request_type=START ∧ state∈{REQUESTED,ACCEPTED} ∧ network_id等値 ∧ business_key等値`。
- 定期キーguard: 同条件で`network_id ∧ scheduled_for`等値。
- correction guard: `network_id ∧ business_key ∧ scheduled_for`の3項目すべて等値（AND）。
- `scheduled_for`は`datetime-local`入力を`+09:00`として解釈してUTC ISOへ変換し、POST値とguard比較値を同じ文字列にする。日付のみは送信しない。
- GET失敗・403は警告を出してPOSTを許可する。POST 403は既存専用文言、その他POST失敗は自動retryしない。
- 書込みは要求アプリへの単票POSTだけで、実行管理・監査はGET限定を維持する。
- 候補はSTART要求実績とNETWORK_RUN実績を別々にpaging・集約する。一方の失敗で他方を捨てず、上限到達を明示する。候補選択後も自由編集可能とし、allowlist可否を保証しない旨を常時表示する。

### 6.3 pluginテスト

| ファイル | 追加・変更する試験 |
| --- | --- |
| `tests/unit/activity-plugin-start-request.test.mjs`（新規） | 3モード入力、UTC変換、query条件、correction AND、完全一致二重filter、候補重複排除・上限を検証する。 |
| `tests/unit/activity-plugin-start-dialog.test.mjs`（新規） | mode切替、必須制御、候補/自由入力、注意文、XSS、二重click、GET fail-open、POST失敗、成功リンクをNode DOMで検証する。 |
| `tests/unit/activity-plugin-request.test.mjs` | START bodyが許可fieldだけを1回POSTし、readbackが正本parserを通ること、既存3種bodyが不変であることを確認する。 |
| `tests/unit/activity-plugin-controller.test.mjs` | pending START 0/複数/GET失敗、要求app未設定、候補を通常loadで取得しないことを確認する。 |
| `tests/unit/activity-plugin-render.test.mjs` | header button、pending件数・link、未設定非表示、警告、既存2 section回帰を確認する。 |
| `tests/unit/activity-plugin-bundle.test.mjs` | runtime endpoint/method allowlistが「state/audit GET、request GET+単票POST」のままで、PUT/DELETE/cursor/Bulkを含まないことを確認する。 |

`npm run build:plugin`後のbundleも検査し、source単体だけでAPI境界合格を主張しない。M3済みSTARTをM4 dialogから起票する受入5を実機で行い、ブラウザnetwork記録、要求record、Runを相関する。

### 6.4 文書・成果物の変更ファイル

| ファイル | 変更内容 |
| --- | --- |
| `docs/p2-08-implementation-plan.md` | D-1としてcorrection START非対象の旧判断が残る場合は撤回を明記する。現行§9に該当文がない場合は、P2-11を外部仕様確認先へ追加するだけに留める。 |
| `docs/p2-01-app-rerun-spec.md` | START分岐、非resume、allowlist direct解決、結果境界が実装・試験と一致することを最終確認し、必要な補足だけ反映する。 |
| `docs/p2-09-board-request-spec.md` | D-3のheader button、START guard、pending表示、API境界、受入結果を反映する。 |
| `docs/ops-first-response.md` | 直接起票とdialogの入力例、correctionは2欄必須、最大5分、DONEの意味、NOOP/同一キー/MAX/LOCK案内、START STALE時の確認手順を追記する。 |
| `docs/runbook-recovery.md` | START拒否・STALE・blocker・定義deploy中のポーラー停止と二次対応手順を追記する。 |
| `templates/README.md` | 本番schema、権限、allowlist反映順、check手順を確定する。 |
| `plugin/README.md` | 新規実行button、要求app設定依存、install/rollback/smokeを追記する。 |
| `docs/README.md` | P2-11仕様・計画・受入証跡への索引を追加する。 |
| `docs/implementation-plan.md` | P2-11のM1〜M4完了状態とP2-08方針撤回を、実際の受入結果後に更新する。 |
| `README.md` | 運用入口とallowlistの最小例を最終状態へ更新する。 |
| `plugin/zip/flownet-activity-plugin.zip` | 全gate合格後に既存署名鍵で再packする。秘密値を含めない。 |

### 6.5 M4本番適用順序

1. M1〜M3の全gateとスパイクUI受入を完了する。
2. 定義デプロイ中はポーラーを停止し、対象network定義を配備・validateする。
3. 要求アプリschemaとpluginを適用し、要求app設定あり/なし双方をsmokeする。
4. allowlistの対象entryへ最後に`app_start: true`を明示し、`poll-requests --check`を通す。
5. 本番で許可済みの最小STARTを1件起票し、要求、Run、監査、board、業務結果を確認する。
6. 問題時は`app_start`をfalseへ戻して新規STARTだけを即時閉鎖する。RERUN/STOP/RELEASEと定期cronが継続できることを確認する。

## 7. 受入基準とマイルストーン追跡

| 仕様§6 | 主実装 | 単体 | 実機/成果物 |
| --- | --- | --- | --- |
| 1 explicit一気通貫 | M1/M2 | S05、argv、結果分類 | M3 01 |
| 2 scheduled/correction | M2 CLI+poller | S07/S08、business-key/ensure-run | M3 02、集計断面 |
| 3 NOOP/未完了/競合 | M2 ensure-run+JSON | S12〜S15、CLI JSON | M3 03 |
| 4 拒否系 | M1/M2 | S01〜S11、非冪等 | M3 04（非冪等は単体のみ） |
| 5 第2段UI | M4 plugin | mode/guard/render/body/bundle | M4 browser E2E |
| 6 既存回帰 | 全段 | 既存全unit、app_start=false RERUN | M3 05、本番smoke |
| 7 文書整合 | M4 | link/固定文言/成果物review | M4差分監査 |
| 8 claim後クラッシュ | M2 stale | START stale単体 | M3 05 |

順序はM1 → M2 → M3 → M4とし、P-01〜P-03を解決するまでM2実装へ進まない。M3不合格のままplugin配布物または本番allowlistを更新しない。

## 8. 最終検証コマンドと差分監査

各milestoneで対象testを先に実行し、最終的に次を全て通す。

```powershell
npm run build
npm run typecheck
npm run lint
npm test
npm run build:plugin
npm run format:check
git diff --check
```

M4ではさらにplugin pack、bundle API allowlist検査、スパイク実機、cleanup、本番smokeを記録する。`node --check`や静的bundle検査だけをブラウザ受入の代用にしない。

最終差分監査では次を検索する。

- START argvおよび専用builderに`--resume` / `--resume-run` / `--rerun-from`がない。
- `app_start`未指定がfalseであり、既存種別のnetwork探索から除外されていない。
- `blocked_run_ids`欠落時に全consumerが`?? []`相当で安全に動く。
- STARTの3欄、result code、固定文言がtemplate、model、poller、plugin、一次対応文書、E2Eで一致する。
- 実値token、新規の実app ID、ローカル秘密設定が文書・証跡・zipへ混入していない。
