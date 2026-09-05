# P2-16 操作要求ライフサイクル v2 — CLOSE・処理前取消・終端 hold の解除

- 状態: **DRAFT v3**(2026-09-05 起案、同日 Gemini 第1巡・ChatGPT 第1巡を反映 — §11)
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
| フィールドアクセス権 | **機械フィールド 6 種**(`request_state` / `claimed_at` / `claimed_host` / `claim_heartbeat_at` / `result_code` / `result_message`)を kintone のフィールドアクセス権で人には閲覧のみにする(これは kintone 標準で担保できる)。**入力フィールド**(`request_type` / `run_id` / `network_id` / `business_key` / `scheduled_for` / `rerun_from_node` / `reason`)は「作成時は入力可・起票後は編集不可」を kintone のフィールド権限だけでは作れない(閲覧のみにすると作成画面でも入力不可になる)ため、**起票後の直接編集は運用違反**と定め、ボードは編集経路を持たず、ポーラーは claim 時点のスナップショットで裁定する(既存 §8.4 の「機械フィールドの手動編集は `REQUEST_INVALID`」はそのまま)。プロセス管理(ステータス)による技術的抑止は本仕様では採用しない(X-4 引継ぎの結論) |
| 一覧 | `01_未処理要求` に `cancel_requested` 列を追加。`03_取消済み`(request_state in CANCELLED)を追加する(U-1 決定) |

追補は `templates/add-request-lifecycle-v2.console.js`(新設)で行い、テンプレート(R3 成果物)へも反映する。

### 3.2 実行管理アプリ(§3.2)

変更なし。`lifecycle_status = ARCHIVED` は既存フィールドの既存値で、意味論(ensure-run が resume 拒否・ボードの要対応一覧から除外)は実装済み。

### 3.3 監査履歴アプリ(§3.3)

`OPERATION_AUDIT` に `RUN_ARCHIVED` を追加(`run_id`・`result_code = RUN_ARCHIVED`・`reason` JSON に `requested_by`・`reason`・`archived_at`・`previous_status`)。

### 3.4 status JSON(§5.5)

`runs[]` に **`hold`** を追加(読み取り専用の追加。既存フィールド不変):

```json
"hold": { "state": "REQUESTED | ACCEPTED", "requested_by": "string", "requested_at": "string" } | null
```

終端 Run でも hold があれば非 null になる。activity の導出規則は変えない(終端は引き続き activity なし)。

## 4. 状態機械(§6.1 改訂)

| 現在状態 | 遷移 | 主体 | 条件 |
| --- | --- | --- | --- |
| `REQUESTED` | `ACCEPTED` | ポーラー | revision 指定の claim PUT 成功(**`cancel_requested` が空のとき**) |
| `REQUESTED` | `CANCELLED` | ポーラー | claim 時点で `cancel_requested` が入っている → claim せず revision 指定で終端化(`result_code = CANCELLED_BY_REQUESTER`) |
| `REQUESTED` | `REJECTED` | ポーラー | 構造・入力検証が不正(従来どおり)。**`cancel_requested` が立っている場合は検証より取消を優先**し `CANCELLED` にする(どちらも実行しないが、起票者の意図を結果に残す) |
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

### 4.2 終端化 PUT の再試行規則

- ポーラーは **1 周期につき 1 要求 1 回**だけ終端化 PUT を試み、revision 競合なら当該要求をその周期では触らない(無限ループなし)
- 次周期の再 GET で `request_state` が `REQUESTED` 以外なら対象外(別経路で終端済み)。`request_state` は機械専用フィールドで人は変更できないため、REQUESTED 以外になり得るのはポーラー自身の書込だけである
- `REQUESTED` かつ `cancel_requested` のままなら再度終端化を試みる。連続 3 周期競合が続いた場合は警告ログ(`CANCEL_FINALIZE_RETRY_EXCEEDED`)を出すが処理は継続する(claim せず取消優先のまま)

## 5. 機能仕様

### 5.1 P2-12 処理前取消

**ボード(§7.2 pending 表示)**

- pending リンク先(START要求セクション・進行中 Run の pending バッジ)に、`request_state = REQUESTED` かつ **ログインユーザーが要求の `作成者` と一致する**行だけ **「取消」ボタン**を出す(U-4)。`ACCEPTED` の行には出さない(X-3)。他人の要求は表示のみ
- 押下 → 確認ダイアログ(要求種別・対象・理由を再表示し、**「取消は元に戻せません。再度実行するには新規に起票してください」**を明記)→ `cancel_requested` のみを含む単票 PUT(`$revision` 付き)
- 409・通信エラーは §4.1 の表どおり再 GET して判定する。「取消できませんでした」と断定するのは、再 GET で `REQUESTED` かつ `cancel_requested` が空と確認できた場合だけ
- 取消者の証跡は kintone の**レコード変更履歴**を正とする(更新者欄はポーラーの書き戻しで上書きされる — X-5)

**ポーラー**

- claim 直前に取得したレコードの `cancel_requested` を判定する。入っていれば claim せず、取得時 revision で `request_state = CANCELLED`・`result_code = CANCELLED_BY_REQUESTER`・`result_message = "requester cancelled before claim"` を PUT。revision 競合なら次周期へ
- 統計 `cancelled=N` を `poll-requests` の出力行に追加
- `ACCEPTED` 以降で `cancel_requested` が立っていても処理を続行する。**終端化の直前に要求レコードを再 GET** し、その時点で `cancel_requested` があれば `result_message` 末尾に `(cancel_ignored)` を付記する。終端 PUT はこの再 GET の revision を使い、競合時は §4.2 の再試行規則に従う。`DONE` / `REJECTED` 後のフラグ変更は結果へ遡及反映しない

**一次対応(§6.7 追加 code)**: `CANCELLED_BY_REQUESTER` — 起票者が処理前に取り下げた。何も実行されていない。

### 5.2 P2-15 終端 Run に残った hold の解除

**ポーラーの RELEASE 受理条件(§6.3 改訂)**

- 現行「activity = STOPPED」→ **「status JSON の `hold` が非 null(REQUESTED/ACCEPTED)」**へ変更。Run 状態は問わない(RUNNING でも FAILED/CANCELLED でも可)
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
| `CLOSE` | Run が `FAILED` / `CANCELLED`、`lifecycle_status = ACTIVE`、live owner なし(**判定は既存 G-02 と同一**: Network lock の owner が当該 Run の Invocation に属し lease が生存(分精度+60秒余裕)している場合のみ live。クラッシュ後の stale lock は lease 失効で live 扱いにならず、CLOSE を妨げない)、**hold なし**(hold があれば先に RELEASE)。`SUCCESS` は対象外(`RUN_STATUS_NOT_CLOSABLE`)、`UNKNOWN` は `resolve-node` で解決してから(`RUN_UNKNOWN_NOT_CLOSABLE`) | 新 CLI `archive-run --run-id <run_id> --reason-file <一時ファイル>` を子プロセス起動 | `RUN_ARCHIVED` |

**新 CLI `archive-run`(§5.1・§5.6 追加)**

- 引数: `<network.yaml のパス>`(必須。ポーラーは allowlist の `definition_path` を渡す)、`--run-id`(必須)、`--reason-file`(必須)、`--profile`。`--json` は実装しない(他の運用コマンドと同じ)
- 処理順(**排他契約**):
  1. **Network ロックを取得する**(run-network と同じ lease 機構。owner は `archive_<uuid>`、lease は定義の `network_lock` 値)。取得できなければ `LOCK_CONFLICT` で終了 — これにより **RERUN / resume / START の Invocation と CLOSE は同じ profile・network で直列化**され、「CLOSE が確認した後に別 Invocation がノード実行を開始し、その後 ARCHIVED が書かれる」順序は成立しない(Run レコードの revision だけでは防げない: 失敗 Run の resume は `started_at` が非 null のためノード開始まで Run レコードを書かない)
  2. ロック内で Run を再取得し、受理条件(`FAILED` / `CANCELLED`・`ACTIVE`・hold なし)を再検証する(fail-closed)
  3. `lifecycle_status = ARCHIVED` を **revision fencing 付き** PUT
  4. `OPERATION_AUDIT / RUN_ARCHIVED` を記録
  5. Network ロックを解放(tombstone)
- **hold との競合**: 手順 2 の確認後に `cancel-run`(STOP)が hold を作る順序は排除しない。結果は「ARCHIVED かつ hold あり」だが、ARCHIVED は resume されず、hold は RELEASE で解除できる(§5.2 は Run 状態を問わない)ため無害。STOP 要求自体は終端 Run へは `RUN_TERMINAL` で拒否されるので、実際に起き得るのは CLI `cancel-run` の直接実行だけ
- **監査失敗の結果契約**: 手順 3 成功後に手順 4 が失敗した場合、stdout に `ARCHIVED: <run_id> (revision N) AUDIT_PENDING`、stderr に `Error [ARCHIVE_AUDIT_FAILED]: ...` を出し **exit 1**。ポーラーはこの stderr code を検出したとき要求を **`DONE / RUN_ARCHIVED_AUDIT_PENDING`**(Run は ARCHIVED 済み・監査補完が必要)とし、`result_message` に補完手順(runbook 参照)を書く。通常の拒否(REJECTED)と混同させない。手動補完の前に、監査アプリに同 `run_id` の `RUN_ARCHIVED` が既に無いことを確認する(書込応答喪失で実は記録済みの場合がある)
- **既に ARCHIVED の Run への CLOSE**: 何もせず `DONE / RUN_ALREADY_ARCHIVED`(望む状態に既にあるため NOOP 扱い。START の `NOOP_ALREADY_SUCCESS` と同じ考え方)
- `requested_by` は `KSQL_FLOWNET_REQUESTED_BY`(ポーラー経由なら `app-request:<id>:<creator>`)
- **逆操作(unarchive)は提供しない**。誤クローズは新しい業務キー(補正キー)で再実行する — ARCHIVED を戻す経路を作らないことで「終端の最終性」を保つ

**ボード**: `FAILED/CANCELLED`(hold なし)の操作に **「クローズ要求」** を追加(リラン要求の隣・二次確認ダイアログに「以後この Run は再開できません」を明記)。ARCHIVED になった Run は要対応一覧から消える(既存フィルタ)。

**一次対応(§6.7 追加 code)**: `RUN_ARCHIVED` / `RUN_ARCHIVED_AUDIT_PENDING`(DONE・監査補完要) / `RUN_ALREADY_ARCHIVED`(DONE・NOOP) / `RUN_STATUS_NOT_CLOSABLE` / `RUN_UNKNOWN_NOT_CLOSABLE` / `RUN_ON_HOLD`(CLOSE でも hold は拒否理由) / `LOCK_CONFLICT`(別 Invocation が実行中)。

## 6. ボード runtime の API 境界(§7.7 改訂)

| 対象 | 許可する runtime 操作 |
| --- | --- |
| 操作要求 | レコード GET、単票 POST、**`cancel_requested` のみの単票 PUT(`$revision` 必須)** |
| 他 | 変更なし |

PUT はこの 1 フィールド以外を含めてはならない(runtime 側で payload を固定)。

## 7. 受入基準(実機 E2E・単体)

| # | 内容 | 層 |
| --- | --- | --- |
| 1 | REQUESTED 要求に取消 → 次周期で `CANCELLED / CANCELLED_BY_REQUESTER`、子プロセス未起動、Run/監査無変更 | E2E |
| 2 | 取消 PUT と claim の競合: 取消先勝ち → CANCELLED、claim 先勝ち → ボードは再 GET で「処理開始済み」を表示し、要求は正常系なら ACCEPTED→DONE(実行結果により REJECTED にもなり得る) | E2E(競合は fault-hook で順序固定) |
| 2b | 取消 PUT の通信断: サーバー側成立/不成立の両方で、ボードが再 GET の結果どおりの文言を出す | 単体(fetch 失敗を注入) |
| 3 | ACCEPTED 以降の取消は無効、結果に `cancel_ignored` | 単体 |
| 4 | STOP → 実行中 SQL 失敗 → Run FAILED + hold: ボードが解除要求を表示し、RELEASE 要求が `DONE / RELEASED`。その後リラン要求が通る | E2E |
| 5 | hold なし終端 Run への RELEASE は `RUN_NOT_ON_HOLD`(従来維持) | 単体 |
| 6 | FAILED Run へ CLOSE → `DONE / RUN_ARCHIVED`、`lifecycle_status = ARCHIVED`、`OPERATION_AUDIT` 1 件、ボード要対応一覧から消える、`--resume-run` が `RUN_NOT_RESUMABLE` | E2E |
| 7 | SUCCESS / UNKNOWN / hold あり / LIVE の Run への CLOSE はそれぞれの code で拒否・状態不変 | E2E |
| 8 | `archive-run` の revision 競合(同時 CLOSE)は 1 件だけ成功。2 件目は `RUN_ALREADY_ARCHIVED`(DONE) | 単体 |
| 8b | CLOSE と RERUN の競合: run-network が Network ロック保持中は CLOSE が `LOCK_CONFLICT`。CLOSE 完了後の run-network は `RUN_NOT_RESUMABLE`。**ARCHIVED の Run でノード実行が開始されない** | E2E(長時間 SQL fixture で順序固定) |
| 8c | CLOSE と hold 作成の競合: 結果は ARCHIVED+hold。RELEASE で hold が解除でき、resume は拒否される | 単体 |
| 8d | 監査失敗の結果契約: 手順 4 を失敗させ、要求が `DONE / RUN_ARCHIVED_AUDIT_PENDING`、Run は ARCHIVED、ロックは解放済み | 単体(監査 repository を失敗注入) |
| 4b | 終端化直前の再 GET: ACCEPTED 後に立てた `cancel_requested` が `(cancel_ignored)` として付記され、終端後の変更は反映されない | 単体 |
| 11 | 取消と入力不正が同時: `CANCELLED` が優先され `REJECTED` にならない | 単体 |
| 9 | フィールドアクセス権: 機械フィールド 6 種が一般ユーザーに閲覧のみで、`cancel_requested` は作成者が編集できる(テンプレート検証)。ボードの取消ボタンが作成者以外に出ない | 実機・手動 |
| 10 | `status --json` の `hold` が終端 Run でも返る。既存フィールドは不変(スキーマ差分テスト) | 単体 |

## 8. マイルストーン

| M | 内容 |
| --- | --- |
| M0 | 本仕様の外部レビュー(3 系統)→ FROZEN。テンプレート追補スクリプト・E2E 要求アプリへの適用 |
| M1 | 契約層: request-model(`CLOSE`・`CANCELLED`・`cancel_requested`)、status JSON `hold`、`archive-run` CLI、監査 `RUN_ARCHIVED` |
| M2 | ポーラー: claim 前取消・RELEASE 受理条件・CLOSE 分岐。単体 S 系 |
| M3 | 実機 E2E(受入 1〜8・10)。P2-01/P2-11 の回帰 |
| M4 | ボード: 取消ボタン・解除/クローズ表示・`cancel_requested` PUT。E2E UI ドライバ+受入 9 |
| M5 | 文書(仕様書 §3.4/§5/§6/§7 改訂・一次対応・runbook・templates/README)、本番適用(要求アプリ追補 → プラグイン → VPS → smoke) |

## 9. 決定事項(旧・未決事項)

| ID | 論点 | 決定(2026-09-05・Gemini 推奨を採用) |
| --- | --- | --- |
| U-1 | `03_取消済み` 一覧 | **作る**。「起票した要求が消えた」問合せに即答できる場所が要る。ビュー追加は低コスト |
| U-2 | CLOSE を SUCCESS Run にも許すか | **許さない**。要対応一覧に出ないため需要がなく、誤 ARCHIVED のリスクだけが残る |
| U-3 | `archive-run` の二次対応者による直接利用 | **可**。既存運用コマンドと同じ規律(revision fencing・監査・`--reason-file`)を満たす |
| U-4 | 取消ボタンの表示権限 | **起票者本人のみ**にボードが表示し、API 側は kintone のフィールド権限で二重に弾く。フィールドアクセス権の対象に「作成者」を指定できるかは M0 のテンプレート追補時に実機で確認し、可能なら「作成者=編集可・他=閲覧のみ」、不可なら「アプリ利用者全員=編集可(ボードの表示制御のみ)」へ落とす。他人による直接 PUT の拒否(または受理)を受入 9 で明記する。運用グループへの拡張は必要になった時点で |

## 10. 凍結条件

外部レビュー 3 系統で「実装不能」「不変条件違反」「受入の矛盾」の指摘がゼロになった時点で FROZEN とする。

## 11. 改訂履歴と外部レビューの採否

### v2(2026-09-05)— Gemini 第1巡

| # | 指摘 | 採否 | 反映 |
| --- | --- | --- | --- |
| 1-① | `cancel_requested` の再トグル(解除・再チェック)の扱い | 採用 | §3.1 で**不可逆**を明記(ボードに解除操作なし、直接解除は運用違反、復活は新規起票)。§5.1 の確認ダイアログに文言追加 |
| 1-② | CANCELLED 終端化 PUT の競合再試行と無限ループ | 採用 | §4.2 を新設: 1 周期 1 回、REQUESTED 以外は対象外、3 周期連続競合で警告 |
| 1-③ | CLOSE の live owner 判定(stale lock でのデッドロック) | 採用 | §5.3 で既存 G-02(lease 生存+60秒余裕)と同一と明記。stale lock は妨げない |
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
