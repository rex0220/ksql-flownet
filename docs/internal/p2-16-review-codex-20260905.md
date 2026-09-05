# P2-16 操作要求ライフサイクル v2 仕様レビュー（Codex・2026-09-05）

## 総評

DRAFT v3 は、CLOSE・claim 前取消・終端 hold 解除を既存の操作要求経路へ統合する方向自体は実装可能であり、主な変更面も追跡できる。
一方、既存 Network lock は失効 lease を自動奪取せず、同時 CLOSE の敗者は revision 競合より先に lock 競合となるため、§5.3 と受入 8 の排他契約は現実装と一致しない。
また、ACCEPTED 要求の終端 PUT を「次周期」に送るための継続情報がなく、現行 `writeResult` の即時再 PUT とも矛盾する。取消優先も、不正レコードを完全 parse 前に別経路へ分ける現行構造ではそのまま実装できない。
以上は受入結果または状態機械を変える高重要度の問題であり、修正後の再レビューが必要である。

**FROZEN 可否: 不可**

## 指摘

| # | 対象(節) | 重要度(高/中/低) | 指摘 | 根拠(実装ファイル:行) | 修正案 |
| --- | --- | --- | --- | --- | --- |
| 1 | §4.2、§5.3 手順1・受理条件 | 高 | 「lease 失効した stale lock は CLOSE を妨げない」は、現行 acquire と両立しない。status 側は lease 時刻で live 判定するが、`NetworkLockManager.acquire()` は既存レコードが `RUNNING` なら期限を見ず `LOCK_CONFLICT` にする。したがって一次審査を通っても `archive-run` は stale lock で失敗する。 | `src/persistence/network-lock-reader.ts:53-79`、`src/persistence/network-lock.ts:190-210`、`src/requests/request-poller.ts:349-362` | 「stale は事前審査上 live ではないが、実 lock 取得前に `force-unlock-network` が必要」とするか、所有者停止確認を伴う安全な stale 回収を `archive-run` の契約へ追加する。自動奪取を採るなら既存 lock 回復契約まで再設計する。 |
| 2 | §5.3 手順1〜3、I-05 | 高 | owner を `archive_<uuid>` にするだけでは「同じ lease 機構」を満たさない。実行経路は `LeaseMonitor` を開始し、書込直前にも heartbeat/fence を確認するが、仕様は `archive-run` の heartbeat、lease 失効時の中止、最終書込前 fence を定めていない。長い API 遅延や強制解放後に Run を ARCHIVED 化すると排他保証が崩れる。 | `src/cli/run-network-command.ts:357-366`、`src/cli/run-network-command.ts:422-455`、`src/orchestration/sequential-scheduler.ts:163-183`、`src/orchestration/sequential-scheduler.ts:965-977`、`src/persistence/network-lock.ts:218-274` | `archive-run` も `LeaseMonitor` を開始し、Run PUT と監査 PUT の前に `tick()` または同等の token/revision fence を確認し、lease 不確実時の code と部分成功規則を定義する。短時間処理として monitor を省くなら、少なくとも各書込直前の `heartbeat()` 成功を必須にする。 |
| 3 | §7 受入8 | 高 | 「同時 CLOSE の2件目は revision 競合後 `RUN_ALREADY_ARCHIVED`」にはならない。両 CLI が同じ Network lock を先に取得するため、後着は Run の再 GET/PUT より前に `LOCK_CONFLICT` で終了する。 | `src/persistence/network-lock.ts:145-166`、`src/persistence/network-lock.ts:203-208`、`docs/internal/p2-16-request-lifecycle-v2-spec.md:148-153` | 受入8を「同時実行の敗者は `LOCK_CONFLICT`、ロック解放後の再 CLOSE は `RUN_ALREADY_ARCHIVED`」へ変更する。2件目も待機して NOOP にしたいなら、lock 待機・再取得を新規仕様化する。 |
| 4 | §5.3 hold との競合、§7 受入8c | 高 | FAILED/CANCELLED Run を初期状態とする CLOSE と `cancel-run` の二者競合では、CLI STOP は terminal 判定で hold を作れない。仕様の「手順2後に CLI `cancel-run` が hold を作り ARCHIVED+hold」は通常の開始状態では再現不能で、受入8cの前提が不足している。 | `src/orchestration/cancel-request.ts:32-37`、`src/orchestration/cancel-request.ts:42-64`、`docs/internal/p2-16-request-lifecycle-v2-spec.md:143-154` | 受入8cを削除するか、非終端時に STOP が Run を読んだ後、Run 終端化、CLOSE の hold 確認、STOP の作成 PUT、という三者順序を明記した障害注入試験へ変更する。単純な「終端 Run に CLI STOP」は拒否されることも別受入にする。 |
| 5 | §4 状態機械、§5.1 取消優先、受入11 | 高 | `cancel_requested` と入力不正が同時なら CANCELLED を優先する契約は、現行取得構造へ単純追加できない。完全 parser で失敗したレコードは `InvalidRequestRecord`（id/revision/issues のみ）へ落ち、ポーラーは valid の claim ループより前に直接 REJECTED にするため、取消値を参照できない。 | `src/requests/kintone-request-store.ts:96-116`、`src/requests/kintone-request-store.ts:126-141`、`src/requests/request-poller.ts:68-91`、`src/requests/request-model.ts:309-340` | list 時に id/revision/request_state/cancel_requested だけを読む最小 envelope を全識別可能レコードへ保持し、取消ありなら完全 validation より先に CANCELLED 終端化する。`InvalidRequestRecord` に生の取消値だけを足してもよいが、checkbox 型不正時は fail-closed の優先順位を明記する。 |
| 6 | §4.2 連続3周期警告 | 中 | `poll-requests` は one-shot であり、要求モデルにも競合回数欄がないため「連続3周期」の回数を保持できない。プロセス内カウンタは cron の次回起動で失われる。 | `src/cli/poll-requests-command.ts:16-40`、`src/requests/request-model.ts:27-45` | 永続カウンタを追加しない方針なら「各競合時に警告」に変更する。3周期を維持するなら、要求レコードまたは別の機械管理レコードに retry count を持たせ、その更新自体の競合規則も定める。 |
| 7 | §5.1 終端化直前再 GET、§4.2、受入4b | 高 | ACCEPTED の結果 PUT が競合した場合に「次周期へ」送る契約は実装不能である。次周期の通常ループは REQUESTED だけを処理し、ACCEPTED は stale 回収しか行わず、終了済み child の `RequestResult` も保持していない。一方、現行 `writeResult()` は競合時に即時再 GET・無条件再 PUTするため、1周期1回とも REQUESTED 以外は対象外とも一致しない。 | `src/requests/request-poller.ts:68-91`、`src/requests/request-poller.ts:365-427`、`src/requests/kintone-request-store.ts:192-231` | ACCEPTED 終端は同じ周期内で「再 GET 1回→状態が ACCEPTED か確認→cancel 付記→revision 付き PUT 1回」として完結させ、再競合時は結果不明（STALE/専用 code）へ寄せるか、結果を永続化して次周期に再開する新状態を設ける。§4.2 は REQUESTED→CANCELLED 専用規則と明記して ACCEPTED 終端へ参照させない方が小さい。 |
| 8 | §5.3 手順3〜5、監査失敗契約 | 高 | ARCHIVED 書込の応答喪失、監査成功後の lock 解放失敗、監査応答喪失の裁定が未定義である。現行 Run 更新 API は lifecycle_status を更新する surface 自体がなく、通常集約更新は status/時刻だけを PUT する。監査 union にも RUN_ARCHIVED がない。部分成功を `ARCHIVE_AUDIT_FAILED` だけに限定すると、Run が既に ARCHIVED の別障害を REJECTED と誤分類し得る。 | `src/persistence/repository.ts:48-53`、`src/persistence/repository.ts:138-177`、`src/persistence/kintone/repository.ts:601-615`、`src/domain/persistence-model.ts:222-225`、`src/persistence/network-lock.ts:277-325` | lifecycle 専用の revision-fenced repository method と `RunArchivedOperationAudit` を追加する前提を仕様へ記載し、(a) Run PUT 応答不明時の再 GET 裁定、(b) audit PUT 応答不明時の event_id 照合、(c) lock 解放失敗時の要求結果と runbook を表で定義する。lock 解放は `finally` で必ず試す。 |
| 9 | §3.3 監査モデル | 中 | 監査 JSON の必須項目が既存 `OperationAudit` の共通識別方式まで定まっていない。既存は `event_id` を一意キー化して重複を裁定し、event type ごとに日時欄を選ぶため、`requested_by/reason/archived_at/previous_status` だけでは serializer と応答喪失時の再確認を一意に実装できない。 | `src/persistence/in-memory-repository.ts:435-446`、`src/persistence/kintone/repository.ts:1017-1049`、`src/domain/persistence-model.ts:150-225` | `event_id = archive_<uuid>`、`event_type = RUN_ARCHIVED`、`run_id`、`requested_by`、`reason`、`archived_at`、`previous_status` を型として固定し、同一 event_id の再読取一致を成功とみなす規則を追加する。必要なら `service_principal` の有無も決める。 |
| 10 | §3.4 status JSON、§5.2 RELEASE | 中 | `hold` 追加は実装可能だが、detail と list の両方に明示的に載せる必要がある。現行は cancel record を両経路で既に取得しているため追加コストは小さい。既存 status テストは run_id 等の部分 assertion で、追加フィールドだけでは直ちに壊れないが、hold の完全な差分契約は現在テストされていない。 | `src/orchestration/status.ts:110-125`、`src/orchestration/status.ts:151-178`、`src/orchestration/status.ts:297-324`、`tests/unit/status.test.mjs:191-227`、`tests/unit/status.test.mjs:257-268` | `RunSummaryOutput` に hold を必須（null 可）で追加し、summary/detail の共通 builder へ cancel request を渡す。REQUESTED/ACCEPTED/RELEASED、終端 Run、list/detail、既存キー不変を schema 差分テストで固定する。`reviewRequest` は RELEASE を `run.hold !== null` で判定する。 |
| 11 | §5.1 ボード取消表示、受入9 | 高 | 現在の run 別 pending GET は `$id/run_id/request_state` しか取得せず、集約後は最古 id/count/label しか残さない。START pending も creator は name だけで code と revision がない。さらに runtime 型に `kintone.getLoginUser()` がない。このままでは「本人だけ」「取得 revision 付き PUT」「要求種別・対象・理由の再表示」を構成できない。 | `plugin/src/request-client.ts:33-39`、`plugin/src/request-client.ts:64-123`、`plugin/src/request-client.ts:286-351`、`plugin/src/request-client.ts:377-427`、`plugin/src/board-controller.ts:397-410`、`plugin/src/desktop.ts:60-96` | pending model を要求単位（id/revision/type/state/creatorCode/reason/対象/cancel_requested）で保持し、`getLoginUser().code` と creatorCode を比較する。複数 pending がある run は各要求を選べる UI にするか、取消対象を最古1件に限定するかを仕様で決める。 |
| 12 | §6 runtime PUT、§4.1 | 中 | PUT 経路の追加自体は可能だが、現 runtime は GET と単票 POST の型・factory しか持たない。kintone の更新 body では取得フィールド名は `$revision` でも送信キーは `revision` であり、checkbox 値は文字列ではなく配列 `['取消']` である。この wire 形を仕様に固定しないと「`$revision` 付き」の解釈が割れる。 | `plugin/src/desktop.ts:79-96`、`plugin/src/desktop.ts:121-135`、`plugin/src/request-client.ts:179-216`、`src/requests/request-model.ts:63-79` | body を `{ app, id, revision, record: { cancel_requested: { value: ['取消'] } } }` と明記し、固定 builder 以外から PUT できない型にする。単票・1フィールド・revision 必須・解除値 `[]` 禁止を `activity-plugin-request.test.mjs` の完全一致テストで固定する。 |
| 13 | §5.3 監査失敗のポーラー分類 | 中 | stderr code の検出は既存 `ChildProcessResult` に収まるが、CLOSE 用 child method と classifier はなく、現 classifier は cancel-run 非0終了をすべて一般拒否へ畳む。出力は64 KiBで打ち切られるため、code の出力位置と truncated 時の fail-closed も必要である。 | `src/requests/flownet-child-client.ts:12-22`、`src/requests/flownet-child-client.ts:179-220`、`src/requests/flownet-child-client.ts:263-315`、`src/requests/request-result.ts:108-130` | `archiveRun()` と専用 classifier を追加し、`^Error \[ARCHIVE_AUDIT_FAILED\]:` を stderr 先頭で完全一致させる。`stderrTruncated` または code 不一致は通常 DONE にせず `CHILD_RESULT_INVALID`/専用不明 code にする。可能なら stderr 解析より小さな JSON 結果を導入する。 |
| 14 | §7 受入2・8b と fault-hook | 中 | 現行 fault-hook は対象 host の全通信または全書込を一括遮断するだけで、特定 request の cancel PUT と claim PUT、特定 NETWORK_LOCK 作成を停止・解放して順序固定できない。受入2/8bをこの hook のまま決定的に実施することはできない。 | `tests/e2e/fault-hook.mjs:15-59`、`tests/e2e/fault-hook.mjs:63-79` | path、method、body の field/code/id による対象指定と、barrier 到達ログ＋外部 release を hook に追加する。受入2は request id と更新 field、8bは NETWORK_LOCK POST/Run 実行開始を対象にする。 |
| 15 | §3.1、§7 取消済み要求の E2E | 中 | E2E 共通 decoder は `cancel_requested` を読まず、terminal 集合は DONE/REJECTED のみである。START の最近の終端 query/model も CANCELLED を終端として扱わないため、取消受入は待機・表示の双方で漏れる。 | `tests/e2e/p2-01-support.mjs:134-155`、`tests/e2e/p2-11-support.mjs:23-49`、`plugin/src/request-client.ts:298-311`、`plugin/src/request-client.ts:353-375` | decoder と terminal 集合を CANCELLED 対応にする。START 履歴へ CANCELLED を含めるか、`03_取消済み` 一覧だけを正としてボード履歴から除外するかを明記し、対応する query/test を固定する。 |
| 16 | §5.2/§5.3 `reviewRequest` 分岐 | 中 | 現行 `reviewRequest` は RERUN、STOP、それ以外=RELEASE の三分岐である。CLOSE を型へ追加しただけでは RELEASE 分岐へ落ち、`hold=null` の closable Run を `RUN_NOT_ON_HOLD` にしてしまう。 | `src/requests/request-poller.ts:315-346`、`src/requests/request-model.ts:3-13` | request type ごとの exhaustive switch に変更し、RELEASE/CLOSE を別分岐にする。CLOSE は status、lifecycle、hold、live の判定順と code 優先順位を表で固定する。 |

## 観点 A の判定と変更対象

| 観点 | 判定 | 実装判断 | 主な変更対象ファイル |
| --- | --- | --- | --- |
| A1 archive-run の Network lock | **要変更** | `NetworkLockManager` は Invocation ID の文字列型を強制していないため `archive_<uuid>` owner で流用できる。ただし stale lock は acquire を阻み、archive owner はどの Run の Invocation にも属さないため Run activity を LIVE にしない一方、status の global lock/force-unlock 表示には現れる。heartbeat/final-write fence も仕様追加が必要。 | `src/cli/index.ts`、新規 `src/cli/archive-run-command.ts`、新規 orchestration、`src/persistence/network-lock.ts`、`src/orchestration/status.ts`、`tests/unit/cli.test.mjs`、新規 archive 単体 |
| A2 claim 前取消の差込 | **要変更** | valid record は `listRequested` 後・`claim` 前に1回判定する形が自然で、claim 競合後は次周期で再取得できる。しかし invalid record の取消優先、claim 競合直後の再 GET、3周期カウンタは現構造にない。 | `src/requests/request-model.ts`、`src/requests/kintone-request-store.ts`、`src/requests/request-poller.ts`、`src/cli/poll-requests-command.ts`、`tests/unit/request-store.test.mjs`、`tests/unit/poll-requests.test.mjs` |
| A3 終端化直前の再 GET | **不可（現記述のまま）** | heartbeat が返す最新 revision を保持する点は整合するが、public GET がなく、現 `writeResult` は競合時に即時再 PUTする。「次周期」には child 結果が残らないため、再試行時点を同周期内へ修正するか永続状態追加が必要。 | `src/requests/kintone-request-store.ts`、`src/requests/request-poller.ts`、`tests/unit/request-store.test.mjs`、`tests/unit/poll-requests.test.mjs` |
| A4 RELEASE と status hold | **要変更** | status は detail/list とも cancel record を既に読むため実装しやすい。追加フィールドだけで現単体の部分 assertion は壊れにくいが、schema 差分テストと RELEASE の明示分岐が必要。 | `src/orchestration/status.ts`、`src/requests/request-poller.ts`、`tests/unit/status.test.mjs`、`tests/unit/poll-requests.test.mjs`、必要に応じ `src/cli/status-command.ts` |
| A5 request model 波及 | **要変更** | CLOSE/CANCELLED の union 追加だけでなく、checkbox 配列 parser、取消優先用最小 envelope、terminal query/集合、テンプレート選択肢が波及する。 | `src/requests/request-model.ts`、`src/requests/kintone-request-store.ts`、`templates/create-flownet-request-app.console.js`、新規追補 template、`tests/e2e/p2-01-support.mjs`、`tests/e2e/p2-11-support.mjs`、`plugin/src/request-client.ts`、関連 unit |
| A6 plugin の cancel PUT | **要変更** | GET+POST 境界へ限定的な PUT overload/factory を足せば実装可能。payload の完全固定、revision、checkbox 配列、409/通信断後の再 GET を専用関数に閉じ込める必要がある。 | `plugin/src/desktop.ts`、`plugin/src/request-client.ts`、取消 dialog/render、`tests/unit/activity-plugin-request.test.mjs`、`tests/unit/activity-plugin-dialog.test.mjs` |
| A7 作成者本人の表示条件 | **要変更** | `作成者.code` と `kintone.getLoginUser().code` の比較方式は成立するが、現 pending read/model と runtime 型は必要値を保持していない。複数 pending の UI 単位も要決定。 | `plugin/src/request-client.ts`、`plugin/src/board-controller.ts`、`plugin/src/desktop.ts`、`plugin/src/render.ts`、関連 controller/render unit |
| A8 監査失敗の結果契約 | **要変更** | `ChildProcessResult.stderr` で専用 code を判定する経路は作れる。専用 `archiveRun`/classifier、truncation 時の fail-closed、Run PUT・audit PUT・lock release の部分成功 matrix が必要。 | `src/requests/flownet-child-client.ts`、`src/requests/request-result.ts`、`src/requests/request-poller.ts`、`tests/unit/flownet-child-client.test.mjs`、新規 classifier/archive tests |

## 不変条件・既存契約との照合

- **I-01 / G-09 改訂**: `archive-run` は機械経路であり、人は操作要求アプリだけを書く構成なので方向上は整合する。plugin PUT を `cancel_requested` だけへ型・テストで固定する必要がある（`plugin/src/desktop.ts:79-96`、`plugin/src/request-client.ts:179-216`）。
- **I-02 / 統合仕様 §7.7**: 現 runtime は PUT を持たないため、例外を独立 factory に限定すれば境界を保てる。汎用 update API を公開しないことが必要（`plugin/src/desktop.ts:121-135`）。
- **I-03**: ボードが既存 `CANCEL_REQUEST` から hold を推測し、ポーラーが status detail を正とする分離は実装に合う（`plugin/src/board-controller.ts:181-203`、`src/orchestration/status.ts:151-178`）。
- **I-04**: kintone revision 競合で cancel/claim を裁定する方針は既存 claim PUT と整合するが、claim 409 後の再 GET は未実装（`src/requests/kintone-request-store.ts:144-175`）。
- **I-05**: Run revision だけでなく Network lease fence が必要。現 scheduler は書込前 `tick()` を行うため、archive も同水準に合わせる必要がある（`src/orchestration/sequential-scheduler.ts:965-977`）。
- **I-06**: 取消通信断後に再 GET して断定を避ける規則は整合する。ただし再 GET 自体が失敗した場合の最終 UI 文言を固定する必要がある。
- **G-01/G-02**: RERUN の status/lifecycle/live 判定は維持できるが、hold 判定を activity のみに残すと終端 hold を事前拒否できない（`src/requests/request-poller.ts:323-335`、`src/orchestration/run-activity.ts:19-23`）。status `hold` 追加時に RERUN も `hold !== null` を見るべきである。
- **G-03**: CLOSE も既存 run_id→allowlist 全 network status 検索で一意解決できる（`src/requests/request-poller.ts:301-312`）。
- **G-04/G-07**: Invocation 作成後は Run の失敗でも要求 DONE、という既存意味論は維持される。CLOSE は Invocation を作らない別の状態変更操作なので、`RUN_ARCHIVED_AUDIT_PENDING` を DONE とする例外は明示されている。ただし他の部分成功は指摘 #8 の補完が必要。
- **G-05**: claim 通信断で ACCEPTED が残る場合を STALE 回収へ渡す方針は既存実装と整合する（`src/requests/request-poller.ts:365-427`）。
- **G-06**: RELEASE が hold 解除だけで resume しない点は既存 CLI 実装と整合する（`src/orchestration/cancel-request.ts:44-53`）。
- **G-08**: `KSQL_FLOWNET_REQUESTED_BY=app-request:<id>:<creator>` は archive child にも既存 helper を流用できる（`src/requests/flownet-child-client.ts:206-219`、`src/requests/flownet-child-client.ts:235-251`）。
- **統合仕様 §6.1 / §6.7**: CANCELLED を terminal union と result-required validation に追加すれば形は整合するが、関連 terminal 集合・query の更新漏れがある（指摘 #15）。

## §7 受入基準の実行可能性

| 受入 | 判定 | 既存ハーネスでの実施方法・不足 |
| --- | --- | --- |
| 1 | 要拡張で可 | `createRequest`/decoder に checkbox を追加し、child 呼出し記録と state/audit snapshot を使う。現 decoder は取消値を読まない（`tests/e2e/p2-01-support.mjs:134-155`）。 |
| 2 | 現状困難 | 現 fault-hook は全 write 遮断のみ。request id＋PUT field ごとの barrier が必要（`tests/e2e/fault-hook.mjs:27-59`）。 |
| 2b | 可 | plugin の fetch/PUT dependency に通信失敗と再 GET 応答を注入する単体で実施できる。 |
| 3 | 可 | `withHeartbeat` 完了前に request GET が cancel=true を返す mock を入れ、child 継続と message suffix を検証する。ただし終端競合契約を先に修正する。 |
| 4 | 要拡張で可 | 既存 long-read fixture と STOP/RELEASE E2E を基に、FAILED+hold を作り status hold と後続 RERUN を検証できる。 |
| 5 | 可 | `reviewRequest` の hold=null matrix 単体で固定できる。 |
| 6 | 要拡張で可 | archive CLI 実行、Run/OPERATION_AUDIT 読取、terminal loader の ACTIVE filter、resume 拒否を組み合わせる。既存 loader は ARCHIVED を除外済み（`plugin/src/terminal-run-loader.ts:14-26`）。 |
| 7 | 要拡張で可 | SUCCESS/UNKNOWN/hold は fixture・repository seed、LIVE は long SQL の lock を利用可能。状態・revision snapshot を併用する。 |
| 8 | **不可（期待値矛盾）** | 同時 CLI の後着は `LOCK_CONFLICT`。指摘 #3 のとおり受入期待を変更する。 |
| 8b | 現状困難 | long SQL fixture は使えるが、lock 保持到達を決定的に観測して CLOSE を発火する barrier が fault-hook にない。hook 拡張後は可。 |
| 8c | **不可（シナリオ不足）** | terminal Run への STOP は CLI が拒否する。指摘 #4 の三者順序まで定義するか受入を変更する。 |
| 8d | 可 | repository/lock manager を依存注入する archive orchestration 単体にし、audit append だけ失敗させて Run/lock/result を検証できる。 |
| 4b | 条件付き可 | public re-GET と修正後の同周期 finalization を mock すれば可。現仕様の「次周期」再試行のままでは不可。 |
| 11 | 可 | 最小 envelope parser と完全 validation を別 mock にし、cancel 優先・child 未起動を検証できる。 |
| 9 | 手動のみ | template に field ACL 設定処理が現存せず、作成者 entity が指定可能かは実機確認が必要。確認不能なら仕様記載どおり代替 ACL と実際の他人 PUT 結果を記録する。 |
| 10 | 可 | status fixture の `getCancelRequest()` を REQUESTED/ACCEPTED/RELEASED/null に差し替え、terminal/list/detail と既存 key を比較する。現 fixture は常に null（`tests/unit/status.test.mjs:120-122`）。 |

## 実装と突き合わせて確認済みの事項

- Network lock の owner は型上任意文字列で、作成時に `owner_invocation_id` へそのまま保存される（`src/persistence/network-lock.ts:52-64`、`src/persistence/network-lock.ts:151-164`）。
- activity は終端 status を最初に null へ倒し、未終端でも lock owner が Run の Invocation 集合に属する場合だけ LIVE になる。したがって `archive_<uuid>` は Run activity を LIVE にしない（`src/orchestration/run-activity.ts:19-31`）。
- status の lock 表示は network global であり、詳細 Run との owner 所属を問わず force-unlock identifier を返す（`src/orchestration/status.ts:228-236`、`src/orchestration/status.ts:250-274`）。
- Run の ARCHIVED 値と resume 拒否は既存モデル/ensure-run にある（`src/domain/persistence-model.ts:49-56`、`src/orchestration/ensure-run.ts:1009-1013`）。一方、repository の既存 aggregate update は lifecycle_status を PUT しない（`src/persistence/kintone/repository.ts:601-615`）。
- REQUESTED は作成日時・id 順、上限付きで1回取得され、valid は1件ずつ逐次 claim/process/result されるため、取消終端化を1件1回差し込む基本ループは存在する（`src/requests/kintone-request-store.ts:96-116`、`src/requests/request-poller.ts:79-92`）。
- claim/heartbeat/result の全 PUT は取得 revision を送る。heartbeat 成功時は返却 revision を request object に反映する（`src/requests/kintone-request-store.ts:144-189`）。
- 現 `writeResult` は初回競合後に再 GET し、terminal 完全一致でなければ最新 revision でもう一度 PUT する（`src/requests/kintone-request-store.ts:192-231`）。
- status detail/list はすでに `getCancelRequest` を呼ぶため、hold の情報源は存在する（`src/orchestration/status.ts:151-178`、`src/orchestration/status.ts:301-317`）。
- RELEASE の現一次審査は `activity === STOPPED` であり、終端 Run は activity を持たない（`src/requests/request-poller.ts:337-346`、`src/orchestration/run-activity.ts:19-23`）。
- plugin は実行管理アプリから CANCEL_REQUEST を取得しているため、終端行にも hold 推測を付けられる（`plugin/src/board-controller.ts:195-203`）。
- plugin runtime の現在の書込は単票 POST だけで、PUT overload は未実装（`plugin/src/desktop.ts:79-96`、`plugin/src/desktop.ts:128-135`）。
- 要求テンプレートの選択肢は現状4種、状態は4種であり、cancel checkbox・取消一覧・field ACL 設定は未実装（`templates/create-flownet-request-app.console.js:49-75`、`templates/create-flownet-request-app.console.js:167-209`）。
- child process は stdout/stderr、truncation、spawn error を保持するため、監査失敗 code の専用分類を追加できる（`src/requests/flownet-child-client.ts:15-22`、`src/requests/flownet-child-client.ts:263-315`）。
- terminal board loader は `lifecycle_status = ACTIVE` で絞っており、ARCHIVED 後に要対応一覧から消える契約は既存実装にある（`plugin/src/terminal-run-loader.ts:14-26`）。

## 未確認事項

- kintone フィールドアクセス権の entity に「作成者」を指定できるか、および指定時に作成画面と更新 API がどう振る舞うかは、ローカルコードからは確認不能であり**未確認**。受入9の実機確認が必要。
- 実ブラウザ上の `kintone.getLoginUser()` 戻り値と `作成者.code` の一致は一般的な API 形を前提に実装可能と判断したが、本リポジトリの実機 E2E 証跡では**未確認**。
- 本レビューは仕様と静的コード・テストハーネスの照合であり、コード変更をしていないため unit/E2E は実行していない。
