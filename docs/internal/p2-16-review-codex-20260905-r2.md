# P2-16 操作要求ライフサイクル v2 仕様 第2巡レビュー（Codex・2026-09-05）

## 総評

DRAFT v4 は、第1巡16件のうち stale lock、最小 envelope、要求単位 pending、PUT wire 形など11件を解消し、既存実装へ接続できる粒度まで具体化した。
一方、`archive-run` はロック取得後の早期終了で解放が保証されず、lease 中断時の Run 状態と受入8fも一致しない。部分成功 JSON は複合障害時の code 優先順が未定義である。
また、同時 CLOSE の後着結果、status `hold` の RELEASED 表現、M3 と M4 の順序にも受入結果を一意にできない矛盾が残る。
したがって、現版のままでは実装・受入を一意に固定できず、凍結前に本文修正と再確認が必要である。

**FROZEN 可否: 不可**

## 第1巡16件の解消判定

| # | 第1巡の指摘(要約) | v4 の判定(解消/部分/未解消/新矛盾) | 根拠(実装ファイル:行) | 残る修正案 |
| --- | --- | --- | --- | --- |
| 1 | stale lock は `acquire()` を阻み、自動奪取できない | 解消 | `src/persistence/network-lock.ts:145-176,190-215`（既存 RUNNING lock は期限を見ず `LOCK_CONFLICT`）、`src/persistence/network-lock-reader.ts:53-79`（stale 候補も RUNNING lock として読める） | v4 §5.3:176 のとおり、自動奪取せず `force-unlock-network` 後に再 CLOSE とする。追加修正なし。 |
| 2 | `archive-run` に heartbeat・書込前 fence・lease 失効時中止がない | 部分 | `src/persistence/network-lock.ts:455-489,524-565,569-580`（`LeaseMonitor` は manager と lock reference だけで動き、Invocation 自体は不要）、`src/cli/run-network-command.ts:422-455`（定義の lease/heartbeat 値で生成）、`src/orchestration/sequential-scheduler.ts:163-170,583-598`（開始と、最終 close 前の停止） | Invocation を持たないこと自体は障害でない。ただし lock 取得後は手順2・3の早期終了を含め常に `monitor.stop()`→`release()` を `finally` で行うと明記する。手順4後・手順5前の `tick()` 失敗は Run が既に ARCHIVED のため、`LEASE_INTERRUPTED・Run不変` と別 outcome に分ける。 |
| 3 | 同時 CLOSE の後着は revision 競合でなく `LOCK_CONFLICT` | 部分 | `src/persistence/network-lock.ts:145-166,190-208`（同時 acquire の敗者は `LOCK_CONFLICT`）、`src/requests/request-poller.ts:81-90,140-188`（要求は逐次処理し、CLI 起動前に status 一次審査） | 両 CLI が手順1で重なれば修正どおり。ただし同一ポーラー周期の2要求は逐次で、後件は ARCHIVED を見て `RUN_ALREADY_ARCHIVED` になり得る。また先行 CLOSE の Run PUT 後・lock 解放前に一次審査した後件も同じ。受入8を「lock 取得が重なれば `LOCK_CONFLICT`、ARCHIVED 観測後は `RUN_ALREADY_ARCHIVED`」とする。 |
| 4 | 終端 Run への STOP は hold を作れず、旧受入8cの順序を再現できない | 解消 | `src/orchestration/cancel-request.ts:32-37,39-64`（非 release の終端 Run は `RUN_ALREADY_TERMINAL`）、`tests/unit/cancel-run.test.mjs:102-113`（既存挙動を固定） | v4 §5.3:205 と受入8c/8eの三者順序・別試験への分離で解消。追加修正なし。 |
| 5 | invalid record は取消値を失い、取消優先を実装できない | 解消 | `src/requests/kintone-request-store.ts:96-116`（現状は full parse 失敗時に identity と issues だけを保持）、`src/requests/kintone-request-store.ts:126-141,256-272`（直接終端と identity 読取の差込位置）、`src/requests/request-model.ts:63-79,309-340`（現 parser は文字列型検証後に全体検証） | 最小 envelope parser で `$id/$revision/request_state/cancel_requested` を先に読み、`["取消"]` だけを取消、`[]` を未取消、それ以外を `REQUEST_INVALID` とする。v4 §4:81、§5.1:126 の記述で差込可能。 |
| 6 | one-shot ポーラーでは「連続3周期」を保持できない | 解消 | `src/cli/poll-requests-command.ts:16-40`（1回処理して終了）、`src/requests/request-poller.ts:63-100`（周期内集計のみ） | v4 §4.2:108-110 の「競合ごとに ID 付き警告・閾値なし」で解消。追加修正なし。 |
| 7 | ACCEPTED 終端を次周期へ送れず、現行 `writeResult` の即時再試行とも矛盾 | 解消 | `src/requests/kintone-request-store.ts:192-231`（現行は初回 PUT→競合時再 GET→再 PUT）、`src/requests/request-poller.ts:256-298`（child 完了後は heartbeat loop を抜ける）、`src/requests/request-poller.ts:365-428`（次周期は期限超過 ACCEPTED を、LIVE owner なしの場合だけ STALE 化）、`src/requests/request-poller.ts:349-362`（archive owner は Run Invocation 集合に属さず live owner にならない） | v4 §5.1:128 の同周期2回上限で実装可能。2回目の競合は例外を周期全体へ漏らさず警告して当該要求を残すこと、child 終了後は heartbeat を再開しないことを実装時に固定する。 |
| 8 | Run/audit PUT 応答喪失・lock 解放失敗と repository surface が未定義 | 部分 | `src/persistence/repository.ts:48-53,117-177`（lifecycle 専用更新と audit 読取 surface は未実装）、`src/persistence/kintone/repository.ts:601-615`（現 aggregate PUT は lifecycle を書かない）、`src/persistence/kintone/repository.ts:1017-1049,1092-1138`（監査 create の応答喪失裁定は拡張可能）、`src/persistence/network-lock.ts:277-383`（release 自体にも競合・応答喪失裁定がある） | v4 は単独障害4種を定義したが、早期終了時の解放、Run PUT の明示409/再試行失敗、audit=PENDINGかつlock解放失敗等の複合障害が未定義。全組合せの優先 code と lock release 規則を表にする。 |
| 9 | `RUN_ARCHIVED` 監査の `event_id`・型・応答喪失照合がない | 解消 | `src/domain/persistence-model.ts:150-165,185-225`（既存 audit は event type ごとの型 union）、`src/persistence/in-memory-repository.ts:435-446`（event_id 重複拒否）、`src/persistence/kintone/repository.ts:1017-1049`（`OP:<event_id>` の一意キーと再読取裁定） | v4 §3.3:49-59 で必要識別子と物理格納内容を定めており実装可能。再読取時は event_id だけでなく `run_id/previous_status/run_revision_before` も一致確認するテストを追加する。 |
| 10 | status `hold` は list/detail 両方に必要で、RERUN も hold を見る必要がある | 新矛盾 | `src/orchestration/status.ts:47-58,110-125`（summary 型・builder に追加可能）、`src/orchestration/status.ts:144-178,297-317`（detail/list とも cancel request を取得済み）、`src/requests/request-poller.ts:323-335`（現 RERUN は `activity=STOPPED` のみ） | 本文 §3.4 と §5.2 は解消しているが、受入10が `RELEASED` を `hold` の値として要求し、本文の `REQUESTED｜ACCEPTED｜null` と矛盾する。RELEASED/レコードなしはいずれも `hold=null` と明記し、元の cancel state 別テストとして表現する。 |
| 11 | pending が集約単位で creator code/revision/理由等を保持せず、本人判定できない | 解消 | `plugin/src/request-client.ts:33-39,64-125`（現 Run pending は id/run/state を集約）、`plugin/src/request-client.ts:286-351,377-428`（START は要求配列を持つが revision/creator code等が不足）、`plugin/src/desktop.ts:60-97`（`getLoginUser` 型なし） | v4 §5.1:118-120 の要求単位モデルと `getLoginUser().code` 比較で実装可能。Run/START の2読取経路を同じ pending 型へ正規化し、要求行ごとのボタンを controller/render 境界テストで固定する。 |
| 12 | plugin PUT の `revision` キー・checkbox 配列・固定 payload が未定義 | 解消 | `plugin/src/desktop.ts:79-96,110-130`（現 runtime は GET/POST overload と factory のみ）、`plugin/src/request-client.ts:179-216,227-283`（POST body と builder を型で限定）、`tests/unit/activity-plugin-request.test.mjs:33-82,319-346`（完全一致・単発呼出しの既存境界テスト） | v4 §6:221-229 の固定 builder と完全一致テストで境界を固定できる。追加修正なし。 |
| 13 | CLOSE child classifier がなく、stderr/64 KiB 打切りでは安全に分類できない | 部分 | `src/requests/flownet-child-client.ts:12-22,123-176,263-315`（stdout/打切りフラグを取得可能）、`src/requests/request-result.ts:7-50,108-130,137-157`（run-network は JSON 検証、cancel-run は exit code だけ） | 1行 JSON・専用 client/classifier・truncated fail-closed は実装可能。ただし `run_revision` の失敗時 null 可否、exit 1 の正常意味（ALREADY/PENDING/LOCK_UNRELEASED）、複合状態の code 優先順を discriminated union と完全表で固定する。 |
| 14 | fault-hook が全通信/全書込遮断だけで受入2/8bを順序固定できない | 解消 | `tests/e2e/fault-hook.mjs:15-59,63-79`（現状は host と block mode だけで、method/bodyの一部は観測可能） | v4 受入2/8bと M0 の path/method/body 条件・到達ログ・外部 release barrier 追加で必要な拡張範囲は示された。8b は lock 取得後に必ず到達する heartbeat または node-start 書込を barrier 対象にし、lock 取得成功後であることをログで固定する。 |
| 15 | E2E decoder/terminal 集合と START 履歴が CANCELLED 非対応 | 解消 | `tests/e2e/p2-01-support.mjs:130-155`（decoder に cancel_requested なし）、`tests/e2e/p2-11-support.mjs:23-49`（終端集合は DONE/REJECTED）、`plugin/src/request-client.ts:298-311,609-649`（START 終端表示と履歴は DONE/REJECTED、履歴候補は DONE のみ） | v4 受入12・M0で decoder/終端集合を CANCELLED 対応し、START実績には含めないと決定済み。追加修正なし。 |
| 16 | `reviewRequest` が3分岐で CLOSE を RELEASE 扱いし、CLOSE code 優先順もない | 解消 | `src/requests/request-poller.ts:315-346`（RERUN、STOP、else=RELEASE）、`src/requests/request-model.ts:3-13`（現 union に CLOSE/CANCELLED なし） | v4 §5.2:137 の網羅 switch と §5.3:163-174 の8段判定で実装可能。`RUN_ALREADY_ARCHIVED` は拒否ではなく DONE/NOOP なので、表前文の「最初の code で拒否」だけ「裁定」に直す。 |

## 新規指摘

| # | 対象(節) | 重要度(高/中/低) | 指摘 | 根拠 | 修正案 |
| --- | --- | --- | --- | --- | --- |
| R2-1 | §5.3 手順2〜6、受入8f | 高 | lock 取得後の `finally` が「手順4以降」に限定されている。手順2の `LEASE_INTERRUPTED`、手順3の再検証拒否、`ALREADY_ARCHIVED` は lock を保持したまま終了し得る。また手順4成功後・手順5直前の `tick()` 失敗では Run は既に ARCHIVED なので、受入8fの「LEASE_INTERRUPTED・Run不変」は成立しない。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:188-202,248`。既存 scheduler は monitor を stop してから close/releaseし、finallyでも stopする（`src/orchestration/sequential-scheduler.ts:583-600`）。release は保持中 reference の fence を確認して tombstone 化する（`src/persistence/network-lock.ts:277-325`）。 | 「lock 取得成功後の全経路」を `try/finally` で囲み、`monitor.stop()` 後に releaseする。lease 中断を (a) Run PUT前=`REJECTED/LEASE_INTERRUPTED`、(b) Run PUT後=`DONE/RUN_ARCHIVED_AUDIT_PENDING`（lease中断注記）等へ分け、受入8fも時点別にする。 |
| R2-2 | §5.3 一次審査、手順1、受入8 | 高 | 「同時 CLOSE の後着は必ず LOCK_CONFLICT」は一次審査との間で一意でない。後件が先行の ARCHIVED PUT 後に status を読むと、まだ lock 解放前でも順2で `RUN_ALREADY_ARCHIVED` となり child を起動しない。同一 one-shot に並んだ2要求も逐次処理なので後件は通常この経路になる。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:163-189,192-194,206,243`。現ポーラーは要求を1件ずつ child完了・結果PUTまで処理する（`src/requests/request-poller.ts:81-91`）。 | 受入8を観測点別にする。「両 child の acquire が重なった敗者は LOCK_CONFLICT」「後件一次審査が ARCHIVED を観測した場合は RUN_ALREADY_ARCHIVED」の双方を許容し、それぞれ単体試験を置く。 |
| R2-3 | §5.3 JSON・部分成功表 | 高 | JSON の cross-field 契約と複合障害の code 優先順がない。例: `audit=PENDING` かつ `lock_released=false`、Run PUT 応答喪失後の再 PUT も失敗、ALREADY_ARCHIVED の release 失敗。単独障害表だけでは `DONE/REJECTED` と code を一意に分類できない。さらに lock conflict は Run 再 GET前なので `run_revision` を数値必須にできない。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:180-204`。既存 child 結果には exit/stdout/truncated/spawnError が別々にあり（`src/requests/flownet-child-client.ts:15-22`）、既存 classifier も専用 validator で形を絞る（`src/requests/request-result.ts:7-50,137-157`）。 | archive 出力を outcome ごとの discriminated union にする。各 variant の exit code、nullable項目、要求 state/codeを表にし、複合時は例えば「Run状態不明 > audit pending > lock unreleased」の優先順を固定する。stderr/stdout truncation、spawn error、exit/JSON不一致はすべて `CHILD_RESULT_INVALID` とする。 |
| R2-4 | §3.4、§5.2、受入10 | 高 | 本文では `hold` は active hold（REQUESTED/ACCEPTED）または null だが、受入10は RELEASED を `hold` の値として固定すると読める。JSON schema と受入期待値が矛盾する。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:61-73,134-151,253`。現 activity も cancel state を受けるが終端では activityを付けず（`src/orchestration/status.ts:110-125,168-178`）、list/detail の双方は cancel recordを取得する（同 `151-158,301-317`）。 | `hold` は `{state: REQUESTED|ACCEPTED,...}|null` のままにし、受入10を「cancel state REQUESTED/ACCEPTEDでは非null、RELEASED/レコードなしではnull」に修正する。RELEASED自体も返したいなら field名を `cancel_request` に変えて三状態を型定義する。 |
| R2-5 | §7 受入2/4、§8 M3/M4 | 高 | M3 が受入1〜8fを完了する計画なのに、受入2はボードの再GET文言、受入4はボードの解除要求表示を含み、それらのボード実装は後続M4である。マイルストーン順どおりにはM3の受入を完了できない。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:235-249,255-264`。現 runtime は GET/POSTのみ（`plugin/src/desktop.ts:60-96,121-135`）、現 pending actionも集約1件である（`plugin/src/request-client.ts:64-125`）。 | M3を「CLI/ポーラー/API E2E」に限定してボード観点をM4へ移すか、M4の取消・解除表示とPUTをM3より前へ移す。受入番号ごとに実施 milestone を一意に付ける。 |
| R2-6 | §3.3 監査照合 | 中 | §3.3 は再読取した監査が「一致」なら成功、部分成功表は「存在」すれば成功と表現が揺れる。既存 kintone repository の OperationAudit は event_id 一致だけを同一判定に使っており、誤って同じ event_id で異なる payload が存在しても成功扱いになる。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:49-59,200`。既存同一判定は `found.event_id === value.event_id` のみ（`src/persistence/kintone/repository.ts:1043-1049`）。 | 一致条件を `event_id/run_id/event_type/previous_status/run_revision_before` の完全一致と定義し、不一致は `AUDIT_CONFLICT`（RunはARCHIVED、監査補完要）として fail-closed にする。 |
| R2-7 | §8 M0、受入2/8b | 中 | barrier の停止位置（対象 fetch の送信前か、成功応答後か）が未定義である。「NETWORK_LOCK POST到達」は取得成功を意味しないため、それだけで8bの「lock保持到達」を証明できない。 | 現 hook は fetch 前に modeを読み、ログを書いてから遮断/送信する（`tests/e2e/fault-hook.mjs:27-59`）。仕様は到達ログ+外部releaseのみ（`docs/internal/p2-16-request-lifecycle-v2-spec.md:236,244,259`）。 | barrier に `phase=before|after-success` を持たせるか、8bは acquire後にだけ発生する lease heartbeat/node-start PUTを対象にすると固定する。ログに response status と barrier phase を残す。 |
| R2-8 | 統合仕様 §6.1/§6.7/§7.7、P2-01 G-01〜G-08、§8 M5 | 中 | v4の変更内容自体は、RERUNの active hold拒否（G-02補強）、RELEASEの「CANCEL_REQUESTあり」（G-06）、CLOSE追加、限定PUTという方向で既存不変条件と両立する。しかし現統合仕様とP2-01は旧状態のままで、M5は統合仕様の改訂だけを挙げ、前提正本としたP2-01の改訂を明記していない。P2-01は状態機械も `REQUESTED→ACCEPTED→DONE/REJECTED` のままである。 | `docs/specification.md:673-705,752-783,992-1003`、`docs/internal/p2-01-app-rerun-spec.md:45-60,64-70`、v4 `docs/internal/p2-16-request-lifecycle-v2-spec.md:3-6,259-264`。実装も現状は4 request type/4 state（`src/requests/request-model.ts:3-13`）。 | M5の改訂対象にP2-01を明記し、G-02の hold 判定を status `hold` に、G-06の一次審査を activity ではなく CANCEL_REQUEST に、G-04/G-07に CLOSE JSON の DONE例外を追記する。統合仕様には CANCELLED遷移、CLOSE、追加code、限定PUTを同時反映する。 |

## 統合仕様・P2-01 との整合判定

| 観点 | 判定 | 根拠 |
| --- | --- | --- |
| 統合仕様 §6.1 状態機械 | 改訂すれば整合 | 現在は4状態で CANCELLED がない（`docs/specification.md:673-684`）。v4の REQUESTED→CANCELLED は revision fencing付きの直接終端で、既存 REQUESTED→REJECTED と同じ構造に追加できる（`src/requests/kintone-request-store.ts:126-141`）。 |
| 統合仕様 §6.7 code | 改訂すれば整合 | 現一覧は既存 code まで（`docs/specification.md:752-783`）。v4追加 code は namespace上衝突しないが、R2-3の cross-field/優先順確定後に反映すべきである。 |
| 統合仕様 §7.7 runtime境界 | 改訂すれば整合 | 現在はPUT全面禁止（`docs/specification.md:992-1003`）。v4の単票・revision必須・cancel_requested 1フィールド固定 builder は、既存POST factoryと同様に型境界へ閉じ込められる（`plugin/src/desktop.ts:110-130`）。 |
| P2-01 G-01/G-02 | 整合（文書追補要） | 許可status、ACTIVE、resume可、live owner規則は維持し、active holdの参照元だけを activityから status `hold` へ強化する（`docs/internal/p2-01-app-rerun-spec.md:51-54`、`src/requests/request-poller.ts:321-335`）。 |
| P2-01 G-03 | 整合 | CLOSEも既存RERUN等と同じ allowlist全探索で run_id を一意解決できる（`docs/internal/p2-01-app-rerun-spec.md:58-59`、`src/requests/request-poller.ts:301-312`）。 |
| P2-01 G-04/G-07 | 条件付き整合 | Invocationなしの事前拒否はREJECTED、RunをARCHIVED化できた部分成功はDONEという原則は合理的。ただし v4 JSON の複合障害分類が未確定（R2-3）。既存 run-network classifierは InvocationありをDONE、REJECTED outcomeをREJECTEDにする（`src/requests/request-result.ts:7-49`）。 |
| P2-01 G-05 | 整合 | child終了後に結果PUTを確定できない ACCEPTED は heartbeatが止まり、期限超過かつlive ownerなしでSTALEになる（`src/requests/request-poller.ts:256-298,365-428`）。自動再実行しない意味論も維持される。 |
| P2-01 G-06 | 整合（文書追補要） | 正の条件は元々 CANCEL_REQUESTの REQUESTED/ACCEPTED。v4は終端Runでもその条件を status `hold` で見えるようにするだけで、releaseはRun状態を変えない（`docs/internal/p2-01-app-rerun-spec.md:55`、`src/orchestration/cancel-request.ts:42-53`）。 |
| P2-01 G-08 | 整合 | `archive-run` も `KSQL_FLOWNET_REQUESTED_BY=app-request:<id>:<creator>` を使え、child clientの既存相関生成・環境上書きを流用できる（`src/requests/flownet-child-client.ts:206-219,235-251`）。 |

## 確認済み一覧

- DRAFT v4 本文 §1〜§11 と、第1巡レビュー16件を全件照合した。
- Network lock の acquire/heartbeat/release、`LeaseMonitor`、run-networkからschedulerへの monitor 引渡しを確認した。
- request store の `listRequested` / `readIdentity` / `rejectInvalid` / `writeResult` と、poller の heartbeat・STALE回収・一次審査順を確認した。
- archive用に拡張対象となる repository interface、kintone aggregate PUT、OperationAudit union・一意キー裁定を確認した。
- child client の64 KiB制限、stdout JSON parse、run-network/cancel-run classifierを確認した。
- plugin のRun/START pendingモデル、runtime GET/POST境界、要求body境界テストを確認した。
- status list/detail の cancel record取得、CLI STOPの終端拒否、fault-hook、P2-01/P2-11 E2E decoder・terminal集合を確認した。
- 統合仕様 §6.1/§6.7/§7.7 と P2-01 G-01〜G-08を確認した。

## 未確認事項

- DRAFT仕様の再レビューであり、v4機能は未実装のため、受入1〜12の実行結果は未確認。
- kintone実機で「作成者」をフィールドアクセス権の編集主体に指定できるか（U-4）は未確認。
- 追加予定の `archive-run` JSON、lifecycle専用repository method、RUN_ARCHIVED監査serializer、plugin PUT builder、拡張fault-hookは未実装のため動作未確認。
- ブラウザ上の取消ダイアログ、409/通信断後の再GET文言、要求単位複数行UIは未確認。
- コード変更を伴うテストは実施していない。本レビューは既存コード・既存テストの静的照合である。
