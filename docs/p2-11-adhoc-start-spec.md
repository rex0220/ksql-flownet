# P2-11: 不定期ジョブのアプリ起動(START要求) 仕様書

- 文書状態: **DRAFT v3**(Phase 2作業単位。凍結仕様の変更なし — 操作要求モデル(P2-01)とボードプラグイン(P2-08/09)の拡張。ポーラーが`run-network`の**新規起動**を仲介する)
- 起案日: 2026-09-01 / 改訂: 外部レビュー第1巡(Gemini 4点)・第2巡(ChatGPT 5+6点)・第3巡([Claudeレビュー](./p2-11-spec-review.md) B×2・C×5・D×3・E×6)をすべて採用(§9に判断記録。第2巡受入8と第3巡B-2(b)は当方判断で修正採用)
- 正本参照: [p2-01-app-rerun-spec.md](./p2-01-app-rerun-spec.md)(要求モデル・状態機械・受理の正)、[p2-09-board-request-spec.md](./p2-09-board-request-spec.md)(起票UIの正)、[job-network-phase1-spec.md](./job-network-phase1-spec.md) §2.1・§4.3・§7.2・§9
- **方針変更の明示**: P2-08実装計画§9はcorrection Run作成のアプリ化を非対象としていた。本仕様はこれを撤回する(同計画§9への撤回追記=改訂点D-1)

## 1. 目的と操作モデルの意味論

**目的**: 定期cron以外のタイミングで必要になるジョブ(締めのやり直し・補正Run・臨時集計・データ修正バッチ)を、**kintoneの操作要求アプリから起動**できるようにする。一次対応の画面完結線に唯一残った「新規Runの起動」の穴を塞ぐ。

**STARTの定義**: STARTは**未作成の業務実行単位(新しいbusiness key)を作成する操作**であり、既存business keyの「再実行」を意味しない。既存Runの再開はRERUN、SUCCESS済み期間への補正は**新しいbusiness key**(`…-correction-N`)によるSTARTで行う。

**操作モデル(全体像)**:

| やりたいこと | 操作 |
| --- | --- |
| 定期実行 | cron(VPS) |
| まだ実行していない業務単位を起動 | **START**(本仕様) |
| 失敗・中断した既存Runの再開 | RERUN(P2-01/09) |
| Run単位の停止/解除 | STOP / RELEASE(P2-01/09) |
| SUCCESS済み期間への補正 | **START+補正business key**(例: `monthly_deal_summary@2026-08-correction-1` — Phase 1 §2.1/§9が明示的に許可するcorrection経路) |
| `app_start`未開放network・resolve等の判断操作 | CLI専権 |

**非目的**: 即時実行(ポーラー経由の非同期のまま)。cron定期起動の置き換え。業務アプリ個別の起動ボタン(操作要求アプリへ集約)。

## 2. 方式・起動コマンド契約・不変条件

```
人: 操作要求アプリへ START レコード追加(network_id・業務キー or 対象期間・理由)
      ↓ (ポーラー 5分cron)
ポーラー: allowlistでnetwork_id→定義パス解決
      → run-network <定義パス> --business-key <key> --json     (explicit / correction)
      → run-network <定義パス> --scheduled-for <RFC3339> --json (scheduled_period 定期同一キー)
      ↓
実行管理/監査: 通常Runとして記録(requested_by = app-request:<record_id>:<作成者> 相関)
```

**起動コマンド契約(第3巡B-1 — M0確定事項)**:

- **`--resume`/`--resume-run`を付けることを明示的に禁止する**。付けると未完了Runがresumeされ、P2-01のRERUN受理条件(G-01/G-02/hold/resume_allowed)を全て迂回する「RERUNの裏口」になる。実装計画のチェック項目に入れ、単体で「STARTのargvにresumeが含まれない」ことを固定する
- `--resume`なしのNEW経路では、Phase 1 §2.1により「未完了Runが既に存在」は起動せず案内で終わる(=§4の期待)。**この重複案内経路の`--json`出力へ既存run_idが載ることを確認し、載らない場合は`blocked_run_ids`をJSONへ追加する**(現行実装はエラー経路のrun_idが`--resume-run`引数由来のためNEW経路ではnullになる見込み — P2-01 G-04と同じCLI表示境界の後方互換拡張として**M2作業に計上**)
- `outcome`とG-07分類の写像(§4表参照): NEW作成→`DONE`/完了済みNO-OP→`DONE / NOOP_ALREADY_SUCCESS`/未完了案内・検証拒否(Invocation作成前)→`REJECTED`

**profile前提(第3巡E-1)**: 本仕様は**単一profile運用**(ポーラーの環境変数`KSQL_FLOWNET_PROFILE`由来)を前提とし、要求レコードにprofile欄を持たない。複数profile運用を始める場合は本仕様の再審議事項。

**不変条件(将来の実装変更でも維持)**:

- **I-01**: STARTは新規業務実行単位の作成要求である。既存Runの状態変更・再開・再実行には使用しない(`--resume`禁止はこの帰結)
- **I-02**: Runの一意性(`profile + network_id + business_key`)の最終裁定はensure-runが担う。ポーラー/UIの重複確認は補助であり正ではない
- **I-03**: UIのnetwork候補一覧は入力支援であり、START可否を保証しない。可否の正はポーラーallowlist+network定義+CLI検証

**相関の意味定義**: `requested_by`(`app-request:<record_id>:<作成者>`)は**表示・監査用の相関文字列**であり、機械的な正規キーとしては扱わない(将来Slack/Webhook等の別入口はprefix部の拡張で区別)。

## 3. 要求レコードの拡張

操作要求アプリへ追加(テンプレート追補):

| フィールド | 型 | 書き手 | 内容 |
| --- | --- | --- | --- |
| `request_type` | 既存ドロップダウンへ**`START`**を追加 | 人 | — |
| `network_id` | 文字列1行(START時必須) | 人 | 起動対象。allowlist直接解決(0件=REJECTED / NETWORK_NOT_ALLOWED。**RERUN等のstatus検索経路(P2-01 G-03)とは別分岐** — 改訂点D-2) |
| `business_key` | 文字列1行(条件付き) | 人 | `explicit`のnetworkでは必須。**`scheduled_period`のnetworkでもcorrection用途で指定可**(第3巡B-2(a) — Phase 1 §2.1/§9のcorrection経路を塞がない) |
| `scheduled_for` | **日時フィールド**(条件付き) | 人 | `scheduled_period`の定期同一キー起動用。kintone保存値(ISO/UTC)をポーラーが**RFC 3339へ正規化**して`--scheduled-for`へ。正規化不能は拒否 |

**キー規則(B-2(a)反映)**: `explicit`→`business_key`必須(`scheduled_for`不可)。`scheduled_period`→`scheduled_for`(定期同一キー)**または**`business_key`(correction)の**どちらか一方**。両方入力・両方欠落はREJECTED。

- 既存欄(`run_id`)はSTARTでは**空必須**(誤用防止 — §4表`RUN_ID_NOT_ALLOWED`)
- 既存のRERUN/STOP/RELEASE要求・状態機械・claim/heartbeat/stale・結果書き戻し(G-05〜G-08)は変更しない

## 4. 受理範囲(fail-closed)と三重ゲート

**STARTの三重ゲート**: ①**人の権限**(操作要求アプリのレコード追加権限) × ②**運用リリース**(allowlistエントリの**`app_start: true`明示** — 第3巡B-2(b)代案を採用。既定は`app_start: false`でfail-closed、開放は人の明示判断としてファイルに残る) × ③**コードの安全宣言**(当面の開放条件: networkの全実行対象ノードが**明示的に`idempotent: true`** — `false`・未指定は拒否)。

②と③を分離した理由(第3巡C-1の根拠訂正): 非冪等ノードを含むnetworkの**新規起動**自体に`--approved-by`は不要で(それはresolve-nodeの要件)、未実行ノードの初回実行に二重実行リスクもない(Phase 1 §7.2)。危険の本質は「**アプリの追加権限者なら誰でも、外部副作用(請求・通知等)を発火できてしまう**」という権限とレビューの問題。よって将来、非冪等を含む締め系networkを開放したくなった場合は、③の条件緩和を`app_start`の明示判断+再審議で行う(現時点では③を維持)。

**追加の実効的な歯止め(第3巡E-4)**: `max_active_runs`(既定1)により、開放networkでも未完了Runは同時1本まで。

| 条件 | 判定 |
| --- | --- |
| network_idがallowlistにない/`app_start: true`でない | REJECTED / NETWORK_NOT_ALLOWED |
| 全実行対象ノードが明示的に`idempotent: true`でない | REJECTED / NETWORK_NOT_IDEMPOTENT |
| **`run_id`が記入されている** | REJECTED / RUN_ID_NOT_ALLOWED(第3巡C-2) |
| キー規則違反(§3 — policy不整合・両方入力・両方欠落) | REJECTED / KEY_POLICY_MISMATCH |
| `scheduled_for`の正規化不能 | REJECTED / INVALID_TIMESTAMP_FORMAT |
| 同一`profile+network_id+業務キー`のRunが**完了(SUCCESS)** | **`DONE / NOOP_ALREADY_SUCCESS`**+固定文言「新規実行はスキップしました(既存Run #\<id\>は処理済み)。やり直しは補正キー(例: …-correction-1)を付けて再要求してください」 |
| 同一キーのRunが**未完了** | REJECTED+既存run_id案内(「RERUNを使用してください」— run_idはB-1で確定する`blocked_run_ids`から取得)。状態別の細分は**P2-01のRERUN受理状態表を正**とし本仕様で再定義しない |
| 起動したがNetworkロック競合(同一networkの別Runが実行中) | REJECTED / LOCK_CONFLICT(異常ではない — 「時間をおいて再起票」を案内。第3巡E-3) |
| 実行結果 | G-07踏襲: Invocation作成後はaggregateに関わらず`DONE`+結果記録 |

**`DONE`の意味**: `DONE`は「**START要求の処理が完了した**(起動できた/正当にスキップした)」ことを示し、**起動されたRunの成功を意味しない**。Run成否はボード/実行管理で追跡する(要求の終端表示・一覧名でも混同させない — 第3巡E-5)。

## 5. UI(2段階)

**第1段(M1〜M3)**: 操作要求アプリへ直接レコード追加。`network_id`は手入力(検証はポーラー)。一次対応1ページへ入力例と「ポーラーは5分間隔で処理するため、要求から起動開始まで数分かかることがあります」を記載

**第2段(M4)**: ボードヘッダーへ**「新規実行」ボタン**(要求アプリ設定時のみ表示)→ダイアログ:

- network_id候補は**「参考候補(過去実績)」ラベル**で2群表示: ①起動実績あり(過去のSTART DONE実績 — 要求アプリから収集)、②その他の実行実績(NETWORK_RUN distinct相当 — kintoneにDISTINCTはないためページング+クライアント集約、**上限による欠落あり得る旨を注記**)。常時注記「候補表示は入力支援です。実際に起動可能かはサーバー側設定で判定されます」+**自由入力を主・候補を補助**(第3巡C-5: allowlist外の候補混入・掲載済み未実行の非表示という非対称は注記+`NETWORK_NOT_ALLOWED`理由の明快さで受け止める)
- `scheduled_for`はdatetime-local入力(+09:00既定でRFC 3339化)、`business_key`はテキスト+命名例表示。**キー規則(§3)をダイアログ注記で説明**(判定はポーラーが正)
- **STARTの重複ガードは新規実装**(第3巡C-4 — P2-09のrun_id集合GETは流用不可): `request_type=START かつ network_id等値 かつ (business_key等値 または scheduled_for等値) かつ state in (REQUESTED, ACCEPTED)`の等値GET。**処理待ちSTARTは対応Runが無くボード行に出せないため、ヘッダー(新規実行ボタン横)へ「処理待ちのSTART要求 N件」(要求一覧リンク)を表示**。fail-open・GET 403の扱いはP2-09 §3共通2/3を明示的に継承
- 起票後は要求リンク+「Runが作成されるとボードに現れます」の案内

## 6. 受入基準(実機E2E)

1. START要求(explicit network+業務キー)→ポーラー→**`--resume`なしのNEW起動**→完走→要求`DONE`、監査の`requested_by`相関、ボードに出現→完走で消える(一気通貫)
2. `scheduled_period` networkへの2経路: (a)日時フィールド指定→期間からbusiness key導出で完走、(b)**correction business_key直接指定**(`…-correction-1`)で完走(第3巡B-2(a)の主目的経路)
3. 同一キーで再START→完了済みは`DONE / NOOP_ALREADY_SUCCESS`+固定文言。未完了Runがある場合はREJECTED+**既存run_id**案内(B-1のJSON契約で取得)。ほぼ同時の2件起票で1件のみRun作成
4. 拒否系: allowlist外・`app_start`なし / 非冪等(未指定含む) / キー規則違反 / 正規化不能日時 / run_id記入済み — いずれもREJECTED+理由、FlowNet状態不変。**既存の未完了Runがresumeされないこと**(B-1 — STARTがRERUNの裏口にならない直接検証)
5. 第2段: ダイアログから受入1相当が完結。参考候補2群・注記・命名例・**ヘッダーの処理待ちSTART表示**。要求アプリ未設定時はボタン非表示
6. 既存のRERUN/STOP/RELEASE・定期cron・ポーラーの他要求処理に回帰がない
7. 文書整合(§7 M0の改訂リストどおり — D-1〜D-3含む)
8. **障害注入 — claim後クラッシュ**: claim後・Run作成後・書き戻し前にポーラー異常終了 → stale回収は`REJECTED / STALE`終端(自動再claim・再実行しない — G-05)、**二重Runは作成されない**。人の再要求は`DONE / NOOP_ALREADY_SUCCESS`または既存Run案内へ収束。一次対応1ページへ「**STARTがSTALEになったら、ボードに新しいRunが出ていないか確認してから再起票**」を記載(第3巡E-2)

**M2単体の受理判定matrix(全行必須)**:

| allowlist+app_start | 冪等(全ノード明示true) | policy | 入力キー | run_id欄 | 既存Run | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| × | — | — | — | — | — | REJECTED / NETWORK_NOT_ALLOWED |
| ○ | × | — | — | — | — | REJECTED / NETWORK_NOT_IDEMPOTENT |
| ○ | ○ | — | — | **記入あり** | — | REJECTED / RUN_ID_NOT_ALLOWED |
| ○ | ○ | explicit | business_key | 空 | なし | 起動(NEW・resumeなし) |
| ○ | ○ | explicit | scheduled_for | 空 | — | REJECTED / KEY_POLICY_MISMATCH |
| ○ | ○ | scheduled_period | scheduled_for | 空 | なし | 起動(NEW) |
| ○ | ○ | scheduled_period | **business_key(correction)** | 空 | なし | **起動(NEW)** |
| ○ | ○ | 任意 | 両方入力/両方欠落 | 空 | — | REJECTED / KEY_POLICY_MISMATCH |
| ○ | ○ | 正 | 不正日時 | 空 | — | REJECTED / INVALID_TIMESTAMP_FORMAT |
| ○ | ○ | 正 | 正 | 空 | SUCCESS | DONE / NOOP_ALREADY_SUCCESS |
| ○ | ○ | 正 | 正 | 空 | 未完了 | REJECTED+blocked run_id |
| ○ | ○ | 正 | 正 | 空 | 別キーRun実行中 | REJECTED / LOCK_CONFLICT |

## 7. 作業分割と現環境の棚卸し

**実在networkの棚卸し(第3巡B-2の判断材料 — 2026-09-02時点)**: 本番networkは`monthly_deal_summary`の1本のみ(policy=`scheduled_period`、全3ノード明示`idempotent: true` — PRE-05棚卸し済み)。**初期開放対象=この1本**(締めのやり直し・8月分補正が§1の主目的そのもの)であり、B-2(a)のcorrection経路対応により目的は成立する。非冪等を含むnetworkは現存しないため、③の条件緩和は将来の再審議へ送る。

| # | 作業 | 内容 |
| --- | --- | --- |
| M0 | 仕様確定 | 本DRAFTのレビュー(Codex)→改訂点の同時確定: **D-1** P2-08実装計画§9へ撤回追記 / **D-2** P2-01 G-03へSTARTの直接解決分岐 / **D-3** P2-09 §3へヘッダーボタン・START重複ガードの追記(P2-09文書を正として更新) / P2-01受理範囲表へSTART行 / templates/README(三重ゲート) |
| M1 | 要求モデル・テンプレート・**allowlist拡張** | START種別+3欄(scheduled_forは日時型)の追補、request-model検証、**allowlistスキーマへ`app_start`(既定false・後方互換: 未指定=false)** |
| M2 | ポーラー+**CLI表示境界** | START処理(直接解決→三重ゲート→正規化→**resumeなしNEW起動**→G-07分類)。**run-network --jsonの重複案内経路へ`blocked_run_ids`追加**(B-1 — G-04と同じ後方互換拡張)。単体は§6 matrix全行必須+「argvにresumeが含まれない」固定 |
| M3 | 実機受入(第1段) | スパイク環境で受入1〜4・6・8 |
| M4 | ボードUI(第2段)+文書 | 新規実行ボタン・ダイアログ・処理待ちSTART表示・受入5・7、本番適用(allowlistへ`app_start: true`を明示設定) |

規模: **M**(allowlist拡張・CLI境界拡張を含むためv1見積りから微増)。実装はCodex、レビュー・実機受入はClaude Code。

## 8. 留意点

- 即時性はポーラー周期依存(5分間隔+処理時間)
- 業務キーは人が意味のある値を付ける(重複禁止が保険として機能する条件)
- allowlistの`app_start`付与はVPS上のファイル編集(二次対応者作業)。三重ゲート(§4)+`max_active_runs`が権限モデルの正

## 9. レビュー対応記録

**第1巡(2026-09-01 Gemini 4点)**: (1)NOOP誤認→趣旨採用・DONE維持+固定文言(REJECTED化はRERUNのNOOP=DONE分類と矛盾) (2)候補混入→2群化+注記 (3)同時起票レース→ガードキー等値GET固定+CLI裁定が正 (4)日時形式→厳格検証(のち第2巡で入力自体を日時型へ)

**第2巡(2026-09-01 ChatGPT 5+6点)**: (1)意味論表→採用(§1) (2)idempotent未指定=拒否→採用 (3)claim後クラッシュE2E→**修正採用**(提案の「再claimで収束」は当システムのstale規律(自動再claimしない)と異なるため、STALE終端+二重Run不作成+人の再要求収束として受入8へ) (4)候補≠権限の表示→採用 (5)scheduled_for日時型→採用/追加6点(DONE≠Run SUCCESS・三重ゲート・P2-01参照・requested_by意味定義・5分文言・matrix・不変条件)→すべて採用

**第3巡(2026-09-02 [Claudeレビュー](./p2-11-spec-review.md))**:

| # | 指摘 | 採否・判断 |
| --- | --- | --- |
| B-1 | 起動コマンド契約未定義(`--resume`でRERUN裏口化) | **採用** — `--resume`明示禁止・キー引数込みの契約・`blocked_run_ids`のJSON追加をM2計上・outcome写像(§2/§4/§6) |
| B-2(a) | キー排他がcorrection経路(主目的)を禁止する自己矛盾 | **採用** — `scheduled_period`へのbusiness_key直接指定(correction)を受理範囲に追加(§3/§6受入2b/matrix) |
| B-2(b) | 非冪等一律拒否で開放対象ゼロの懸念+`app_start`代案 | **修正採用** — `app_start`フラグは採用(明示判断が残り監査向き)。ただし現環境の棚卸し(§7: 実network1本・全ノード冪等)により**③冪等条件は当面維持**し、非冪等networkの開放は将来の条件緩和+再審議へ(C-1の根拠訂正とセット) |
| C-1 | 非冪等拒否の根拠誤り(`--approved-by`はresolve-nodeの要件) | **採用** — 根拠を「外部副作用の発火権限とレビューの問題」へ書き換え(§4) |
| C-2 | RUN_ID_NOT_ALLOWED行の欠落 | **採用**(§4表/matrix) |
| C-3 | 受入3のB-1依存 | **採用** — B-1確定内容で書き直し(受入3/4) |
| C-4 | START重複ガードはP2-09流用不可+処理待ちの表示位置 | **採用** — 新規実装と明記、ヘッダーへ「処理待ちのSTART要求 N件」(§5) |
| C-5 | 候補とallowlistの非対称 | **採用** — 「参考候補(過去実績)」ラベル・自由入力主体・欠落あり得る注記(§5) |
| D-1〜D-3 | 既存文書の改訂点漏れ | **採用** — M0の改訂リストへ(§7) |
| E-1〜E-6 | profile前提・STARTのSTALE文言・LOCK_CONFLICT・max_active_runs・DONE表示規律・用語 | **すべて採用**(§2/§4/§6受入8/§8) |
