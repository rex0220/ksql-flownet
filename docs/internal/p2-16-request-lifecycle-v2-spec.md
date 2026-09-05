# P2-16 操作要求ライフサイクル v2 — CLOSE・処理前取消・終端 hold の解除

- 状態: **FROZEN v1**(2026-09-05。DRAFT v1→v6: Gemini 第1巡・ChatGPT 第1巡・Codex 第1〜3巡を反映 — §11。Codex 第3巡「条件付き可」の 4 条件を v6 で反映し凍結)
- 統合する backlog: P2-10(終端 Run のクローズ)、P2-12(処理前取消)、P2-15(終端 Run に残った hold の解除)
- 前提正本: [統合仕様書](../specification.md) §3.2・§3.4・§6・§7、[P2-01 仕様](./p2-01-app-rerun-spec.md)(G-01〜G-08)、[P2-11 仕様](./p2-11-adhoc-start-spec.md)(I-03・I-04・X-2〜X-6 の引継ぎ論点)
- 位置づけ: v1.0.0 リリース後の次版スコープ。R2 凍結中はコードに触れない(本書は文書のみ)

## 1. 目的と統合の理由

v1.0.0 の操作要求は「起票 → ポーラーが claim → 実行 → DONE/REJECTED」の一方向で、次の 3 つの「行き止まり」が運用上残っている。

| ID | 行き止まり | 現状の回避 |
| --- | --- | --- |
| P2-10 | リランせず決着した FAILED/CANCELLED Run が「終了済み・対応が必要なRun」に永久に残る | 放置(一覧が汚れる) |
| P2-12 | 起票直後〜claim 前(最大 5 分)の要求を取り消せない | 待って REJECTED/DONE を見届ける |
| P2-15 | STOP 後に SQL が失敗すると hold が残り、RERUN も RELEASE もアプリから拒否される | 二次対応者が CLI `cancel-run --release` |

3 件はいずれも**同じ状態機械(操作要求)と同じ 3 層(要求アプリ・ポーラー・ボード)**の改訂であり、G-09(人と機械の書込分離)の例外を切る箇所も重なるため、1 仕様・1 レビューサイクルで扱う。

## 2. 変えないこと(不変条件)

- **I-01** 実行管理・監査履歴は機械専用のまま。人が書くのは操作要求アプリだけ(§8.1)
- **I-02** ボード runtime の書込は「操作要求アプリへの単票 POST」に加え、**本仕様で唯一の例外として `cancel_requested` 1 フィールドの単票 PUT** を許す(§7.7 の改訂)。他フィールドの PUT・DELETE は引き続き行わない
- **I-03**(P2-11 継承)ボードの表示・候補は入力支援であり、可否の正はポーラー
- **I-04**(P2-11 継承)取消と claim の競合は kintone `$revision` の楽観ロックで裁定し、**claim 成立後に取消成功を表示しない**
- **I-05** 状態を書く新 CLI(`archive-run`)は Network ロック取得・revision fencing・監査記録を伴い、既存の運用コマンド(§5.6)と同じ引数規律に従う。証跡は `--reason-file` の理由本文と監査レコードで残し、`--evidence-ref` は要求しない(CLOSE は復旧操作ではなく整理操作のため)
- **I-06** fail-closed: 判定不能なら何もしない。取消の成否が不明なら「処理開始済みの可能性」を表示する

## 3. データモデルの変更

### 3.1 操作要求アプリ(§3.4)

| 変更 | 内容 |
| --- | --- |
| `request_type` 選択肢 | `CLOSE` を追加(RERUN / STOP / RELEASE / START / CLOSE) |
| `request_state` 選択肢 | `CANCELLED` を追加(REQUESTED / ACCEPTED / DONE / REJECTED / CANCELLED)。終端は DONE / REJECTED / CANCELLED |
| `cancel_requested` | **新設・チェックボックス(値 `取消`)**。人が編集できる唯一の機械管理外フィールド。`REQUESTED` の間だけ意味を持つ。**不可逆**: 一度立てた取消の解除(チェック外し)は仕様上不可とする。ボードは解除操作を提供せず、kintone 画面での直接解除は運用違反(変更履歴に残る)。ポーラーは取得時点の値で裁定するため、解除されていれば claim されるが、これは保証された復活手段ではない。復活したい場合は新規起票する |
| フィールドアクセス権 | **機械フィールド 6 種**(`request_state` / `claimed_at` / `claimed_host` / `claim_heartbeat_at` / `result_code` / `result_message`)を kintone のフィールドアクセス権で人には閲覧のみにする(これは kintone 標準で担保できる。**実機確認 2026-09-05**: E2E 要求アプリへ `everyone` 閲覧のみを適用した状態で P2-11 E2E が合格 — API トークン経由のポーラー書込はフィールドアクセス権の影響を受けない)。**入力フィールド**(`request_type` / `run_id` / `network_id` / `business_key` / `scheduled_for` / `rerun_from_node` / `reason`)は「作成時は入力可・起票後は編集不可」を kintone のフィールド権限だけでは作れない(閲覧のみにすると作成画面でも入力不可になる)ため、**起票後の直接編集は運用違反**と定め、ボードは編集経路を持たず、ポーラーは claim 時点のスナップショットで裁定する(既存 §8.4 の「機械フィールドの手動編集は `REQUEST_INVALID`」はそのまま)。プロセス管理(ステータス)による技術的抑止は本仕様では採用しない(X-4 引継ぎの結論) |
| 一覧 | `01_未処理要求` に `cancel_requested` 列を追加。`03_取消済み`(request_state in CANCELLED)を追加する(U-1 決定) |

追補は `templates/add-request-lifecycle-v2.console.js`(新設)で行い、テンプレート(R3 成果物)へも反映する。

### 3.2 実行管理アプリ(§3.2)

変更なし。`lifecycle_status = ARCHIVED` は既存フィールドの既存値で、意味論(ensure-run が resume 拒否・ボードの要対応一覧から除外)は実装済み。

### 3.3 監査履歴アプリ(§3.3)

`OPERATION_AUDIT` に `RUN_ARCHIVED` を追加する。既存の運用監査と同じく **`event_id` を一意キー**にして重複と応答喪失を裁定する(`src/domain/persistence-model.ts` の `OperationAudit` union に型を追加):

| 項目 | 値 |
| --- | --- |
| `event_id` | `archive_<uuid>`(archive-run が起動時に 1 つ採番。再試行でも同じ ID) |
| `event_type` | `RUN_ARCHIVED` |
| `run_id` / `result_code` | 対象 Run / `RUN_ARCHIVED` |
| `reason` JSON | `requested_by`・`reason`・`archived_at`・`previous_status`(`FAILED` / `CANCELLED`)・`run_revision_before` |
| `service_principal` | 既存運用監査と同じ(`KSQL_FLOWNET_SERVICE_PRINCIPAL`) |
| `resolved_at`(物理列) | `archived_at` と同値。既存 serializer は event type ごとに日時欄を選ぶため、`RUN_ARCHIVED` では `archived_at` を `resolved_at` へ格納し、decoder も同じ対応で復元する |

書込応答が失われた場合は同一 `event_id` を再読取し、**`event_id` / `run_id` / `event_type` / `previous_status` / `run_revision_before` が完全一致**すれば成功とみなす(§5.3 部分成功表)。`event_id` が存在するのに他の項目が一致しない場合は `AUDIT_CONFLICT`(Run は ARCHIVED 済み・監査補完要)として fail-closed にする(既存の運用監査は `event_id` 一致だけで同一判定しているため、archive では判定を強める)。

### 3.4 status JSON(§5.5)

`runs[]` に **`hold`** を追加(読み取り専用の追加。既存フィールド不変):

```json
"hold": { "state": "REQUESTED | ACCEPTED", "requested_by": "string", "requested_at": "string" } | null
```

終端 Run でも hold があれば非 null になる。activity の導出規則は変えない(終端は引き続き activity なし)。

- `hold` は **一覧(summary)と詳細(detail)の両方**に必須(null 可)で載せる。両経路とも既に `CANCEL_REQUEST` を取得している(`src/orchestration/status.ts`)ため共通 builder に渡す
- `hold` の値は **`{state: REQUESTED | ACCEPTED, …}` または `null` の 2 択**である。`CANCEL_REQUEST` が `RELEASED` の場合とレコードが無い場合はどちらも `null`(RELEASED を `hold` の値として返さない)。既存キーは不変。cancel state 4 通り(REQUESTED / ACCEPTED / RELEASED / なし)× 終端 / 非終端 × list / detail をスキーマ差分テストで固定する(受入 10)
- ポーラーの **RERUN 一次審査も `hold !== null` を見る**(現行は activity=STOPPED のみで、終端 Run の hold を事前拒否できず ensure-run の `RUN_ON_HOLD` まで進んでいた — G-02 の補強)

## 4. 状態機械(§6.1 改訂)

| 現在状態 | 遷移 | 主体 | 条件 |
| --- | --- | --- | --- |
| `REQUESTED` | `ACCEPTED` | ポーラー | revision 指定の claim PUT 成功(**`cancel_requested` が空のとき**) |
| `REQUESTED` | `CANCELLED` | ポーラー | claim 時点で `cancel_requested` が入っている → claim せず revision 指定で終端化(`result_code = CANCELLED_BY_REQUESTER`) |
| `REQUESTED` | `REJECTED` | ポーラー | 構造・入力検証が不正(従来どおり)。**`cancel_requested` が立っている場合は検証より取消を優先**し `CANCELLED` にする(どちらも実行しないが、起票者の意図を結果に残す)。実装上は、一覧取得時に全レコードから **最小 envelope(`$id`・`$revision`・`request_state`・`cancel_requested`)** を先に読み、取消ありなら完全 validation の前に終端化する(現行は parse 失敗レコードが `InvalidRequestRecord` へ落ちて取消値を持たないため)。`cancel_requested` 自体の型が不正(チェックボックス以外・未知の値)な場合は取消と認めず、従来どおり `REJECTED / REQUEST_INVALID`(fail-closed) |
| `ACCEPTED` | `DONE` / `REJECTED` | ポーラー | 従来どおり。**`ACCEPTED` 以降の `cancel_requested` は無効**(無視し、終端時に `result_message` 末尾へ `(cancel_ignored)` を付記 — §5.1) |

`CANCELLED` は claim 前に人が取り下げた要求であり、実行の有無を問わず**何も実行していない**ことを意味する(STALE と混同しない — STALE は claim 後の結果不明)。

### 4.1 取消と claim の競合裁定(I-04)

| 順序 | 結果 |
| --- | --- |
| 取消 PUT が先に成功 → ポーラーの claim PUT が revision 競合 | ポーラーは再 GET し、`cancel_requested` を見て `CANCELLED` へ終端化 |
| claim PUT が先に成功 → 取消 PUT が revision 競合(409) | ボードは**再 GET して現在状態で判定**する(409 は revision 不一致の事実であり、claim 成立の証明ではない — 取消の二重クリックや他の編集でも起きる) |

409 と通信断の扱い(**成否不明は成功とも失敗とも断定しない**):

| 場面 | 扱い |
| --- | --- |
| 取消 PUT が 409 | 再 GET。`REQUESTED`+`cancel_requested` あり → 「取消受付済み・終端化待ち」。`ACCEPTED` 以降 → 「処理開始済み・取消不可」。`REQUESTED`+取消なし → 再試行を促す |
| 取消 PUT が通信エラー | サーバー側で成立している可能性がある。「取消結果を確認できません。処理開始済みの可能性があります」と表示し再 GET(以後は上と同じ判定) |
| claim PUT が通信エラー | ポーラーは成功を確認できるまで子プロセスを起動しない(従来どおり)。サーバー側で claim が成立していた場合は `ACCEPTED` のまま heartbeat が更新されず、既存の STALE 回収(P2-01 G-05)に乗る |
| 終端化 PUT が通信エラー | §4.2 の次周期再判定に従う(再 GET で `CANCELLED` なら成立済み) |

ボードは取消 PUT を**必ず取得時の `$revision` 付き**で送り、成功時も「取消を受け付けました。次のポーラー周期で CANCELLED になります」と表示する(取消成立を断定しない)。

### 4.2 取消終端化(REQUESTED → CANCELLED)PUT の再試行規則

この節は **REQUESTED → CANCELLED 専用**である(ACCEPTED からの終端は §5.1 の同周期完結規則に従い、本節を参照しない)。

- ポーラーは **1 周期につき 1 要求 1 回**だけ終端化 PUT を試み、revision 競合なら当該要求をその周期では触らない(無限ループなし)
- 次周期の再 GET で `request_state` が `REQUESTED` 以外なら対象外(別経路で終端済み)。`request_state` は機械専用フィールドで人は変更できないため、REQUESTED 以外になり得るのはポーラー自身の書込だけである
- `REQUESTED` かつ `cancel_requested` のままなら再度終端化を試みる。競合のたびに警告ログ(`CANCEL_FINALIZE_CONFLICT`、要求 ID 付き)を出す。`poll-requests` は one-shot で周期をまたぐカウンタを持てないため、「連続 N 周期」の閾値は設けない(監視は cron ログの同一 ID の繰返しで行う)

## 5. 機能仕様

### 5.1 P2-12 処理前取消

**ボード(§7.2 pending 表示)**

- pending 表示(START要求セクション・進行中 Run の pending バッジ)を **要求単位のモデル**に変える: 各 pending 要求について `$id`・`$revision`・`request_type`・`request_state`・`作成者.code`・`reason`・対象(`run_id` または `network_id`+`business_key`)・`cancel_requested` を保持する(現行は `$id`/`run_id`/`request_state` のみを取得し、集約後は最古 ID と件数しか残らない — 取消の対象特定・本人判定・revision 付き PUT のいずれにも足りない)。1 つの Run に複数の pending がある場合は **要求ごとに 1 行**で表示し、各行に取消ボタンを持つ
- `request_state = REQUESTED` かつ **`kintone.getLoginUser().code` が要求の `作成者.code` と一致する**行だけ **「取消」ボタン**を出す(U-4。runtime 型に `getLoginUser` を追加する)。`ACCEPTED` の行には出さない(X-3)。他人の要求は表示のみ
- 押下 → 確認ダイアログ(要求種別・対象・理由を再表示し、**「取消は元に戻せません。再度実行するには新規に起票してください」**を明記)→ `cancel_requested` のみを含む単票 PUT(`$revision` 付き)
- 409・通信エラーは §4.1 の表どおり再 GET して判定する。「取消できませんでした」と断定するのは、再 GET で `REQUESTED` かつ `cancel_requested` が空と確認できた場合だけ
- 取消者の証跡は kintone の**レコード変更履歴**を正とする(更新者欄はポーラーの書き戻しで上書きされる — X-5)

**ポーラー**

- 一覧取得(`listRequested`)時に最小 envelope で `cancel_requested` を読み、立っている要求は valid / invalid を問わず **claim 前に**取得時 revision で `request_state = CANCELLED`・`result_code = CANCELLED_BY_REQUESTER`・`result_message = "requester cancelled before claim"` を PUT する(`rejectInvalid` と同じ「REQUESTED からの直接終端」経路の取消版)。revision 競合なら §4.2(次周期)
- 統計 `cancelled=N` を `poll-requests` の出力行に追加
- `ACCEPTED` 以降で `cancel_requested` が立っていても処理を続行する。**ACCEPTED からの終端は同一周期内で完結**させる(one-shot ポーラーは子プロセスの結果を次周期へ持ち越せない): 終端化の直前に要求レコードを **再 GET 1 回**(store に公開 GET を追加)→ `request_state` が `ACCEPTED` であることを確認 → その時点で `cancel_requested` があれば `result_message` 末尾に `(cancel_ignored)` を付記 → 再 GET の revision で PUT。競合したら現行 `writeResult` と同じく **もう 1 回だけ再 GET→PUT**(終端一致なら成功扱い)。それでも失敗した場合は要求を `ACCEPTED` のまま残し、既存の STALE 回収(heartbeat 停止後 15 分)に委ねる — 結果不明として扱い、実行済みの Run/監査を人が照合する(G-05 と同じ扱い)。実装上の固定事項: 2 回目の失敗は例外を周期全体へ漏らさず、警告ログ(`RESULT_FINALIZE_ABANDONED`、要求 ID 付き)を出して次の要求へ進む。子プロセス終了後に heartbeat を再開しない(再開すると STALE 回収が遅れる)。`DONE` / `REJECTED` 後のフラグ変更は結果へ遡及反映しない

**一次対応(§6.7 追加 code)**: `CANCELLED_BY_REQUESTER` — 起票者が処理前に取り下げた。何も実行されていない。

### 5.2 P2-15 終端 Run に残った hold の解除

**ポーラーの RELEASE 受理条件(§6.3 改訂)**

- 現行「activity = STOPPED」→ **「status JSON の `hold` が非 null(REQUESTED/ACCEPTED)」**へ変更。Run 状態は問わない(RUNNING でも FAILED/CANCELLED でも可)
- `reviewRequest` は現行の「RERUN / STOP / それ以外 = RELEASE」の 3 分岐を **request_type ごとの網羅的 switch** に変える(CLOSE を型に足すだけだと RELEASE 分岐へ落ち、hold なしの closable Run を `RUN_NOT_ON_HOLD` にしてしまう)
- `hold = null` は従来どおり `RUN_NOT_ON_HOLD`
- RELEASE は従来どおり hold 解除のみで Run を再開しない。終端 Run では「解除後にリラン要求を出す」導線をボードが案内する
- `UNKNOWN` Run への RELEASE は API(操作要求アプリへの直接起票)では受理するが、ボードは解除ボタンを出さず「二次対応者へ連絡」のままとする(意図した差 — UNKNOWN は人の裁定が先)

**ボードの操作表示(§7.3 改訂)**

| Run 状態・activity | hold | 表示する操作 |
| --- | --- | --- |
| `FAILED/CANCELLED` | あり | **解除要求**(リラン要求は出さない — RERUN は `RUN_ON_HOLD` で拒否されるため) |
| `FAILED/CANCELLED` | なし | リラン要求(従来どおり、ACTIVE かつ resume 可) |
| `UNKNOWN` | あり/なし | 二次対応者へ連絡(従来どおり)。hold ありは補足表示 |
| `CREATED/RUNNING` + `STOPPED` | あり | 解除要求(従来どおり) |

hold の有無はプラグインが既に読んでいる `CANCEL_REQUEST` レコードから導出する(CLI status を待たない)。ただしこれは**表示のための推測**であり、可否の正はポーラーが参照する status JSON の `hold`(§3.4)である(I-03 の適用)。両者の判定条件は同一(`CANCEL_REQUEST.state` が `REQUESTED` / `ACCEPTED`)とし、乖離が出た場合は status JSON を正として修正する。

**発生源の抑止(任意・案 b)**: ノード失敗で Run が終端したときに hold を `RELEASED`(`release_reason = "run reached terminal status"`)へ自動遷移させる案は、**採用しない**。STOP を出した人の意図(「これ以上動かすな」)を機械が勝手に取り消すことになるため、hold は人が RELEASE で解除する。

### 5.3 P2-10 CLOSE(終端 Run のクローズ)

**要求(§6.3 追加行)**

| 種別 | 受理条件 | 実行内容 | 成功側 code |
| --- | --- | --- | --- |
| `CLOSE` | 下の判定順表のとおり | 新 CLI `archive-run <network.yaml> --run-id <run_id> --reason-file <一時ファイル>` を子プロセス起動 | `RUN_ARCHIVED` |

CLOSE の一次審査(ポーラー)の判定順と code(上から順に評価し、最初に該当した行で裁定する — 順 2 は拒否ではなく DONE/NOOP):

| 順 | 条件 | code |
| --- | --- | --- |
| 1 | Run が allowlist 内で一意に解決できない | `RUN_NOT_FOUND` / `RUN_ID_AMBIGUOUS`(既存) |
| 2 | `lifecycle_status = ARCHIVED` | `RUN_ALREADY_ARCHIVED`(**DONE**・NOOP) |
| 3 | `status = SUCCESS` | `RUN_STATUS_NOT_CLOSABLE` |
| 4 | `status = UNKNOWN` | `RUN_UNKNOWN_NOT_CLOSABLE`(`resolve-node` で解決してから) |
| 5 | `status` が `CREATED` / `RUNNING` | `RUN_NOT_TERMINAL` |
| 6 | `hold !== null` | `RUN_ON_HOLD`(先に RELEASE) |
| 7 | live owner あり(既存 G-02: lock owner が当該 Run の Invocation に属し lease 生存) | `RUN_LIVE` |
| 8 | 上記いずれでもない(`FAILED` / `CANCELLED`・ACTIVE・hold なし・live なし) | 受理 → `archive-run` 起動 |

一次審査で live でなくても、**lease 失効後に残った stale lock は `archive-run` のロック取得を阻む**(既存 `NetworkLockManager.acquire()` は既存レコードが `RUNNING` なら期限を見ずに `LOCK_CONFLICT` を返す)。`archive-run` は stale lock を自動奪取**しない**。この場合は要求が `REJECTED / LOCK_CONFLICT` になり、二次対応者が既存手順(runbook: `status` で stale 候補確認 → `force-unlock-network`)で回収してから再度 CLOSE する。v3 の「stale lock は CLOSE を妨げない」は誤りであり撤回する。

**新 CLI `archive-run`(§5.1・§5.6 追加)**

- 引数: `<network.yaml のパス>`(必須。ポーラーは allowlist の `definition_path` を渡す)、`--run-id`(必須)、`--reason-file`(必須)、`--profile`。**出力は stdout に 1 行 JSON**(run-network `--json` と同じ流儀。stderr 解析より堅牢なため)。`outcome` で判別する discriminated union とし、各 variant の項目・exit code・ポーラーの分類を次の表で固定する(`run_id` と `event_id` は全 variant 必須。`run_revision` はロック取得前・Run 取得前に終了した variant では `null`):

  | `outcome` | 必須項目 | exit | ポーラーの要求 state / code |
  | --- | --- | --- | --- |
  | `ARCHIVED` | `run_revision`(数値)、`audit: RECORDED`、`lock_released: true` | 0 | `DONE / RUN_ARCHIVED` |
  | `ARCHIVED` | `run_revision`、`audit: PENDING`、`lock_released: true`、`code: ARCHIVE_AUDIT_FAILED \| AUDIT_CONFLICT \| LEASE_INTERRUPTED_AFTER_ARCHIVE` | 1 | `DONE / RUN_ARCHIVED_AUDIT_PENDING`(`result_message` に code と `event_id`) |
  | `ARCHIVED` | `run_revision`、`audit: PENDING`、`lock_released: false`、`code`(上と同じ集合) | 1 | `DONE / RUN_ARCHIVED_AUDIT_PENDING`(優先順どおり監査未確定を一次 code とし、`lock_release_failed=true` を `result_message` に併記) |
  | `ARCHIVED` | `run_revision`、`audit: RECORDED`、`lock_released: false` | 1 | `DONE / RUN_ARCHIVED_LOCK_UNRELEASED` |
  | `ALREADY_ARCHIVED` | `run_revision`、`lock_released: true` | 0 | `DONE / RUN_ALREADY_ARCHIVED` |
  | `ALREADY_ARCHIVED` | `run_revision`、`lock_released: false` | 1 | `DONE / RUN_ARCHIVED_LOCK_UNRELEASED`(message に `already_archived=true`) |
  | `UNCONFIRMED` | `run_revision: null`、`code: ARCHIVE_UNCONFIRMED`、`lock_released`(true/false) | 1 | `REJECTED / ARCHIVE_UNCONFIRMED`(Run 状態不明・runbook で `status` 確認。解放失敗は `lock_release_failed=true` 併記) |
  | `REJECTED` | `code` は次の**閉じた集合**: ロック取得前 = `LOCK_CONFLICT` / `LOCK_UNAVAILABLE`(取得の成否を確認できない)、ロック内・Run 不変確認済み = `LEASE_INTERRUPTED` / `RUN_READ_FAILED`(Run 再取得不能) / `RUN_STATUS_NOT_CLOSABLE` / `RUN_UNKNOWN_NOT_CLOSABLE` / `RUN_NOT_TERMINAL` / `RUN_ON_HOLD` / `RUN_LIVE` / `ARCHIVE_WRITE_FAILED`(PUT が明示失敗し、再 GET で `ACTIVE` のままを確認)。`run_revision` は取得済みなら数値、未取得なら `null`。`lock_released` はロック未取得なら `true`、取得後の解放失敗なら `false` | 1 | `REJECTED / <code>`(Run 不変。`lock_released=false` なら `lock_release_failed=true` を併記 — Run は ARCHIVED ではないので `RUN_ARCHIVED_LOCK_UNRELEASED` は使わない) |

  「Run 不変が確認できた失敗」は `REJECTED` の閉じた集合へ、「Run 状態を確認できない失敗」は `UNCONFIRMED` へ割り当てる(例: PUT 応答喪失後の再 GET 失敗、明示失敗後の再 GET 失敗、再 GET で ACTIVE 確認後の再 PUT 失敗+再々 GET 失敗はすべて `UNCONFIRMED`)。複合障害の code 優先順(1 つの要求に 1 つの code): **Run 状態不明(`ARCHIVE_UNCONFIRMED`) > 監査未確定(`RUN_ARCHIVED_AUDIT_PENDING`) > ロック未解放(`RUN_ARCHIVED_LOCK_UNRELEASED`)**。下位の事象は `result_message` に併記する。exit code と `outcome` の組合せが上表に無い、`code` が集合外、stdout/stderr の打ち切り、spawn 失敗、JSON 不正はすべて `CHILD_RESULT_INVALID`(REJECTED・fail-closed。Run は ARCHIVED 済みの可能性があるため message で `status` 確認を促す)
- 実装前提: repository に **`lifecycle_status` 専用の revision-fenced 更新メソッド**を追加する(現行の集約更新は `status`・時刻だけを PUT し lifecycle を書く surface がない)。監査 union に §3.3 の `RunArchivedOperationAudit` を追加する。ポーラーの子プロセス client に `archiveRun()` と専用 classifier を追加する
- 処理順(**排他契約**):
  1. `event_id = archive_<uuid>` を採番し、**Network ロックを取得する**(run-network と同じ lease 機構。owner は `archive_<uuid>`、lease は定義の `network_lock` 値)。取得できなければ `LOCK_CONFLICT` で終了 — これにより **RERUN / resume / START の Invocation と CLOSE は同じ profile・network で直列化**され、「CLOSE が確認した後に別 Invocation がノード実行を開始し、その後 ARCHIVED が書かれる」順序は成立しない(Run レコードの revision だけでは防げない: 失敗 Run の resume は `started_at` が非 null のためノード開始まで Run レコードを書かない)。同時に 2 つの CLOSE が走った場合、**後着はロック取得で `LOCK_CONFLICT`** になる(Run の revision 競合まで進まない)
  2. run-network と同じ **`LeaseMonitor` を開始**し(monitor は lock manager と lock reference だけで動作し Invocation を必要としない)、以後の各書込(手順 4・5)の直前に `tick()`(heartbeat と lease token の fence)が成功していることを確認する。lease を再更新できない・強制解放されていた場合は書込を行わず中止する。**中止の時点で意味が変わる**: 手順 4 の前なら Run 不変で `REJECTED / LEASE_INTERRUPTED`、手順 4 成功後・手順 5 前なら Run は既に ARCHIVED なので `ARCHIVED` + `audit: PENDING` + `code: LEASE_INTERRUPTED_AFTER_ARCHIVE`(要求は `DONE / RUN_ARCHIVED_AUDIT_PENDING`)
  3. ロック内で Run を再取得し、受理条件(`FAILED` / `CANCELLED`・`ACTIVE`・hold なし)を再検証する(fail-closed)。既に ARCHIVED なら `ALREADY_ARCHIVED` で終了
  4. `lifecycle_status = ARCHIVED` を **revision fencing 付き** PUT
  5. `OPERATION_AUDIT / RUN_ARCHIVED`(`event_id` 固定)を記録
  6. Network ロックを解放(tombstone)。**手順 1 のロック取得に成功した後の全経路**(手順 2 の lease 中断、手順 3 の再検証拒否・`ALREADY_ARCHIVED`、手順 4/5 の失敗を含む)を `try/finally` で囲み、`monitor.stop()` の後に解放を必ず試みる(既存 scheduler と同じ順序)
- **部分成功の裁定**(手順 4〜6 の応答喪失・失敗):

  | 障害 | 裁定 |
  | --- | --- |
  | 手順 4 の PUT 応答喪失 | Run を再 GET。`ARCHIVED` なら成功として手順 5 へ、`ACTIVE` のままなら PUT を 1 回再試行(revision は再 GET 値)。再 GET・再試行とも失敗すれば `outcome = UNCONFIRMED`・`code = ARCHIVE_UNCONFIRMED`(Run 状態不明。ポーラーは `REJECTED / ARCHIVE_UNCONFIRMED`、runbook で `status` 確認) |
  | 手順 4 の PUT が明示 409(revision 不一致) | Run を再 GET。`ARCHIVED` なら `ALREADY_ARCHIVED`、それ以外(ロック内で Run が更新されることは無いはず)は `UNCONFIRMED` |
  | 手順 4 の PUT が明示失敗(409 以外の API エラー) | Run を再 GET。`ACTIVE` のままなら `REJECTED / ARCHIVE_WRITE_FAILED`(Run 不変)、`ARCHIVED` なら成功として手順 5 へ、再 GET 失敗なら `UNCONFIRMED` |
  | 応答喪失 → 再 GET で `ACTIVE` 確認 → 再 PUT も失敗 | もう一度再 GET。`ACTIVE` なら `ARCHIVE_WRITE_FAILED`、`ARCHIVED` なら続行、GET 失敗なら `UNCONFIRMED`(再試行はここまで) |
  | 手順 1 のロック取得の成否不明(`LOCK_UNAVAILABLE`) | `REJECTED / LOCK_UNAVAILABLE`。Run 不変。ロックが実は取れていた場合は lease 失効で stale になる(既存の回収手順) |
  | 手順 3 の Run 再取得不能 | `REJECTED / RUN_READ_FAILED`。Run 不変・ロック解放 |
  | 手順 5 の監査 PUT 応答喪失 | 同一 `event_id` を再読取し §3.3 の完全一致で照合。一致すれば `audit = RECORDED`、無ければ 1 回再試行、再失敗なら `audit = PENDING`。不一致なら `audit = PENDING`・`code = AUDIT_CONFLICT` |
  | 手順 5 が明示失敗 | `outcome = ARCHIVED`・`audit = PENDING`・`code = ARCHIVE_AUDIT_FAILED`・exit 1。ポーラーは **`DONE / RUN_ARCHIVED_AUDIT_PENDING`**(Run は ARCHIVED 済み・監査補完が必要)とし、`result_message` に `event_id` と補完手順(runbook 参照)を書く。手動補完の前に同一 `event_id` の監査が既に無いことを確認する |
  | 手順 6 のロック解放失敗(応答喪失・fence 不一致を含む) | `lock_released = false`・exit 1。Run と監査が成立済みなら要求は `DONE / RUN_ARCHIVED_LOCK_UNRELEASED`。`ALREADY_ARCHIVED` は同 code(message に `already_archived=true`)。`REJECTED` / `UNCONFIRMED` の経路で解放に失敗した場合は一次 code を変えず `lock_release_failed=true` を `result_message` に併記する(Run は ARCHIVED でないため archived を断定する code を使わない)。いずれも stale lock として既存の `force-unlock-network` 手順で回収する(runbook に追記) |
  | 複合(例: `audit = PENDING` かつ `lock_released = false`) | 上記 JSON 表の優先順(状態不明 > 監査未確定 > ロック未解放)で code を 1 つに決め、残りは `result_message` に併記 |

  「Run が既に ARCHIVED の別障害」を `REJECTED` に誤分類しないよう、ポーラーの分類は JSON 表の `outcome` / `audit` / `lock_released` / `code` の組合せで行い、stderr の文字列に依存しない
- **hold との競合**: 終端 Run への STOP は CLI(`cancel-run`)も `RUN_ALREADY_TERMINAL` で拒否するため、「CLOSE が確認した後に hold が作られる」のは次の三者順序に限られる: STOP が Run(非終端)を読む → Run がノード失敗で終端化 → CLOSE が hold なしを確認 → STOP が hold を作成 → CLOSE が ARCHIVED を書く。結果は「ARCHIVED かつ hold あり」だが、ARCHIVED は resume されず、hold は RELEASE で解除できる(§5.2 は Run 状態を問わない)ため無害。受入 8c はこの順序を repository 注入で再現する単体試験とする
- **既に ARCHIVED の Run への CLOSE**: 何もせず `DONE / RUN_ALREADY_ARCHIVED`(望む状態に既にあるため NOOP 扱い。START の `NOOP_ALREADY_SUCCESS` と同じ考え方)。**同時 CLOSE の結果は観測点で 2 通り**あり、どちらも正しい: (a) 両 `archive-run` のロック取得が重なった場合、敗者は `REJECTED / LOCK_CONFLICT`(ロック解放後に再要求すれば `RUN_ALREADY_ARCHIVED`)。(b) 後件の一次審査(§5.3 判定順 2)が先行の ARCHIVED 書込後に status を読んだ場合、child を起動せず `DONE / RUN_ALREADY_ARCHIVED`(同一ポーラー周期に並んだ 2 要求は逐次処理のため通常こちら)
- `requested_by` は `KSQL_FLOWNET_REQUESTED_BY`(ポーラー経由なら `app-request:<id>:<creator>`)
- **逆操作(unarchive)は提供しない**。誤クローズは新しい業務キー(補正キー)で再実行する — ARCHIVED を戻す経路を作らないことで「終端の最終性」を保つ

**ボード**: `FAILED/CANCELLED`(hold なし)の操作に **「クローズ要求」** を追加(リラン要求の隣・二次確認ダイアログに「以後この Run は再開できません」を明記)。ARCHIVED になった Run は要対応一覧から消える(既存フィルタ)。

**一次対応(§6.7 追加 code)** — DONE 系: `RUN_ARCHIVED` / `RUN_ARCHIVED_AUDIT_PENDING`(監査補完要。message の code が `ARCHIVE_AUDIT_FAILED` / `AUDIT_CONFLICT` / `LEASE_INTERRUPTED_AFTER_ARCHIVE` のいずれか。`lock_release_failed=true` 併記あり得る) / `RUN_ARCHIVED_LOCK_UNRELEASED`(ロック回収要) / `RUN_ALREADY_ARCHIVED`(NOOP)。REJECTED 系(Run 不変): `RUN_STATUS_NOT_CLOSABLE` / `RUN_UNKNOWN_NOT_CLOSABLE` / `RUN_NOT_TERMINAL` / `RUN_ON_HOLD`(CLOSE でも hold は拒否理由) / `RUN_LIVE` / `LOCK_CONFLICT`(別 Invocation 実行中、または stale lock 残留 — runbook で回収) / `LOCK_UNAVAILABLE`(取得成否不明) / `LEASE_INTERRUPTED` / `RUN_READ_FAILED` / `ARCHIVE_WRITE_FAILED`。REJECTED 系(Run 状態不明): `ARCHIVE_UNCONFIRMED`(runbook で `status` 確認) / `CHILD_RESULT_INVALID`(既存・出力不正)。

## 6. ボード runtime の API 境界(§7.7 改訂)

| 対象 | 許可する runtime 操作 |
| --- | --- |
| 操作要求 | レコード GET、単票 POST、**`cancel_requested` のみの単票 PUT(`$revision` 必須)** |
| 他 | 変更なし |

PUT はこの 1 フィールド以外を含めてはならない(runtime 側で payload を固定)。wire 形を固定する:

```json
{ "app": <要求アプリID>, "id": "<レコードID>", "revision": "<取得時の $revision>", "record": { "cancel_requested": { "value": ["取消"] } } }
```

- 取得時のフィールド名は `$revision` だが、更新 body のキーは `revision` である(kintone API 仕様)。チェックボックス値は文字列ではなく配列 `["取消"]`
- runtime には汎用の update API を公開せず、この body を組み立てる**固定 builder 1 つ**だけを追加する。解除値 `[]` を送る経路は作らない(§3.1 の不可逆性)
- `tests/unit/activity-plugin-request.test.mjs` の境界テストで body の完全一致・単票・1 フィールド・revision 必須を固定する

## 7. 受入基準(実機 E2E・単体)

受入は実施マイルストーン(M)を 1 つ持つ。ボードに依存する観点は M4 で実施し、M3 は CLI・ポーラー・API の観点に限定する。

| # | 内容 | 層 | M |
| --- | --- | --- | --- |
| 1 | REQUESTED 要求に取消(要求アプリ直接編集で `cancel_requested` を立てる)→ 次周期で `CANCELLED / CANCELLED_BY_REQUESTER`、子プロセス未起動、Run/監査無変更 | E2E | M3 |
| 2 | 取消 PUT と claim の競合(API 直接): 取消先勝ち → CANCELLED、claim 先勝ち → 要求は正常系なら ACCEPTED→DONE(実行結果により REJECTED にもなり得る) | E2E(**fault-hook の拡張が前提** — §8 M0) | M3 |
| 2a | 2 の claim 先勝ちで、ボードが再 GET し「処理開始済み」を表示する | 単体(fetch 応答注入) | M4 |
| 2b | 取消 PUT の通信断: サーバー側成立/不成立の両方で、ボードが再 GET の結果どおりの文言を出す | 単体(fetch 失敗を注入) | M4 |
| 3 | ACCEPTED 以降の取消は無効、結果に `(cancel_ignored)` | 単体 | M2 |
| 4 | STOP → 実行中 SQL 失敗 → Run FAILED + hold: `status --json` の `hold` が非 null。RELEASE 要求(API 直接起票)が `DONE / RELEASED`。その後 RERUN 要求が通る | E2E | M3 |
| 4a | 4 の状態でボードが「解除要求」を表示し「リラン要求」を出さない | 単体(render/controller) | M4 |
| 4b | 終端化直前の再 GET: ACCEPTED 後に立てた `cancel_requested` が `(cancel_ignored)` として付記され、終端後の変更は反映されない。再 GET→PUT が 2 回とも競合した場合は ACCEPTED のまま残り(警告ログ・heartbeat 再開なし)STALE 回収に乗る | 単体 | M2 |
| 5 | hold なし終端 Run への RELEASE は `RUN_NOT_ON_HOLD`(従来維持)。hold あり Run への RERUN は一次審査で `RUN_ON_HOLD` | 単体 | M2 |
| 6 | FAILED Run へ CLOSE(API 直接起票)→ `DONE / RUN_ARCHIVED`、`lifecycle_status = ARCHIVED`、`OPERATION_AUDIT` 1 件(§3.3 の全項目一致)、`--resume-run` が `RUN_NOT_RESUMABLE`、ロック解放済み | E2E | M3 |
| 6a | 6 の後にボード要対応一覧から消え、クローズ要求ボタンが FAILED/CANCELLED(hold なし)にだけ出る | 単体(既存 loader フィルタ+render) | M4 |
| 7 | SUCCESS / UNKNOWN / hold あり / LIVE / CREATED・RUNNING の Run への CLOSE はそれぞれ §5.3 判定順の code で拒否・状態不変 | E2E | M3 |
| 8 | 同時 CLOSE(観測点別に 2 通り): (a) 両 child のロック取得が重なった敗者は `REJECTED / LOCK_CONFLICT`、解放後の再 CLOSE は `RUN_ALREADY_ARCHIVED`。(b) 後件の一次審査が ARCHIVED を観測した場合は child 未起動で `DONE / RUN_ALREADY_ARCHIVED` | 単体(lock manager 注入 / status 注入) | M2 |
| 8b | CLOSE と RERUN の競合: run-network が Network ロック保持中は CLOSE が `LOCK_CONFLICT`。CLOSE 完了後の run-network は `RUN_NOT_RESUMABLE`。**ARCHIVED の Run でノード実行が開始されない** | E2E(長時間 SQL fixture+拡張 fault-hook。barrier は**ロック取得後にのみ発生する heartbeat PUT または node-start 書込**を `after-success` phase で捕捉し、取得成功をログで固定してから CLOSE を発火) | M3 |
| 8c | CLOSE と hold 作成の三者順序(STOP が非終端 Run を読む → Run が終端化 → CLOSE が hold なしを確認 → STOP が hold 作成 → CLOSE が ARCHIVED 書込): 結果は ARCHIVED+hold。RELEASE で hold が解除でき、resume は拒否される | 単体(repository 注入で順序固定) | M2 |
| 8d | 監査失敗の結果契約: 手順 5 を失敗させ、JSON が `ARCHIVED`+`PENDING`+`ARCHIVE_AUDIT_FAILED`、要求が `DONE / RUN_ARCHIVED_AUDIT_PENDING`、Run は ARCHIVED、ロックは解放済み | 単体(監査 repository を失敗注入) | M2 |
| 8e | 終端 Run への CLI `cancel-run`(STOP)は `RUN_ALREADY_TERMINAL` | 単体(既存挙動の固定) | M2 |
| 8f | 部分成功の裁定(時点別): ①手順 4 前の lease 中断 → `REJECTED / LEASE_INTERRUPTED`・Run 不変・ロック解放済み ②手順 4 後の lease 中断 → `DONE / RUN_ARCHIVED_AUDIT_PENDING`(`LEASE_INTERRUPTED_AFTER_ARCHIVE`) ③Run PUT 応答喪失 → 再 GET で ARCHIVED なら続行、再 GET も失敗なら `REJECTED / ARCHIVE_UNCONFIRMED` ④監査応答喪失 → 完全一致再読取で RECORDED、項目不一致は `AUDIT_CONFLICT` ⑤ロック解放失敗 → `RUN_ARCHIVED_LOCK_UNRELEASED` ⑥複合(監査 PENDING+解放失敗)→ 優先順どおり `RUN_ARCHIVED_AUDIT_PENDING` に解放失敗を併記 ⑦手順 3 の拒否・`ALREADY_ARCHIVED` 経路でもロックが解放される | 単体 | M2 |
| 8g | JSON 契約: 各 `outcome` variant の必須項目・exit code の組合せを網羅し、表に無い組合せ・打ち切り・spawn 失敗は `CHILD_RESULT_INVALID` | 単体(classifier) | M2 |
| 11 | 取消と入力不正が同時: `CANCELLED` が優先され `REJECTED` にならない(最小 envelope 経由)。`cancel_requested` が `["取消"]` は取消、`[]` は未取消、それ以外は `REQUEST_INVALID` | 単体 | M2 |
| 12 | 取消済み要求の扱い(ハーネス): E2E decoder と terminal 集合が `CANCELLED` を終端として待機でき、受入 1 の CANCELLED を検出できる(実装は M0、確認は M3) | E2E | M3 |
| 12a | 取消済み要求の扱い(ボード): START 要求実績(DONE 履歴)に `CANCELLED` を含めず、`03_取消済み` 一覧を正とする | 単体(request-client の履歴 query/model) | M4 |
| 9 | フィールドアクセス権: 機械フィールド 6 種が一般ユーザーに閲覧のみで、`cancel_requested` は作成者が編集できる(テンプレート検証)。ボードの取消ボタンが作成者以外に出ない。他人による直接 PUT の結果(拒否/受理)を記録 | 実機・手動 | M4 |
| 10 | `status --json` の `hold` が終端 Run でも list/detail の両方で返る。cancel state が REQUESTED/ACCEPTED では非 null、RELEASED/レコードなしでは `null`。既存キーは不変(スキーマ差分テスト) | 単体 | M1 |

## 8. マイルストーン

| M | 内容 |
| --- | --- |
| M0 | 本仕様の外部レビュー(3 系統)→ FROZEN。テンプレート追補スクリプト・E2E 要求アプリへの適用(作成者へのフィールド権限の実機確認 — U-4)。**E2E ハーネスの拡張**: fault-hook に path/method/body 条件の対象指定と barrier(`phase = before | after-success` を持ち、到達ログに response status と phase を残し、外部 release で継続)を追加、`p2-01-support.mjs` / `p2-11-support.mjs` の decoder と terminal 集合に `cancel_requested` / `CANCELLED` を追加 |
| M1 | 契約層: request-model(`CLOSE`・`CANCELLED`・`cancel_requested` の配列 parser・最小 envelope)、status JSON `hold`(list/detail)、repository の lifecycle 専用更新、監査 `RunArchivedOperationAudit`、`archive-run` CLI(LeaseMonitor・JSON 出力・部分成功裁定) |
| M2 | ポーラー: 最小 envelope の取消終端化、ACCEPTED 終端の同周期完結、`reviewRequest` の網羅 switch(RERUN の hold 判定・RELEASE・CLOSE 判定順)、`archiveRun()` client と classifier。単体 S 系 |
| M3 | 実機 E2E(M3 印の受入: 1・2・4・6・7・8b・12)。CLI・ポーラー・API 直接起票のみで、ボードは使わない。P2-01/P2-11 の回帰 |
| M4 | ボード: 要求単位 pending・取消ボタン・解除/クローズ表示・`cancel_requested` PUT。単体(2a・2b・4a・6a・12a)+E2E UI ドライバ+受入 9 |
| M5 | 文書と本番適用。改訂対象: 統合仕様書(§6.1 に `CANCELLED` 遷移、§6.3 に CLOSE、§6.7 に追加 code、§7.3/§7.4、§7.7 に限定 PUT、§5.5 に `hold`)、**P2-01 仕様(G-02 の hold 判定を status `hold` へ、G-06 の一次審査を activity から `CANCEL_REQUEST` へ、G-04/G-07 に CLOSE JSON の DONE 例外を追記、状態機械に `CANCELLED`)**、一次対応 1 ページ、復旧 runbook(stale lock・監査補完・ロック未解放の手順)、templates/README。本番適用(要求アプリ追補 → プラグイン → VPS → smoke) |

## 9. 決定事項(旧・未決事項)

| ID | 論点 | 決定(2026-09-05・Gemini 推奨を採用) |
| --- | --- | --- |
| U-1 | `03_取消済み` 一覧 | **作る**。「起票した要求が消えた」問合せに即答できる場所が要る。ビュー追加は低コスト |
| U-2 | CLOSE を SUCCESS Run にも許すか | **許さない**。要対応一覧に出ないため需要がなく、誤 ARCHIVED のリスクだけが残る |
| U-3 | `archive-run` の二次対応者による直接利用 | **可**。既存運用コマンドと同じ規律(revision fencing・監査・`--reason-file`)を満たす |
| U-4 | 取消ボタンの表示権限 | **起票者本人のみ**にボードが表示し、API 側は kintone のフィールド権限で二重に弾く。フィールドアクセス権の対象に「作成者」を指定できるかは M0 のテンプレート追補時に実機で確認し、可能なら「作成者=編集可・他=閲覧のみ」、不可なら「アプリ利用者全員=編集可(ボードの表示制御のみ)」へ落とす。他人による直接 PUT の拒否(または受理)を受入 9 で明記する。運用グループへの拡張は必要になった時点で |

## 10. 凍結条件と凍結の記録

外部レビュー 3 系統で「実装不能」「不変条件違反」「受入の矛盾」の指摘がゼロになった時点で FROZEN とする。

**2026-09-05 FROZEN v1**: Gemini 第1巡(6 件)・ChatGPT 第1巡(4 件+軽微 5・1 件はユーザー判断で対象外)・Codex 第1巡(16 件・不可)→第2巡(残 4+新規 8・不可)→第3巡(条件付き可・条件 4 件)を経て、第3巡の 4 条件(JSON 表の `audit PENDING`+解放失敗の一次 code 統一、outcome 集合の閉包と `REJECTED` code の列挙、受入 12 の M3/M4 分割、監査物理列 `resolved_at = archived_at`)を v6 で反映し凍結。以後の変更は本書の改訂として §11 に記録し、実装は M1 から着手する(R2 凍結の解除後)。

## 11. 改訂履歴と外部レビューの採否

### v2(2026-09-05)— Gemini 第1巡

| # | 指摘 | 採否 | 反映 |
| --- | --- | --- | --- |
| 1-① | `cancel_requested` の再トグル(解除・再チェック)の扱い | 採用 | §3.1 で**不可逆**を明記(ボードに解除操作なし、直接解除は運用違反、復活は新規起票)。§5.1 の確認ダイアログに文言追加 |
| 1-② | CANCELLED 終端化 PUT の競合再試行と無限ループ | 採用 | §4.2 を新設: 1 周期 1 回、REQUESTED 以外は対象外、3 周期連続競合で警告 |
| 1-③ | CLOSE の live owner 判定(stale lock でのデッドロック) | 採用(v4 で訂正) | §5.3 で既存 G-02(lease 生存+60秒余裕)と同一と明記。**「stale lock は妨げない」は v4 で撤回** — 一次審査は通るが `archive-run` のロック取得が `LOCK_CONFLICT` になるため、`force-unlock-network` で回収してから再 CLOSE(Codex #1) |
| 2-① | ボードの hold 導出と status JSON `hold` の乖離 | 採用 | §5.2 に「表示は推測、正は status JSON(I-03)」を注記。判定条件を同一に固定 |
| 2-② | kintone フィールドアクセス権で「作成時入力可・起票後編集不可」は作れない | 採用(前提を修正) | §3.1 を「機械フィールドのみ権限で閲覧専用。入力フィールドの起票後編集は運用違反+claim 時スナップショット裁定」へ。プロセス管理は不採用 |
| 3 | U-1〜U-4 の推奨判断 | 採用 | §9 を決定事項へ |

### v3(2026-09-05)— ChatGPT 第1巡(指摘 3「旧ポーラー混在」はユーザー判断で対象外・撤回済み)

| # | 指摘 | 採否 | 反映 |
| --- | --- | --- | --- |
| 1 | 通信断を「双方とも何もしない」と扱えない。409 は claim 成立の証明ではない | 採用 | §4.1 に 409/通信断の判定表(再 GET で判定・成否不明は断定しない・claim 通信断は既存 STALE へ)。§5.1 の「取消できませんでした」を再 GET 確認後に限定 |
| 2 | CLOSE の revision fencing は別レコード(Network lock・hold)の変更を検出しない | 採用(排他契約を追加) | **実装確認**: 失敗 Run の resume は `started_at` 非 null のため Run レコードをノード開始まで書かず、Run の revision だけでは順序を排除できない。`archive-run` に **Network ロック取得**を義務付け(§5.3 手順 1)、run-network と直列化。hold との競合は無害と定義。受入 8b/8c 追加 |
| 3 | 旧ポーラー混在の導入手順 | 対象外 | ユーザー判断で撤回。凍結条件に含めない |
| 4 | ARCHIVED 後の監査失敗を操作要求でどう表すか未定義 | 採用 | `ARCHIVE_AUDIT_FAILED`(stderr)→ 要求 `DONE / RUN_ARCHIVED_AUDIT_PENDING`。再 CLOSE は `DONE / RUN_ALREADY_ARCHIVED`(NOOP)。補完前の既存監査確認を明記。受入 8d |
| 5 | claim 後の取消を付記する再読取時点がない | 採用 | §5.1 に「終端化直前に再 GET・その revision で PUT・終端後は遡及しない」。表記を `(cancel_ignored)` に統一。受入 4b |
| 軽微 | 作成者へのフィールド権限 | 採用(要実機確認) | U-4 に M0 での確認と代替案を記載 |
| 軽微 | 不正入力と取消の同時発生 | 採用 | §4 で取消優先(`CANCELLED`)。受入 11 |
| 軽微 | UNKNOWN への RELEASE の UI/API 差 | 採用 | §5.2 に意図した差と明記 |
| 軽微 | I-05 の `--evidence-ref` | 採用 | I-05 を「理由ファイル+監査で証跡、evidence-ref は要求しない」へ |
| 軽微 | 受入 2 の正常系前提 | 採用 | 受入 2 を修正 |

### v4(2026-09-05)— Codex 第1巡([レビュー全文](./p2-16-review-codex-20260905.md)・判定 FROZEN 不可)

16 件すべて採用。実装を突き合わせ、v3 の誤り 2 点(stale lock・同時 CLOSE の裁定)と実装不能 2 点(不正レコードの取消優先・ACCEPTED 終端の次周期送り)を修正した。

| # | 指摘 | 採否 | 反映 |
| --- | --- | --- | --- |
| 1 | 既存 `acquire()` は既存 lock が RUNNING なら期限を見ず `LOCK_CONFLICT`。stale lock は CLOSE を阻む | 採用(v3 の誤りを訂正) | §5.3 判定順表の後に「stale lock は自動奪取しない・`REJECTED / LOCK_CONFLICT`・force-unlock 後に再 CLOSE」を明記。Gemini 1-③ の行も訂正 |
| 2 | owner を変えるだけでは lease 機構を満たさない(heartbeat・書込前 fence・失効時中止) | 採用 | §5.3 手順 2 に `LeaseMonitor` 開始と各書込前 `tick()`、`LEASE_INTERRUPTED` を追加 |
| 3 | 同時 CLOSE の後着は revision 競合でなく `LOCK_CONFLICT` | 採用 | §5.3・受入 8 を修正 |
| 4 | 終端 Run への CLI STOP は `RUN_ALREADY_TERMINAL` で hold を作れず、受入 8c は再現不能 | 採用 | §5.3 の hold 競合を三者順序に書き直し、受入 8c を repository 注入の単体へ、8e を追加 |
| 5 | parse 失敗レコードは `InvalidRequestRecord` へ落ち取消値を持たない | 採用 | §4 に最小 envelope(`$id`/`$revision`/`request_state`/`cancel_requested`)による取消優先と、型不正時の fail-closed を追加。§5.1 ポーラー節を修正 |
| 6 | one-shot ポーラーは「連続 3 周期」を数えられない | 採用 | §4.2 を「競合のたびに警告(要求 ID 付き)・閾値なし」へ |
| 7 | ACCEPTED 終端 PUT の「次周期送り」は実装不能(child 結果を持ち越せない)。現行 `writeResult` は即時再 GET→再 PUT | 採用 | §5.1 を「同周期完結: 再 GET 1 回→ACCEPTED 確認→付記→PUT、競合時もう 1 回、失敗なら ACCEPTED のまま STALE 回収へ」に変更。§4.2 を REQUESTED→CANCELLED 専用と明記 |
| 8 | Run PUT 応答喪失・監査応答喪失・ロック解放失敗の裁定が未定義。lifecycle 更新 surface と監査型が無い | 採用 | §5.3 に部分成功表(4 障害)、実装前提(lifecycle 専用更新メソッド・監査 union 追加・`archiveRun()` client)、`finally` でのロック解放を追加。code に `ARCHIVE_UNCONFIRMED` / `RUN_ARCHIVED_LOCK_UNRELEASED` / `LEASE_INTERRUPTED` |
| 9 | 監査 JSON の識別方式(`event_id`)が未定義 | 採用 | §3.3 を `event_id = archive_<uuid>` 固定の型定義へ。応答喪失時は同一 event_id 再読取で成功扱い |
| 10 | `hold` は list/detail 両方に必要。差分テスト。RERUN も hold を見るべき(G-02) | 採用 | §3.4 に list/detail 必須・差分テスト・RERUN 一次審査の hold 判定を追加。受入 10 を拡張 |
| 11 | pending モデルに creatorCode/revision/種別/理由が無く、runtime に `getLoginUser` が無い。複数 pending の UI 単位 | 採用 | §5.1 ボード節を要求単位モデル(必要フィールド列挙)+ `getLoginUser().code` 比較+要求ごとに 1 行・各行に取消ボタン、へ変更 |
| 12 | PUT の wire 形(`revision` キー・チェックボックスは配列)が未固定 | 採用 | §6 に body を固定・固定 builder のみ・解除値禁止・境界テストを明記 |
| 13 | stderr code 判定は脆い(64 KiB 打ち切り・classifier 不在) | 採用(JSON 出力へ変更) | `archive-run` の出力を stdout 1 行 JSON(`outcome`/`audit`/`lock_released`/`code`/`event_id`)へ。`CHILD_RESULT_INVALID` 規則を流用。v1 の「`--json` は実装しない」を撤回 |
| 14 | fault-hook は全遮断のみで受入 2/8b の順序固定ができない | 採用 | M0 に hook 拡張(対象指定+barrier)を追加。受入 2/8b の前提に明記 |
| 15 | E2E decoder・terminal 集合・START 履歴が `CANCELLED` を扱わない | 採用 | M0 に decoder/terminal 集合の更新、受入 12 で「START 実績履歴に CANCELLED を含めず `03_取消済み` を正」と決定 |
| 16 | `reviewRequest` は 3 分岐で CLOSE が RELEASE へ落ちる。CLOSE 判定順が未定義 | 採用 | §5.2 に網羅 switch、§5.3 に CLOSE 判定順表(8 段・code 優先順) |

### v5(2026-09-05)— Codex 第2巡([レビュー全文](./p2-16-review-codex-20260905-r2.md)・判定 FROZEN 不可。第1巡 16 件: 解消 11・部分 4・新矛盾 1)

残件と新規 8 件をすべて採用。実装上の新発見はなく、いずれも仕様文の一意化。

| # | 指摘 | 採否 | 反映 |
| --- | --- | --- | --- |
| #2 残 | ロック取得後の早期終了で解放が保証されない。手順 4 後の lease 中断は Run 不変にならない | 採用 | §5.3 手順 6 を「取得成功後の全経路を try/finally・`monitor.stop()` 後に解放」へ。手順 2 に時点別の意味(4 前=`REJECTED/LEASE_INTERRUPTED`、4 後=`DONE/RUN_ARCHIVED_AUDIT_PENDING`+`LEASE_INTERRUPTED_AFTER_ARCHIVE`) |
| #3 残 / R2-2 | 同時 CLOSE は一次審査で `RUN_ALREADY_ARCHIVED` にもなる(逐次処理) | 採用 | §5.3・受入 8 を観測点別の 2 通り(ロック競合 / 一次審査で ARCHIVED 観測)へ |
| #8 残 / R2-3 | 複合障害の code 優先順・JSON の cross-field 契約・`run_revision` の null 可否 | 採用 | §5.3 の JSON を `outcome` 別 discriminated union 表(必須項目・exit・要求 state/code)へ。優先順「状態不明 > 監査未確定 > ロック未解放」。部分成功表に 409・複合行を追加。受入 8g |
| #13 残 | exit 1 の正常意味(ALREADY/PENDING/UNRELEASED)の固定 | 採用 | 同上の表で固定 |
| #10 新矛盾 / R2-4 | 受入 10 が `RELEASED` を `hold` の値として要求 | 採用 | §3.4 に「`hold` は REQUESTED/ACCEPTED か null の 2 択。RELEASED・レコードなしは null」、受入 10 を修正 |
| #7 補足 | 2 回目失敗の扱い・heartbeat 非再開 | 採用 | §5.1 に `RESULT_FINALIZE_ABANDONED` 警告と heartbeat 非再開を明記。受入 4b |
| #9 補足 / R2-6 | 監査再読取の一致条件が「存在」と「一致」で揺れる | 採用 | §3.3 を 5 項目完全一致・不一致は `AUDIT_CONFLICT` へ。部分成功表も同じ条件に |
| #16 補足 | 判定順表の「拒否」表現 | 採用 | 「裁定(順 2 は DONE/NOOP)」へ |
| R2-1 | (#2 残と同じ) | 採用 | 受入 8f を 7 時点へ分割 |
| R2-5 | M3 の受入にボード依存が混在 | 採用 | 受入表に M 列を追加。ボード観点を 2a/4a/6a に分離して M4 へ。M3 は CLI・ポーラー・API のみ |
| R2-7 | barrier の停止位置が未定義 | 採用 | M0 に `phase = before \| after-success` と response status ログ。受入 8b はロック取得後にのみ起きる heartbeat/node-start 書込を after-success で捕捉 |
| R2-8 | P2-01 仕様の改訂が M5 に無い | 採用 | M5 に P2-01(G-02/G-04/G-06/G-07・状態機械)と統合仕様書の改訂箇所を列挙 |

### v6 → FROZEN v1(2026-09-05)— Codex 第3巡([レビュー全文](./p2-16-review-codex-20260905-r3.md)・判定 条件付き可。第2巡残件 12 件: 解消 9・部分 3)

凍結条件 4 件と新規 5 件(うち 1 件は実装時判断)をすべて反映。

| # | 指摘 | 採否 | 反映 |
| --- | --- | --- | --- |
| 条件 1 / R3-1 | `ARCHIVED`+`audit PENDING`+`lock_released false` の一次 code が JSON 表(ロック未解放)と優先順・受入 8f⑥(監査未確定)で逆転 | 採用 | JSON 表を分割: PENDING+false → `RUN_ARCHIVED_AUDIT_PENDING`(解放失敗は併記)、RECORDED+false → `RUN_ARCHIVED_LOCK_UNRELEASED` |
| 条件 2 / R3-2 | outcome 表が閉じていない(`LOCK_UNAVAILABLE`・Run 再取得不能・PUT 明示失敗・再 PUT 失敗が未割当。`REJECTED` の `…`) | 採用 | `REJECTED` の code を閉じた集合へ(`LOCK_UNAVAILABLE` / `RUN_READ_FAILED` / `ARCHIVE_WRITE_FAILED` を追加)。「Run 不変確認済み → REJECTED、確認不能 → UNCONFIRMED」の割当規則を明記。部分成功表に 4 行追加、一次対応 code を DONE 系 / REJECTED 系(不変) / REJECTED 系(不明)に整理 |
| 条件 3 / R3-3 | 受入 12 が M3/M4 の 2 値 | 採用 | 12(ハーネス・M3)と 12a(ボード・M4)に分割。M3/M4 行を更新 |
| 条件 4 / R3-4 | `RUN_ARCHIVED` の日時を物理列 `resolved_at` にどう格納するか未定義 | 採用 | §3.3 に `resolved_at = archived_at` を追加(serializer/decoder 双方) |
| R3-5(低・実装時判断) | ALREADY/REJECTED 行の true/false 併記、archive 前拒否での `RUN_ARCHIVED_LOCK_UNRELEASED` 併記は紛らわしい | 採用 | 行を true/false で分割。archive 前の解放失敗は `lock_release_failed=true` の併記に統一(archived を断定する code を使わない) |
