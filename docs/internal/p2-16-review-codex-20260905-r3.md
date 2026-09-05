# P2-16 操作要求ライフサイクル v2 仕様 第3巡レビュー（Codex・2026-09-05）

## 総評

DRAFT v5 は、第2巡の lease 時点別裁定、全経路 `finally`、同時 CLOSE の観測点分離、`hold` 契約、監査5項目照合、barrier、正本文書の改訂対象を概ね解消した。
`LeaseMonitor` と `NetworkLockManager.release()` の現行契約でも、手順2・6の処理順は実装可能であり、監査5項目も `reason` JSON を実際に復号すれば再読取照合できる。
ただし、`audit=PENDING` かつ lock 解放失敗時の一次 code が JSON 表と優先順位・受入8fで逆転し、さらに lock取得・Run再取得・Run PUT の一部失敗経路が outcome 表に閉じていない。受入12も「Mは1つ」としながら M3/M4 の2つを持つ。
中核設計の変更は不要だが、下記4条件を仕様本文へ反映するまでは、結果分類と実施時点を一意に固定できない。

**FROZEN 可否: 条件付き可**

凍結条件（いずれも仕様本文の文言・表修正のみ）:

1. §5.3 の `ARCHIVED + audit:PENDING + lock_released:false` を、優先順位および受入8f⑥と同じ `DONE / RUN_ARCHIVED_AUDIT_PENDING` に統一する。
2. §5.3 の outcome 表を閉じた集合にし、少なくとも lock取得の `LOCK_UNAVAILABLE`、手順3の再取得不能、手順4 PUT の明示非409失敗、および「再GET成功・ACTIVE確認後の再PUT失敗」を outcome・exit・要求 state/code のいずれか1行へ割り当てる。`REJECTED` の code 欄の `…` は廃止する。
3. 受入12を decoder/terminal の M3 とボード履歴の M4 に分割し、「各受入の M は1つ」という §7 冒頭と一致させる。
4. §3.3 の物理格納表に `resolved_at = archived_at`（または採用する別の明示値）を追加し、既存 `appendOperationAudit()` の event type 別日時欄を一意にする。

## 第2巡残件・新規8件の解消判定

| # | 指摘(要約) | v5 の判定 | 根拠(実装ファイル:行) | 残る修正案 |
| --- | --- | --- | --- | --- |
| #2残 | `archive-run` の heartbeat・書込前 fence・lease 失効時の状態別中断 | 解消 | `src/persistence/network-lock.ts:480-489,524-565,569-580`（monitor は manager/reference だけで構成でき、`tick()` は heartbeat/fence 成否を boolean で返す）、`src/cli/run-network-command.ts:422-455`（定義の lease/heartbeat 値で生成可能） | §5.3:195 の手順4前/後の分離で実装可能。追加修正なし。 |
| #3残 / R2-2 | 同時 CLOSE 後着は `LOCK_CONFLICT` と `RUN_ALREADY_ARCHIVED` の両経路を持つ | 解消 | `src/persistence/network-lock.ts:145-166,190-208`（重なった acquire の敗者は `LOCK_CONFLICT`）、`src/requests/request-poller.ts:81-91`（要求は child 完了・結果PUTまで逐次処理） | §5.3:213、受入8の観測点別2経路で一意化済み。追加修正なし。 |
| #8残 / R2-3 | outcome 別 JSON、複合障害の優先順、nullable 項目、全終了経路 | **部分** | `src/persistence/network-lock.ts:177-214`（acquire は `LOCK_CONFLICT` 以外に `LOCK_UNAVAILABLE` を返す）、同 `218-274`（heartbeat の複数失敗 code）、`src/persistence/network-lock.ts:277-383`（release は応答喪失・409再試行・fence不一致を持つ）、`src/requests/flownet-child-client.ts:15-22`（exit/output/truncated/spawnError は独立） | §5.3:186 は audit PENDING でも `RUN_ARCHIVED_LOCK_UNRELEASED`、§5.3:191/209・受入8f⑥は `RUN_ARCHIVED_AUDIT_PENDING` で矛盾する。また手順1・3・4の一部失敗が表外。凍結条件1・2のとおり修正する。 |
| #13残 | `archive-run` の exit 1 の正常意味と classifier 契約 | **部分** | `src/requests/request-result.ts:7-50,137-157`（既存 classifier は専用 shape 検証後に分類）、`src/requests/flownet-child-client.ts:12-22`（64 KiB打切りと spawn error を別保持） | 列挙済みの PENDING/UNRELEASED/UNCONFIRMED/REJECTED は exit 1 に固定された。一方 `REJECTED` code が `…` で開いており、表外の正規失敗と不正JSONを分離できない。凍結条件2の閉じた union にする。 |
| #10 / R2-4 | status `hold` に RELEASED を返すかの矛盾 | 解消 | `src/orchestration/status.ts:144-178,297-317`（detail/list とも cancel record を取得済み）、`src/orchestration/status.ts:110-125`（共通 summary builder への追加位置） | §3.4:72 と受入10が、REQUESTED/ACCEPTEDのみ非null、RELEASED/なしはnullで一致。追加修正なし。 |
| #7補足 | ACCEPTED 終端の2回目失敗を周期外へ漏らさず、heartbeat を再開しない | 解消 | `src/requests/kintone-request-store.ts:192-231`（現行の初回PUT→競合時再GET→再PUT）、`src/requests/request-poller.ts:256-298`（child 完了時に heartbeat loop を抜ける） | §5.1:128 と受入4bに `RESULT_FINALIZE_ABANDONED`・次要求継続・heartbeat非再開を明記済み。追加修正なし。 |
| #9補足 / R2-6 | 監査応答喪失時の「存在」と「完全一致」の揺れ | 解消 | `src/persistence/kintone/repository.ts:1020-1035`（`event_id` 一意キー、監査値全体を `reason` JSON に格納）、同 `1092-1127`（create失敗後に保存レコードを再読取可能）、同 `1043-1049`（現行 comparator は event_id のみで、archive実装では強化が必要） | §3.3:59 と§5.3:206が5項目完全一致、不一致=`AUDIT_CONFLICT`で一致。実装時は現行の `() => value` ではなく再読取した `reason` を復号して比較する。これは仕様に既に要求された実装差分で、追加凍結条件にはしない。 |
| #16補足 | CLOSE 判定順表の「最初の code で拒否」が DONE/NOOP と矛盾 | 解消 | `src/requests/request-poller.ts:315-346`（現行3分岐を網羅 switch へ置換する必要）、`src/requests/request-model.ts:3-13`（現行 union は CLOSE/CANCELLED 未追加） | §5.3:163 が「裁定、順2はDONE/NOOP」と明記。追加修正なし。 |
| R2-1 | lock取得後の全経路で `stop()`→`release()`、lease中断を手順4前後で分離 | 解消 | `src/orchestration/sequential-scheduler.ts:583-600`（既存順序は stop 後 close、finallyでも stop）、`src/persistence/network-lock.ts:277-325`（release は保持 reference を fence 確認して tombstone 化） | §5.3:195,199 と受入8f①②⑦で解消。`stop()` は timer を止めるだけだが、release は heartbeat 起因の1回の revision 前進を再読取して再試行できる（同 `327-373`）ため実装可能。 |
| R2-5 | 受入表の M 列と §8 の実装順、ボード依存の分離 | **部分** | `plugin/src/desktop.ts:60-96,110-130`（現 runtime はGET/POSTのみ）、`plugin/src/request-client.ts:64-125`（現 pending は要求単位でない） | 2a/2b/4a/6a は M4、CLI/ポーラー/API E2E は M3へ分離され、§8:273-276と整合する。ただし受入12だけが M3/M4の2値で§7:240「Mを1つ」に反する。凍結条件3のとおり2行へ分割する。 |
| R2-7 | fault-hook barrier の before/after-success と取得成功の証明 | 解消 | `tests/e2e/fault-hook.mjs:27-59`（現 hook は送信前ログと遮断のみ）、`src/persistence/network-lock.ts:218-237`（取得後 heartbeat は PUT） | §8 M0に phase/response status、受入8bに取得後だけ発生する heartbeat/node-start の after-success を固定済み。追加修正なし。 |
| R2-8 | M5 の改訂対象に P2-01 を含める | 解消 | `docs/specification.md:673-684,699-705,752-784`（現正本は CANCELLED/CLOSE/追加code未反映）、`docs/internal/p2-01-app-rerun-spec.md:47-60`（現状態機械・G-02/G-04/G-06/G-07は旧契約） | §8:277 が統合仕様とP2-01の具体的改訂箇所を列挙。追加修正なし。 |

## v5で確認した新規指摘

| # | 対象(節) | 重要度 | 指摘 | 根拠 | 修正案 |
| --- | --- | --- | --- | --- | --- |
| R3-1 | §5.3 outcome 表・複合障害優先順・受入8f | 高 | `ARCHIVED`・`audit=PENDING`・`lock_released=false` は JSON 表の2行目では `lock_released=true` 条件に入らず、3行目で `RUN_ARCHIVED_LOCK_UNRELEASED` になる。一方、直後の優先順と受入8f⑥は監査未確定を優先して `RUN_ARCHIVED_AUDIT_PENDING` とするため、三者が不一致。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:185-191,209,261`。classifier が検証済みJSONの値で結果を一意に作る既存方式は `src/requests/request-result.ts:7-50,137-157`。 | JSON 表3行目を audit RECORDED に限定し、audit PENDING + lock false は2行目相当の別行として `RUN_ARCHIVED_AUDIT_PENDING`、解放失敗は message 併記に固定する。 |
| R3-2 | §5.3 手順1・3・4、outcome 表、一次対応 code | 高 | outcome 表は全終了経路を網羅していない。少なくとも acquire の `LOCK_UNAVAILABLE`、lock内の Run再取得不能、Run PUT の明示非409失敗、応答喪失後に再GETでACTIVEを確認した後の再PUT失敗に outcome/code がない。`REJECTED` の `…` では閉じた discriminated union にならず、正規失敗と `CHILD_RESULT_INVALID` を完全一致で区別できない。 | `src/persistence/network-lock.ts:177-214`（acquire の `LOCK_UNAVAILABLE`）、`src/persistence/repository.ts:117-142`（Run GET/更新の Promise 境界）、`src/persistence/kintone/repository.ts:601-615,1163-1199`（更新PUTは通信・APIエラーを上位へ返し、暗黙の成功にはしない）、`src/requests/flownet-child-client.ts:15-22`（process失敗情報）。仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:182-191,193-209,219`。 | 各経路を「Run不変が確認済み」「Run状態不明」に分け、前者は閉じた REJECTED code、後者は UNCONFIRMED へ割り当てる。一次対応一覧にも新codeを追加する。 |
| R3-3 | §7 受入12・§8 M0/M3/M4 | 中 | §7は各受入がMを1つ持つと宣言するが、受入12は `M3(decoder)/M4(ボード)` の2つを持つ。また decoder/terminal 集合の実装自体はM0、E2E確認はM3であり、「実装」と「受入」の時点も1行内で混ざる。 | 仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:240,264,272,275-276`。現 decoder/terminal対応前の型は `src/requests/request-model.ts:3-13`、現ボード履歴側の要求モデルは `plugin/src/request-client.ts:64-125`。 | 受入12を「12: decoder/terminalのE2E=M3」と「12a: ボード履歴からCANCELLED除外=M4」に分ける。M0はハーネス実装のままでよい。 |
| R3-4 | §3.3 監査物理格納 | 中 | 新しい `RUN_ARCHIVED` の日時を既存物理列 `resolved_at` に何から格納するかが未定義。現 serializer は既存3種を event type で分岐し、最後は `released_at` を参照するため、unionへ型を足すだけでは `RunArchivedOperationAudit` を処理できない。 | `src/persistence/kintone/repository.ts:1021-1041`、`src/domain/persistence-model.ts:150-225`。仕様の格納表は `docs/internal/p2-16-request-lifecycle-v2-spec.md:49-59`。 | 格納表に `resolved_at = archived_at` を追加し、serializer/decoder双方の契約を固定する。 |
| R3-5 | §5.3 `ALREADY_ARCHIVED` / `REJECTED` の解放失敗 | 低 | 1行に `lock_released=true/false`、exit 0/1、一次code 2種を併記しており、表の「1 variant = 1組合せ」という読みやすさは崩れる。また、archive前の再検証拒否で解放に失敗した際に、名称上 Run archived を断定する `RUN_ARCHIVED_LOCK_UNRELEASED` を message に併記するのは紛らわしい。一次code自体は元の拒否codeなので実装不能ではない。 | `src/persistence/network-lock.ts:277-383`（release失敗はarchive成否と独立）。仕様 `docs/internal/p2-16-request-lifecycle-v2-spec.md:187-189,208`。 | true/falseを別行に分ける。archive前拒否の付記は機械codeではなく `lock_release_failed=true` 等、Run状態を断定しない文言にする。**実装時判断でも吸収可能なため凍結条件には含めない**。 |

## outcome・部分成功・一次対応 code の整合確認

| 観点 | 判定 | 確認結果 |
| --- | --- | --- |
| outcome 行の排他性 | 概ね可 | `outcome` と `audit`、`lock_released` により列挙済み行は分離できる。ALREADY/REJECTEDのtrue/false併記は分割推奨だが実装可能。 |
| outcome 行の網羅性 | 不足 | R3-2の4系統が未割当で、`…` は schema/classifier の閉じた列挙にならない。 |
| 部分成功表との一致 | 不一致1件 | audit PENDING + lock false の一次codeだけが R3-1 のとおり逆転する。 |
| 一次対応 code 一覧との一致 | 部分 | 列挙済み outcome の代表codeは§5.3:219にあるが、R3-2の未割当経路のcodeは当然なく、`LOCK_UNAVAILABLE` もない。 |

## 確認済み一覧

- DRAFT v5 全文、とくに §3.3、§3.4、§5.1〜§5.3、§7、§8、§11 v5 採否表を行単位で確認した。
- 第1巡16件および第2巡の残件・新規8件の原文を確認し、v5の反映箇所を対応付けた。
- `NetworkLockManager.acquire()` / `heartbeat()` / `release()` の競合・応答喪失・fence契約、および `LeaseMonitor.start()` / `tick()` / `stop()` の状態遷移を確認した。
- run-network が定義値から monitor を構築して scheduler へ渡す経路、scheduler の stop/finally 順序を確認した。
- repository interface、kintone Run aggregate PUT、OperationAudit の型 union・`reason` JSON格納・create応答喪失後の再読取を確認した。
- ポーラーの逐次処理、child heartbeat終了点、現行 result classifier、64 KiB打切り/spawn error境界を確認した。
- status list/detail の cancel request 読取、ボード runtime/pendingモデル、fault-hook、統合仕様、P2-01の現行差分を確認した。
- コード・既存文書は変更していない。作成したのは本レビュー1ファイルのみ。

## 未確認事項

- 実装前仕様の凍結レビューであり、v5対応コード・単体テスト・E2Eはまだ存在しないため実行していない。
- kintone実機のフィールドアクセス権（U-4）と拡張後fault-hookの実動作はM0事項であり未確認。
- `run_revision` を各 outcome で「更新前/更新後/観測時」のどれとして返すかは classifier の安全性を変えない細部であり、**実装時判断**とした。
