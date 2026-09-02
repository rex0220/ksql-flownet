# P2-11: 不定期ジョブのアプリ起動(START要求) 仕様書

- 文書状態: **DRAFT v2**(Phase 2作業単位。凍結仕様の変更なし — 操作要求モデル(P2-01)とボードプラグイン(P2-08/09)の拡張。ポーラーが`run-network`の**新規起動**を仲介する)
- 起案日: 2026-09-01 / 改訂: 同日外部レビュー(Gemini)4点を反映(§8に判断記録)
- 正本参照: [p2-01-app-rerun-spec.md](./p2-01-app-rerun-spec.md)(要求モデル・状態機械・受理の正)、[p2-09-board-request-spec.md](./p2-09-board-request-spec.md)(起票UI・出し分け・重複ガードの正)、[job-network-phase1-spec.md](./job-network-phase1-spec.md) §2.1(業務単位と起動単位の分離 — 補正キー`…-correction-1`の想定形)・§4.3(business_key_policy)・§7(ensure-runの重複裁定)
- **方針変更の明示**: P2-08実装計画§9はcorrection Run作成のアプリ化を非対象としていた。本仕様はこれを撤回し、**冪等networkに限定した新規起動**をアプリへ開放する(非冪等・承認系はCLI専権のまま)

## 1. 目的と非目的

**目的**: 定期cron以外のタイミングで必要になるジョブ(締めのやり直し・補正Run・臨時集計・データ修正バッチ)を、**kintoneの操作要求アプリから起動**できるようにする。現状「新規Runの起動」はSSH+CLIのみで、一次対応の画面完結線(発見→起票→追跡)に唯一残った穴を塞ぐ。

**非目的**: 非冪等ノードを含むnetworkの起動(`--approved-by`を要する操作はCLI専権)。即時実行(ポーラー経由の非同期のまま)。cron定期起動の置き換え(定期は引き続きVPS cron)。業務アプリ個別の起動ボタン(操作要求アプリへ集約)。

## 2. 方式: `START`要求種別の追加

```
人: 操作要求アプリへ START レコード追加(network_id・業務キー or 対象期間・理由)
      ↓ (ポーラー 5分cron)
ポーラー: allowlistでnetwork_id→定義パス解決 → run-network <定義パス> --json を新規起動
      ↓
実行管理/監査: 通常Runとして記録(requested_by = app-request:<record_id>:<作成者> 相関)
```

**FlowNet本体は無改修**。既存の安全装置がそのまま最終裁定になる:

1. **重複起動防止**: 同じ`profile + network_id + 業務キー`のRunはensure-runの重複禁止INSERTが拒否(§2.1)。二度押し・再読込後の再押下は既存Run案内/NO-OPへ倒れる — 業務キーの意味論が「いつの分の処理か」を担う
2. **allowlist限定**: 起動可能なnetworkはポーラーallowlist掲載分のみ(P2-01 G-03と同一機構)。**allowlist掲載=アプリからの起動を許可するリリース判断**、という運用線を文書化する
3. **CLI検証が正**: capabilities・validate・max_active_runs・bundle等の既存検証を全て通る。ポーラーの事前チェックは一次審査(親切な拒否理由)のみ

## 3. 要求レコードの拡張

操作要求アプリへ追加(テンプレート追補):

| フィールド | 型 | 書き手 | 内容 |
| --- | --- | --- | --- |
| `request_type` | 既存ドロップダウンへ**`START`**を追加 | 人 | — |
| `network_id` | 文字列1行(START時必須) | 人 | 起動対象。allowlist照合(0件=REJECTED / NETWORK_NOT_ALLOWED) |
| `business_key` | 文字列1行(条件付き必須) | 人 | `business_key_policy: explicit`のnetwork用。例: `monthly_deal_summary@2026-08-correction-1` |
| `scheduled_for` | 文字列1行(条件付き必須) | 人 | `scheduled_period`のnetwork用。ISO日時(例: `2026-08-01T00:00:00+09:00`)→`--scheduled-for`へ |

- `business_key`/`scheduled_for`はnetworkのpolicyに応じて**どちらか一方**(両方・不足はREJECTED。policyはallowlist解決後の定義から判定)
- 既存欄(`run_id`)はSTARTでは**空必須**(誤用防止)。`reason`必須は従来どおり
- 既存のRERUN/STOP/RELEASE要求・状態機械・claim/heartbeat/stale・結果書き戻し(G-05〜G-08)は変更しない

## 4. 受理範囲(fail-closed・初期は狭く)

| 条件 | 判定 |
| --- | --- |
| network_idがallowlistにない | REJECTED / NETWORK_NOT_ALLOWED |
| **networkに`idempotent: false`のノードが1つでもある** | REJECTED / NETWORK_NOT_IDEMPOTENT(定義から判定。非冪等の起動はCLI専権) |
| policyと入力キーの不整合(explicitなのにscheduled_for等) | REJECTED / KEY_POLICY_MISMATCH |
| `scheduled_for`の形式不備(タイムゾーンオフセットまたはZを含む厳格ISO 8601でない、パース不能) | **REJECTED / INVALID_TIMESTAMP_FORMAT**(ポーラー側で厳格検証してからCLIへ渡す — レビュー指摘4。M2単体で境界値必須) |
| 同一`network_id+業務キー`のRunが既に存在 | CLIの重複裁定へ委ねる。**完了済み→`DONE / NOOP_ALREADY_SUCCESS`とし、result_messageを固定文言「新規実行はスキップしました(既存Run #<id>は処理済み)。やり直しは補正キー(例: …-correction-1)を付けて再要求してください」にする**(レビュー指摘1 — 「実行された」とも「失敗した」とも誤認させない)。未完了→resume案内のREJECTED+既存run_id表示 |
| 実行結果 | G-07踏襲: Invocation作成後はaggregateに関わらずDONE+結果記録、作成前拒否はREJECTED |

## 5. UI(2段階)

**第1段(本仕様のM1〜M3)**: 操作要求アプリへ直接レコード追加。`network_id`は手入力(検証はポーラー)。一次対応1ページへ入力例を記載

**第2段(M4、同一仕様内)**: ボードヘッダーへ**「新規実行」ボタン**(要求アプリ設定時のみ表示)→ダイアログ:
- network_id候補は**2群で表示**(レビュー指摘2 — プラグインはVPS上のallowlistを読めないため完全なフィルタは不可能): ①**起動実績あり**=過去にSTART要求がDONEになったnetwork(要求アプリから収集 — 画面実行が許可されている強い証拠)、②**その他の実行実績**=NETWORK_RUNのnetwork_id distinct(注記「画面実行が許可されていないジョブはポーラー側で却下されます」を常時表示)+自由入力欄。最終判定はポーラーが正
- policy判定は画面では行わず、`business_key` / `scheduled_for`の**両欄を出して片方入力**(注記付き。取り違えはREJECTED理由で気づける)
- 理由必須・確認ステップ・成功表示はP2-09の意匠・共通仕様(§3)を踏襲。**STARTの重複ガードのキーを固定**(レビュー指摘3): `request_type=START かつ network_id等値 かつ (business_key等値 または scheduled_for等値) かつ state in (REQUESTED, ACCEPTED)`の等値GET(kintoneのlikeは完全一致相当の実測があるため等値演算子を使う)。ガードをすり抜けた同時起票はCLIの重複裁定が正(1件目がRun作成、2件目は未完了REJECTED — 既存装置でカバー)
- 起票後は要求リンク+「Runが作成されるとボードに現れます」の案内

## 6. 受入基準(実機E2E)

1. START要求(explicit network+業務キー)→ポーラー→新規Run作成→完走→要求`DONE`、監査の`requested_by`相関、ボードに出現→完走で消える(一気通貫)
2. `scheduled_period` networkへ`scheduled_for`指定のSTART→business keyが期間から正しく導出され完走
3. 同一キーで再START→完了済みは`DONE / NOOP_ALREADY_SUCCESS`+**固定文言(スキップ明示+補正キー案内)**で新Runを作らない。未完了Runがある場合はREJECTED+既存run_id案内。**ほぼ同時の2件起票**で1件のみRun作成・2件目が安全に拒否される(指摘3)
4. 拒否系: allowlist外 / 非冪等network / policy不整合 / **scheduled_forの形式不備(TZなし・パース不能)** / run_id記入済みSTART — いずれもREJECTED+理由、FlowNet状態不変
5. 第2段: ボードの新規実行ダイアログから受入1相当が完結。network候補に過去実績が出る。要求アプリ未設定時はボタン非表示
6. 既存のRERUN/STOP/RELEASE・定期cron・ポーラーの他要求処理に回帰がない(既存単体全合格+実機スモーク)
7. 文書整合: 一次対応1ページ(起動手順・「反映まで最大5分」)、templates/README(START欄追補・allowlist掲載=リリース判断の運用線)、P2-01仕様の受理範囲表へSTART行追記

## 7. 作業分割(想定)

| # | 作業 | 内容 |
| --- | --- | --- |
| M0 | 仕様確定 | 本DRAFTのレビュー(Codex)→P2-01仕様・テンプレートREADMEの改訂点確定。**チェック項目: 仕様条件追加=受入同時追加**(P2-09の教訓) |
| M1 | 要求モデル・テンプレート | START種別+3欄の追補スクリプト、request-modelのSTART検証(run_id空必須・キー排他) |
| M2 | ポーラー | START処理(allowlist解決→policy判定→run-network NEW起動→G-07分類)。単体(受理matrix・重複・拒否系) |
| M3 | 実機受入(第1段) | スパイク環境で受入1〜4・6 |
| M4 | ボードUI(第2段)+文書 | 新規実行ボタン・ダイアログ(P2-09意匠)・network候補収集、受入5・7、本番適用 |

規模: **M**。実装はCodex、レビュー・実機受入はClaude Code(確立済み分担)。

## 8. レビュー対応記録(2026-09-01 外部レビュー: Gemini 4点)

| # | 指摘 | 採否・判断 |
| --- | --- | --- |
| 1 | 完了済み同一キーへのDONE/NOOPは「成功した」と誤認させる | **趣旨採用・解は代替案側** — REJECTED化はP2-09確立済みの分類(RERUNのNOOP=DONE)と矛盾し「失敗した」という逆の誤認を生むため、DONE/NOOP_ALREADY_SUCCESSを維持しつつ**スキップ明示+補正キー案内の固定文言**を必須化(§4) |
| 2 | ダイアログ候補に非許可・非冪等ジョブが混入 | **採用** — 候補を2群化(起動実績あり=過去のSTART DONE実績/その他の実行実績=注記付き)+常時注記(§5)。完全フィルタはallowlistが画面から読めないため不可能と明記 |
| 3 | 同時起票のレース | **採用** — STARTの重複ガードキーを等値GETで固定定義(§5)。すり抜けはCLI重複裁定が正。受入3へ同時2件ケースを追加 |
| 4 | scheduled_forの形式揺れ | **採用** — ポーラー側の厳格ISO 8601検証(TZ必須)+INVALID_TIMESTAMP_FORMATを受理範囲へ(§4)。M2単体で境界値必須 |

## 9. 留意点

- **即時性は最大5分**(ポーラー周期)。不足なら周期短縮を運用判断(cron行の変更のみ)で対応可
- 業務キーは人が意味のある値を付ける(重複禁止が「同じ処理を二度走らせない」保険として機能する条件)。第2段ダイアログに命名例を表示
- allowlistへ載せる=アプリから誰でも(操作要求アプリの追加権限者が)起動できる、という権限線。掲載の追加はVPS上のファイル編集(二次対応者作業)
