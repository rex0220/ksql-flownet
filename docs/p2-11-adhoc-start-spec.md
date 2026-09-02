# P2-11: 不定期ジョブのアプリ起動(START要求) 仕様書

- 文書状態: **DRAFT v6(FROZEN候補 — 凍結ゲートF-01の確認のみ残)**(Phase 2作業単位。凍結仕様の変更なし — 操作要求モデル(P2-01)とボードプラグイン(P2-08/09)の拡張。ポーラーが`run-network`の**新規起動**を仲介する)
- 起案日: 2026-09-01 / 改訂: 外部レビュー第1巡(Gemini 4点)・第2巡(ChatGPT 5+6点)・第3巡([Claude第1回](./p2-11-spec-review.md))・第4巡(Gemini承認+3、ChatGPT 9.4+4、[Claude第2回](./p2-11-spec-review-2.md) N-1/N-2ほか)・第5巡(ユーザー指摘: 処理前取消)・第6巡(Gemini承認+3、ChatGPT 9.6+5、[Claude第3回](./p2-11-spec-review-3.md) X-1〜X-7)を反映 — **第5巡の処理前取消はX-1採用によりP2-12へ切り出し**(§9に判断記録)
- 正本参照: [p2-01-app-rerun-spec.md](./p2-01-app-rerun-spec.md)(要求モデル・状態機械・受理の正)、[p2-09-board-request-spec.md](./p2-09-board-request-spec.md)(起票UIの正)、[job-network-phase1-spec.md](./job-network-phase1-spec.md) §2.1・§4.3・§7.2・§9
- **方針変更の明示**: P2-08実装計画§9のcorrection Runアプリ化非対象を撤回する(改訂点D-1)

## 1. 目的と操作モデルの意味論

**目的**: 定期cron以外のタイミングで必要になるジョブ(締めのやり直し・補正Run・臨時集計・データ修正バッチ)を、**kintoneの操作要求アプリから起動**できるようにする。一次対応の画面完結線に唯一残った「新規Runの起動」の穴を塞ぐ。

**STARTの定義**: STARTは**未作成の業務実行単位(新しいbusiness key)を作成する操作**であり、既存business keyの「再実行」を意味しない。既存Runの再開はRERUN、SUCCESS済み期間への補正は**新しいbusiness key**(`…-correction-N`)によるSTARTで行う。

**操作モデル(全体像)**:

| やりたいこと | 操作 |
| --- | --- |
| 定期実行 | cron(VPS) |
| まだ実行していない業務単位を起動 | **START**(本仕様) |
| **失敗・中断した既存Runの再開・やり直し** | **RERUN**(P2-01/09 — FAILEDの締めはこちら。STARTではない) |
| Run単位の停止/解除 | STOP / RELEASE(P2-01/09) |
| SUCCESS済み期間への補正 | **START+補正business key+対象期間**(§3キー規則 — Phase 1 §2.1/§9のcorrection経路) |
| `app_start`未開放network・resolve等の判断操作 | CLI専権 |

**但し書き(第4巡N-2)**: `max_active_runs`(既定1)により、**同一networkに未完了Runが残っている間は別キーのSTARTも起動できない**。失敗した締めのやり直しは補正STARTではなく**RERUNが正**。未完了Runを閉じる汎用手段はP2-10(ARCHIVED化)の完成に依存し、それまで未完了Runの整理はRERUN完走またはCLI(resolve等)による。

**非目的**: 即時実行。cron定期起動の置き換え。業務アプリ個別の起動ボタン。

## 2. 方式・起動コマンド契約・不変条件

```
人: 操作要求アプリへ START レコード追加(network_id・キー入力・理由)
      ↓ (ポーラー 5分cron)
ポーラー: allowlistでnetwork_id→定義パス解決(app_start確認)
      → run-network <定義> --business-key <key> --json                     (explicit)
      → run-network <定義> --scheduled-for <RFC3339> --json                (scheduled_period 定期キー)
      → run-network <定義> --business-key <key> --scheduled-for <RFC3339> --json (correction — as-ofを対象期間に固定)
      ↓
実行管理/監査: 通常Runとして記録(requested_by = app-request:<record_id>:<作成者>)
```

**起動コマンド契約(第3巡B-1 — M0確定事項)**:

- **`--resume`/`--resume-run`を明示的に禁止**(付けるとP2-01のRERUN受理条件を全迂回する裏口になる)。単体で「STARTのargvにresumeが含まれない」ことを固定
- `--resume`なしのNEW経路では「未完了Runが既に存在」は起動せず案内で終わる(Phase 1 §2.1)。**この重複案内経路の`--json`へ既存run_idが載ること(`blocked_run_ids`)をM2で追加**(G-04と同じCLI表示境界の後方互換拡張)。ポーラー側はキー欠落時に壊れない安全な取り出し(`?? []`)とする(第4巡Gemini-3)
- **NOOP経路のJSON `run_id`=既存SUCCESS Runのidである契約を明文化**(第4巡ChatGPT-2 — 現行G-04のNOOP出力仕様どおり。固定文言の`既存Run #<id>`はここから取得)
- outcome写像: NEW作成→`DONE` / 完了済みNO-OP→`DONE / NOOP_ALREADY_SUCCESS` / 未完了案内・検証拒否(Invocation作成前)→`REJECTED`

**M0で前倒しするコード確認(第4巡Claude — 仕様が依存する3点)**: ①`scheduled_period` networkへ`--business-key`単独/`--scheduled-for`併用が現行CLIで受理されるか ②両フラグ同時指定の挙動(correction経路の成立条件) ③重複案内経路のJSONにrun_idが載るか(→`blocked_run_ids`作業の要否確定) ④**NOOP経路のJSONに`run_id`が載るか**(第6巡X-7 — G-04は「NO-OPはinvocation_id=null」としか定めておらず、§4固定文言の`既存Run #<id>`が依存する)。①②の確認内容には「`--business-key`が業務キーとして採用され、as-ofが`--scheduled-for`から取られる」ことを含む(第6巡Gemini-1)。**凍結ゲートF-01: correctionコマンド契約(②)が実装上成立すると確認できるまでFROZENへ遷移しない**(第6巡ChatGPT — 不成立の場合はCLI後方互換拡張をM2へ計上して再判定)

**profile前提(E-1)**: 単一profile運用(ポーラー環境変数由来)を前提とし、要求レコードにprofile欄を持たない。複数profile化は本仕様の再審議事項。

**不変条件**:

- **I-01**: STARTは新規業務実行単位の作成要求である。既存Runの状態変更・再開・再実行には使用しない(`--resume`禁止はこの帰結)
- **I-02**: Runの一意性(`profile + network_id + business_key`)の最終裁定はensure-runが担う。ポーラー/UIの重複確認は補助であり正ではない
- **I-03**: UIのnetwork候補一覧は入力支援であり、START可否を保証しない。可否の正はポーラーallowlist+network定義+CLI検証

**相関の意味定義**: `requested_by`は表示・監査用の相関文字列であり正規キーではない(将来の別入口はprefix拡張)。

## 3. 要求レコードの拡張とキー規則

操作要求アプリへ追加(テンプレート追補):

| フィールド | 型 | 書き手 | 内容 |
| --- | --- | --- | --- |
| `request_type` | 既存ドロップダウンへ**`START`**追加 | 人 | — |
| `network_id` | 文字列1行(START時必須) | 人 | allowlist直接解決(RERUN等のstatus検索経路(G-03)とは別分岐 — D-2)。**`app_start: false`はSTARTのみを拒否し、RERUN等の既存解決には影響しない**(第4巡N-6) |
| `business_key` | 文字列1行(条件付き) | 人 | 命名例: `monthly_deal_summary@2026-08-correction-1` |
| `scheduled_for` | **日時フィールド**(条件付き) | 人 | kintone保存値(ISO/UTC)をポーラーがRFC 3339へ正規化して`--scheduled-for`へ |

**キー規則(第4巡N-1でv3から改訂 — correctionはas-of固定が必須)**:

| policy | 受理する入力 | as-of | 備考 |
| --- | --- | --- | --- |
| `explicit` | `business_key`単独 | Run作成時刻(Phase 1 §9既定) | `scheduled_for`付きはREJECTED |
| `scheduled_period` | `scheduled_for`単独 | 対象期間 | 定期キー(cronと同じ導出) |
| `scheduled_period` | **`business_key`+`scheduled_for`両方**(correction) | **`scheduled_for`(対象期間)に固定** | **v3の「両方=REJECTED」を撤回**。business keyは補正名、scheduled_forが集計断面を決める |
| `scheduled_period` | `business_key`単独 | — | **REJECTED / AS_OF_UNDEFINED**(第4巡N-1 — as-ofが起動時刻になり、8月補正キーで9月断面を集計する「静かに間違う」結果を生むため禁止。実測根拠: monthly_deal_summaryの3ノードは全てas-of派生関数を使用し、初回本番導入時に過去月バックフィルの同型問題を実測済み) |
| 任意 | 両方欠落 | — | REJECTED / KEY_POLICY_MISMATCH |

- 既存欄(`run_id`)はSTARTでは空必須(§4表`RUN_ID_NOT_ALLOWED`)
- **処理前取消(起票後〜claim前の取消)は[P2-12](./implementation-plan.md)へ切り出し**(第6巡X-1 — P2-01の状態機械・権限モデル・G-09を改訂するため個別レビューで扱う。P2-10切り出しと同じ判断)。それまで起票後の取消手段はない(最大5分でポーラーが処理 — §8留意点)
- 既存のRERUN/STOP/RELEASE・状態機械・claim/heartbeat/stale・結果書き戻し(G-05〜G-08)は変更しない

## 4. 受理範囲(fail-closed)と三重ゲート

**STARTの三重ゲート**: ①**人の権限**(操作要求アプリのレコード追加権限) × ②**運用リリース**(allowlistエントリの**`app_start: true`明示** — 既定falseでfail-closed) × ③**コードの安全宣言**(全実行対象ノードが明示的に`idempotent: true` — `false`・未指定は拒否)。

②③分離の根拠(C-1訂正済み): 非冪等ノードの新規起動に`--approved-by`は不要で初回実行に二重実行リスクもない(Phase 1 §7.2)。危険の本質は「アプリ権限者なら誰でも外部副作用(請求・通知)を発火できる」という権限とレビューの問題。非冪等networkの開放は将来、③の条件緩和+再審議で行う。

**追加の歯止め**: `max_active_runs`(既定1)により開放networkでも未完了Runは同時1本まで(§1但し書き参照)。

| 条件 | 判定 |
| --- | --- |
| allowlistにない/`app_start: true`でない | REJECTED / NETWORK_NOT_ALLOWED(**内部detailで`NOT_IN_ALLOWLIST`/`APP_START_DISABLED`を区別**して結果メッセージへ — 第4巡ChatGPT-3、M4の設定ミス追跡用。利用者向け文言は同一) |
| 全実行対象ノードが明示的に`idempotent: true`でない | REJECTED / NETWORK_NOT_IDEMPOTENT(**実機再現不能のため単体のみで担保と明記** — 第4巡N-5、P2-09受入13と同型) |
| `run_id`が記入されている | REJECTED / RUN_ID_NOT_ALLOWED |
| キー規則違反(§3表) | REJECTED / KEY_POLICY_MISMATCH または AS_OF_UNDEFINED |
| `scheduled_for`正規化不能 | REJECTED / INVALID_TIMESTAMP_FORMAT |
| 同一`profile+network_id+業務キー`のRunが完了(SUCCESS) | `DONE / NOOP_ALREADY_SUCCESS`+固定文言(既存Run #\<id\>=NOOP JSONのrun_id。スキップ明示+補正キー案内) |
| 同一キーのRunが未完了 | REJECTED+既存run_id(`blocked_run_ids`)+「RERUNを使用してください」。状態別細分はP2-01受理状態表を正とする |
| **別キーの未完了Runが存在し`max_active_runs`超過** | **REJECTED / MAX_ACTIVE_RUNS**(第4巡N-2 — 新設行)+文言「未完了Run #\<id\>があるため起動できません。失敗Runのやり直しはRERUNを、整理できない場合は二次対応者へ」(同一キー案内と混同させない) |
| 起動時のnetwork実行ロック競合 | REJECTED / LOCK_CONFLICT — **判定順序は既存CLIの実行順を正とし、active上限判定が先に成立すればMAX_ACTIVE_RUNS。LOCK_CONFLICTは上限判定を通過した後のロック取得競合(レース・残存lock等)に限定**(第6巡ChatGPT-5 — 2行を排他化)。**business key重複ではなく、別business keyのRunとのnetwork実行ロック競合を指す**(第4巡ChatGPT-1の定義文)。「時間をおいて再起票」で受け止める |
| 実行結果 | G-07踏襲: Invocation作成後は`DONE`+結果記録 |

**`DONE`の意味**: 「START要求の処理が完了した」ことを示し、Runの成功を意味しない。Run成否はボードで追跡(要求終端表示・一覧名でも混同させない)。

## 5. UI(2段階)

**第1段(M1〜M3)**: 操作要求アプリへ直接レコード追加。一次対応1ページへ入力例(correction=補正キー+対象期間の**両方**を入れる、を明記)と「ポーラーは5分間隔で処理するため、要求から起動開始まで数分かかることがあります」を記載

**第2段(M4)**: ボードヘッダーへ「新規実行」ボタン(要求アプリ設定時のみ)→ダイアログ:

- network候補は「**参考候補(過去実績)**」ラベルで2群(①START DONE実績 ②Run実績 — ページング+クライアント集約・上限欠落あり得る注記)+自由入力主体+「実際に起動可能かはサーバー側設定で判定されます」(I-03)
- 入力モード切替: 「定期キー(対象期間のみ)」/「補正(補正キー+対象期間)」/「explicit(業務キーのみ)」— §3キー規則をUIで誘導(判定はポーラーが正)。`scheduled_for`はdatetime-local(+09:00既定)
- **STARTの重複ガードは新規実装**(P2-09のrun_id集合GETは流用不可)。**判定キーは入力モード別**(第6巡ChatGPT-2 — v5のOR条件はcorrection-1とcorrection-2が同一scheduled_forを持つ正当な別業務単位を過剰拒否するバグ): explicit=`network_id+business_key`等値 / 定期キー=`network_id+scheduled_for`等値 / **correction=`network_id+business_key+scheduled_for`の全て等値(AND)**。いずれも`request_type=START ∧ state in (REQUESTED, ACCEPTED)`の等値GET。**比較はkintone保存値(UTC正規化済み)で行う**(第4巡ChatGPT-4)。クライアント側でも完全一致の二重フィルタ(第4巡Gemini-2)。見逃してもI-02が正。**処理待ちSTARTはヘッダーへ「処理待ちのSTART要求 N件」**(要求一覧リンク)で表示。fail-open・GET 403はP2-09 §3共通2/3を継承
- 起票後は要求リンク+「Runが作成されるとボードに現れます」

## 6. 受入基準(実機E2E)

1. START(explicit+業務キー)→`--resume`なしNEW起動→完走→`DONE`・相関・ボード出現→消滅(一気通貫)
2. `scheduled_period`の2経路: (a)`scheduled_for`単独→期間キー導出で完走 (b)**correction(`business_key`+`scheduled_for`両方)→business keyは補正名・as-ofは対象期間で完走し、集計結果が対象期間の断面であること**(第4巡N-1の直接検証 — 8月補正が8月分を集計する)
3. 同一キー再START→`DONE / NOOP_ALREADY_SUCCESS`+固定文言(既存Run id入り)。未完了→REJECTED+blocked run_id。ほぼ同時2件で1件のみ作成
4. 拒否系: allowlist外/app_startなし(detail区別) / **`business_key`単独のscheduled_period START(AS_OF_UNDEFINED)** / **別キー未完了によるMAX_ACTIVE_RUNS** / キー規則違反 / 不正日時 / run_id記入 — REJECTED+理由、状態不変。**既存未完了Runがresumeされないこと**。非冪等拒否は単体のみで担保(N-5)
5. 第2段: ダイアログから受入1相当が完結。入力モード切替・参考候補・処理待ちSTART表示。未設定時ボタン非表示
6. 既存機能(RERUN/STOP/RELEASE・定期cron)に回帰がない。**`app_start: false`のnetworkでRERUNが従来どおり動く**(N-6)
7. 文書整合(§7 M0改訂リスト: D-1〜D-3・P2-01受理表・templates/README・一次対応1ページ)
8. 障害注入 — claim後クラッシュ: stale回収は`REJECTED / STALE`終端(自動再claim・再実行なし)、二重Run不作成、人の再要求が`NOOP_ALREADY_SUCCESS`/既存案内へ収束。一次対応1ページへ「STARTがSTALEになったらボードに新Runが出ていないか確認してから再起票」

**M2単体の受理判定matrix(全行必須)**:

| allowlist+app_start | 冪等 | policy | 入力 | run_id欄 | 既存Run | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| ×(未掲載) | — | — | — | — | — | REJECTED / NETWORK_NOT_ALLOWED (NOT_IN_ALLOWLIST) |
| ×(app_start無) | — | — | — | — | — | REJECTED / NETWORK_NOT_ALLOWED (APP_START_DISABLED) |
| ○ | × | — | — | — | — | REJECTED / NETWORK_NOT_IDEMPOTENT |
| ○ | ○ | — | — | 記入あり | — | REJECTED / RUN_ID_NOT_ALLOWED |
| ○ | ○ | explicit | business_key | 空 | なし | 起動(NEW・resumeなし) |
| ○ | ○ | explicit | scheduled_for含む | 空 | — | REJECTED / KEY_POLICY_MISMATCH |
| ○ | ○ | scheduled_period | scheduled_for単独 | 空 | なし | 起動(NEW) |
| ○ | ○ | scheduled_period | **両方(correction)** | 空 | なし | **起動(NEW・as-of=scheduled_for)** |
| ○ | ○ | scheduled_period | **business_key単独** | 空 | — | **REJECTED / AS_OF_UNDEFINED** |
| ○ | ○ | 任意 | 両方欠落 | 空 | — | REJECTED / KEY_POLICY_MISMATCH |
| ○ | ○ | 正 | 不正日時 | 空 | — | REJECTED / INVALID_TIMESTAMP_FORMAT |
| ○ | ○ | 正 | 正 | 空 | 同一キーSUCCESS | DONE / NOOP_ALREADY_SUCCESS(run_id付き) |
| ○ | ○ | 正 | 正 | 空 | 同一キー未完了 | REJECTED+blocked run_id |
| ○ | ○ | 正 | 正 | 空 | **別キー未完了(max超過)** | **REJECTED / MAX_ACTIVE_RUNS** |
| ○ | ○ | 正 | 正 | 空 | 別キー実行中(ロック) | REJECTED / LOCK_CONFLICT |

## 7. 作業分割と現環境の棚卸し

**棚卸し(2026-09-02時点)**: 本番networkは`monthly_deal_summary`1本(policy=`scheduled_period`、全3ノード明示`idempotent: true`、**3ノードともas-of派生関数使用** — N-1の前提確認済み)。初期開放対象=この1本。correction経路(§3)により主目的が成立する。

| # | 作業 | 内容 |
| --- | --- | --- |
| M0 | 仕様確定+**コード確認3点**(§2: --business-key/--scheduled-for併用可否・重複案内JSONのrun_id) | Codexレビュー→改訂点確定: D-1(P2-08計画§9撤回追記)/D-2(P2-01 G-03へSTART分岐)/D-3(P2-09 §3へヘッダーボタン・STARTガード追記)/P2-01受理表/templates/README(三重ゲート)。チェック項目「仕様条件追加=受入同時追加」 |
| M1 | 要求モデル・テンプレート・allowlist拡張 | START種別+3欄追補、request-model検証(キー規則・run_id空)、allowlist`app_start`(既定false・後方互換) |
| M2 | ポーラー+CLI表示境界 | START処理(直接解決→三重ゲート→キー規則→正規化→resumeなしNEW→G-07分類)。`blocked_run_ids`のJSON追加(M0確認で要否確定)。単体=§6 matrix全行+argvにresumeなし固定+blocked_run_ids欠落時の安全取り出し |
| M3 | 実機受入(第1段) | スパイク環境で受入1〜4・6・8(**受入2bのas-of断面検証を含む**) |
| M4 | ボードUI(第2段)+文書 | 新規実行ボタン・入力モード切替ダイアログ・処理待ちSTART表示・受入5・7、本番適用(allowlistへ`app_start: true`明示) |

規模: **M**。実装はCodex、レビュー・実機受入はClaude Code。

## 8. 留意点

- 即時性はポーラー周期依存(5分+処理時間)
- 業務キーは人が意味のある値を付ける。correctionでは**対象期間の指定を忘れない**(忘れはAS_OF_UNDEFINEDで止まる)
- allowlistの`app_start`付与はVPS上のファイル編集(二次対応者作業)。三重ゲート+`max_active_runs`が権限モデルの正
- **起票後の取消手段はP2-12まで提供されない**(第6巡X-1で切り出し)。誤起票に気づいたら一次対応者は二次対応者へ連絡(最大5分でポーラーが処理してしまうため間に合わない前提で、起動後のRunはSTOPで停止する)

## 9. レビュー対応記録

**第1巡(Gemini 4点)・第2巡(ChatGPT 5+6点)・第3巡(Claude第1回 B2/C5/D3/E6)**: v2〜v3で全採用(詳細は本文各所とレビューファイル参照。要点: NOOP固定文言/候補2群/ガードキー等値/日時型化/意味論表/idempotent未指定拒否/stale規律修正採用/--resume禁止契約/correction経路/app_startゲート/C-1根拠訂正ほか)

**第4巡(2026-09-02)**:

| 出所 | 指摘 | 採否・判断 |
| --- | --- | --- |
| Claude N-1 | correction STARTのas-ofが起動時刻になり結果が静かに間違う(v3のキー排他が唯一の回避策を禁止) | **採用(最重要)** — キー規則を改訂: correction=`business_key`+`scheduled_for`**両方必須**(as-of=対象期間に固定)、`business_key`単独は`AS_OF_UNDEFINED`で拒否(§3表)。受入2bへas-of断面の直接検証。棚卸しへ「3ノードともas-of派生関数使用」を追記。M0コード確認(両フラグ併用可否)を前提ゲートに |
| Claude N-2 | max_active_runs行の欠落(失敗締め残存時に補正STARTが黙って拒否) | **採用** — `MAX_ACTIVE_RUNS`行を受理表/matrixへ新設、専用文言(RERUN誘導・同一キー案内と分離)、§1但し書きへP2-10依存を明記。「失敗した締めのやり直しはRERUNが正」を操作モデル表へ |
| Claude N-5 | 非冪等拒否は実機再現不能 | **採用** — 単体のみで担保と明記(§4/受入4 — P2-09受入13と同型) |
| Claude N-6 | app_start:falseがRERUNの解決を壊さないことの明記 | **採用**(§3/受入6) |
| Claude M0前倒し3点 | CLIの--business-key/併用/重複JSONの実挙動確認 | **採用** — M0作業へ(仕様が依存する事実の先行確認) |
| ChatGPT 1 | LOCK_CONFLICTの定義厳密化 | **採用** — 「別business keyとの実行ロック競合」定義文(§4) |
| ChatGPT 2 | NOOP時の既存run_idをJSON契約に | **採用** — NOOP経路run_id=既存Runの契約を明文化(§2。現行G-04出力どおりで実装変更は不要見込み) |
| ChatGPT 3 | NETWORK_NOT_ALLOWEDの内部detail区別 | **採用** — NOT_IN_ALLOWLIST/APP_START_DISABLED(§4/matrix) |
| ChatGPT 4 | UI重複ガードはkintone保存値で等値判定 | **採用**(§5)+I-02の二段構え明記 |
| Gemini 1〜3 | 日付のみ入力の拒否徹底/等値検索のクライアント二重チェック/blocked_run_ids安全取り出し | **採用**(§4/§5/§2) |

**第5巡(2026-09-02 ユーザー指摘)** — ※本巡でv5へ入れた取消設計は、第6巡X-1の採用により**P2-12へ移管**(採用判断自体は維持。実現はP2-12の個別仕様・レビューで行う):

| 指摘 | 採否・判断 |
| --- | --- |
| 起票後〜claim前(最大5分)の取消手段がない | **採用** — `cancel_requested`欄+状態機械へ`CANCELLED`終端を追加(claim時検知のみ・ACCEPTED以降は無効)。全request_type共通の汎用改善 |
| 取消は人の直接編集ではなくボタン+プラグイン設定で | **採用** — ボードのpending表示へ取消ボタン(確認ダイアログ→取消欄のみのPUT)。G-09を「POST+取消欄のみPUT」へ改訂、一次対応者へ要求アプリ編集権限を付与(直接編集禁止の運用規律+fail-closedパーサが防波堤、取消者はkintone更新者で真正性担保) |

**第6巡(2026-09-02 Gemini承認+3・ChatGPT 9.6+5・[Claude第3回](./p2-11-spec-review-3.md) X-1〜X-7)**:

| 指摘 | 採否・判断 |
| --- | --- |
| Claude X-1 | 取消はP2-01(REVIEWED)の状態機械・権限モデル・G-09を書き換える「改訂」であり、1巡しか経ていない — P2-12へ切り出し推奨 | **採用** — 第5巡分をP2-12へ移管。ChatGPTが同巡で取消設計に競合規則欠落(I-04)・受入配置矛盾(X-2同着)等を検出したことも「取消には独自のレビューサイクルが要る」ことの裏付け。X-2〜X-6(受入8のM3/M4矛盾、ACCEPTED行の取消ボタン、フィールドACL、G-09改訂のM0漏れ、作業分割漏れ)およびChatGPT-1(revision競合裁定I-04)/-3(受入8分割)/-4(更新者≠取消者、変更履歴を正)、Gemini-2(フィールドアクセス権)/-3(409握りつぶし+再読込)は**全てP2-12の設計論点として引き継ぐ** |
| ChatGPT 2 | correction重複ガードのOR過剰拒否 — correction-1とcorrection-2は同一scheduled_forを持つ正当な別業務単位なのにOR条件が「重複」判定する | **採用(バグ修正)** — §5の判定キーを入力モード別へ: explicit=network+business_key / 定期キー=network+scheduled_for / correction=**3キー全て等値(AND)** |
| ChatGPT 5 | MAX_ACTIVE_RUNSとLOCK_CONFLICTの判定が実装依存で重なり得る | **採用** — 判定順序は既存CLI実行順を正、上限判定が先に成立すればMAX_ACTIVE_RUNS、LOCK_CONFLICTは上限通過後のロック取得競合に限定(§4で排他化) |
| ChatGPT F-01 | correction契約(両フラグ併用)の実装成立をM0で確認するまでFROZENにしない | **採用** — §2へ凍結ゲートF-01を明記 |
| Claude X-7 | NOOP経路のrun_idはG-04が保証していない(§4固定文言が依存) | **採用** — M0コード確認を4点へ拡張(④NOOP JSONのrun_id有無) |
| Gemini 1 | 両フラグ併用時「business_key採用+as-ofはscheduled_forから」の期待動作を確認内容へ | **採用** — M0①②の確認内容へ明記。不成立ならCLI後方互換拡張をM2へ計上 |
| Gemini 判定 / ChatGPT 9.6 | FROZEN承認 / 1・2修正のうえv6でFROZEN可 | 上記反映のうえ**v6=FROZEN候補(F-01確認のみ残)**とする |
