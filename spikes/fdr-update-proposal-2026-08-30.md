# FDR更新提案書（2026-08-30 第5弾、D-24クローズとM3実機発見）

> **正本ではない。承認後に`docs/internal/phase1-freeze-decision-record.md`へ反映する。** 本提案では`docs/`を変更しない。

反映状態: REFLECTED(2026-08-30、選択肢(a)承認)

## 1. 提案の要約

| 判断              | 提案する扱い                                                                                                                      | Superseded                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| D-24              | `PROPOSED`から`DECIDED`へ変更。S1/A1/R1 vector、revision採番、採番競合裁定、二重書込みの修復／停止、lease fencingの実測記録を追記 | なし。既存プロトコルを実測で確定する追記                  |
| D-10              | R1（Network Run identity key）をN1/J1/S1/A1のキーファミリへ追加                                                                   | なし。N1/J1の判断を置換せず拡張する追記                   |
| D-11              | 並行`updateKey` PUTの敗者が409 `GAIA_CO02`または400 `GAIA_DA02`となる非決定性と再GET裁定を追記                                    | なし。既存の「400応答だけで断定しない」原則を補強する追記 |
| D-12 / bundle契約 | uploadで得た`fileKey`の単回性と、2回目の添付が404 `GAIA_BL01`となる実測事実を追記                                                 | なし。保持・archive判断を置換しないプロトコル前提の追記   |

今回の提案に、削除または置換される旧判断はない。すべて追記であり、`Superseded`はない。

## 2. ADR §11に基づくM3実機記録

### 2.1 コマンド、環境、回数

- 実施日: 2026-08-30（JST）
- 環境: `LAPTOP5` / `win32` / Node.js `v24.14.0` / `devenxyfi.cybozu.com`
- 実行コマンド:

```powershell
node --env-file=.env tests/integration/m3-run-uniqueness.mjs
node --env-file=.env tests/integration/m3-attempt-numbering.mjs
node --env-file=.env tests/integration/m3-write-failure-recovery.mjs
node --env-file=.env tests/integration/m3-canonical-key-conflict.mjs
node --env-file=.env tests/integration/m3-lease-heartbeat.mjs
node --env-file=.env tests/integration/m3-heartbeat-drain.mjs
node --env-file=.env tests/integration/m3-cleanup.mjs
```

- 最終公式フルラン: 上記6ゲートとcleanupを各1回、計7実行。すべてexit 0かつ`passed: true`
- 公式証跡: `docs/internal/test-results/m3-gate-20260830/2026-08-30T03-46-57.641Z-m3-run-uniqueness.json`から`2026-08-30T03-47-26.691Z-m3-cleanup.json`までの時系列7件
- ディレクトリ全体: JSON 25件。最終公式7件以外の18件は途中経過であり、設計ギャップ検出、試験修正、競合応答の反復観測にだけ使用する。25件全体では`passed: true`が23件、`passed: false`が2件である

結果は上記検証環境での実測であり、kintoneの公式保証を意味しない。

### 2.2 最終公式フルランの結果

| ゲート               | 公式証跡                                                  | 主な結果                                                                                                                                 |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Run一意性            | `2026-08-30T03-46-57.641Z-m3-run-uniqueness.json`         | 並行2件の一方が成功、他方が`DUPLICATE_RECORD`（原因400 `CB_VA01`）、永続Run 1件                                                          |
| attempt採番          | `2026-08-30T03-47-04.988Z-m3-attempt-numbering.json`      | 並行2件の一方が成功、他方が`ATTEMPT_NUMBER_CONFLICT`。確定番号は1、2、3、最終`latest_attempt_no = 3`                                     |
| 二重書込み修復／停止 | `2026-08-30T03-47-14.045Z-m3-write-failure-recovery.json` | terminal AttemptからNode Stateを修復し集約更新。terminal State + RUNNING Attemptは`RECONCILIATION_REQUIRED`で停止。誤ったRun集約を再計算 |
| canonical key・競合  | `2026-08-30T03-47-15.876Z-m3-canonical-key-conflict.json` | record vector 14件、lock vector 9件が一致。並行PUTの敗者を400 `GAIA_DA02`から再GET裁定し`REVISION_CONFLICT`、Node State永続1件           |
| lease・heartbeat     | `2026-08-30T03-47-22.195Z-m3-lease-heartbeat.json`        | heartbeat 3回でrevision 2→3→4。旧token更新を`LEASE_TOKEN_MISMATCH`で拒否                                                                 |
| heartbeat drain      | `2026-08-30T03-47-26.126Z-m3-heartbeat-drain.json`        | 一時断回復時のみfinal write 1件。再更新不能時は新規Node 0・final write 0・状態を書かず`LEASE_UNCERTAIN`                                  |
| cleanup              | `2026-08-30T03-47-26.691Z-m3-cleanup.json`                | 残存対象0件、exit 0、`passed: true`                                                                                                      |

## 3. D-24を`DECIDED`とする追記案

### 3.1 提案本文

2026-08-30のM3統合試験で、採番・canonical record key・集約更新プロトコルを実kintone環境で検証した。

当初の`record_key = RUN:<run_id>`はRun IDだけに一意性を与えるため、同一`profile + network_id + business_key`で異なる`run_id`を持つRunが並行作成されると、重複禁止裁定が働かず2件とも永続化された。この設計ギャップを受け、Run identityを次のR1 canonical keyへ修正した。

```text
R1:<base64url-no-padding(SHA-256(
  "R1" + NUL + NFC(profile) + NUL + NFC(network_id) + NUL + NFC(business_key)
))>
```

R1はprefix 3文字とpaddingなしSHA-256 base64url 43文字の計46文字である。`tests/fixtures/canonical-record-key/vectors.json`にR1/S1/A1の固定vectorを置き、`tests/fixtures/canonical-lock-key/vectors.json`のN1/J1と合わせ、最終公式`m3-canonical-key-conflict`で有効vector全23件（record 14件、lock 9件）がexpected keyと一致した。R1修正後の並行`createRun`は、一方が成功し、他方が`DUPLICATE_RECORD`、同一business identityの永続Runは1件となった。

attempt番号はNode Stateの`latest_attempt_no + 1`から候補を作り、A1 `attempt_key`の重複禁止INSERTを最終裁定とする。並行`createAttempt`で一方だけが成功し、敗者は`ATTEMPT_NUMBER_CONFLICT`となった。続く採番は1、2、3で、重複・再利用は0件だった。

二重書込みについては、(1) terminal Attempt成功後にNode State更新が欠けた状態を修復し、その後にRun集約を再計算する経路、(2) terminal Node StateにRUNNING Attemptが残る一意に確定不能な状態を`RECONCILIATION_REQUIRED`で停止する経路、(3) Node State集合と不一致のRun集約を再計算する経路が合格した。修復できる状態だけをrevision付きで修復し、確定不能時はfail-closedを維持する。

以上によりD-24を`PROPOSED`から`DECIDED`へ変更する案を提示する。既存の「revision採番、canonical key、単一Invocation集約更新」を撤回せず、実測結果で確定するため、Supersededはない。

### 3.2 単一更新主体の限定条件

「集約状態の単一更新主体はNetworkロックを保持するInvocationのみ」という防御の基礎は、lock再取得後に旧`lease_token`を持つownerの更新が製品コードで`LEASE_TOKEN_MISMATCH`となることを実機確認した。heartbeatは3回成功し、lock revisionは2、3、4へ前進した。

ただし、今回確認したのはrepository／lease fencingとreconciliationの境界である。schedulerから全Node State読取り、集約計算、Run更新までを一つのInvocation所有権の下で結ぶ**Invocation全体の配線検証はM5（FN-10）で完了する**。この限定はD-24を`DECIDED`とする判断と分離せず、FDR本文および凍結ゲート注記に残す。

### 3.3 凍結ゲートの選択肢

D-24の状態は`DECIDED`化を提案し、§12のチェック可否だけを次の2案からユーザー判断に委ねる。

| 選択肢                     | 凍結ゲート       | 扱い                                                                                                                         |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **(a) 限定付きチェック案** | D-24をチェック   | revision採番、S1/A1/R1、競合裁定、修復／停止、lease fencingはM3で合格。Invocation全体の配線はM5（FN-10）で完了する限定を明記 |
| (b) M5まで未チェック案     | 未チェックを維持 | D-24は`DECIDED`とするが、単一更新主体のInvocation全体配線をM5で確認するまで凍結ゲートを閉じない                              |

(a)を選ぶ場合のゲート文案:

> [x] D-24: revision採番、S1/A1/R1 canonical key、採番競合裁定、二重書込みの決定的修復／停止、および旧lease tokenの更新拒否を2026-08-30のM3実機試験で確認。集約状態の単一更新主体について、lease fencingは確認済みだがInvocation全体の配線はM5（FN-10）で完了する限定付き。

(b)を選ぶ場合は現行の未チェックを維持し、同じM3実測記録とM5後続ゲートをD-24節へ追記する。

## 4. D-10へのR1追加案

D-10のversion付きcanonical keyファミリを、lock identityのN1/J1から、永続record identityのS1/A1/R1まで明示的に拡張する。R1はNetwork Run identityであり、canonical inputは`R1\0NFC(profile)\0NFC(network_id)\0NFC(business_key)`、出力は46文字である。S1はNode State、A1はNode Attemptを識別する。

これはN1/J1を置き換える判断ではない。N1/J1はlock identity、S1/A1/R1はrecord identityとして併存する。R1追加にSupersededはない。

## 5. D-11への並行PUT観測追記案

同一revisionを使った2本の並行`updateKey` PUTでは、敗者応答は決定的ではなかった。反復中に409 `GAIA_CO02`と400 `GAIA_DA02`の両方を実測した。途中経過`2026-08-30T03-46-02.704Z-m3-canonical-key-conflict.json`は409 `GAIA_CO02`、最終公式`2026-08-30T03-47-15.876Z-m3-canonical-key-conflict.json`は400 `GAIA_DA02`を記録する。

`GAIA_DA02`の実メッセージは次のとおりである。

> Failed to save the changes because the database could not be locked. Please wait a while and try again.

GAIA_DA02はDBロック競合の一時エラーでありretryableな性格を持つ。ただし、製品は400だけでrevision競合と断定したり、無条件に再PUTしたりしない。同じrecordを再GETし、revision前進を確認できた場合だけ`REVISION_CONFLICT`と裁定する。対象消失、再GET失敗、または確認不能時はremote errorとしてfail-closedにする。逐次実行で意図的に古いrevisionをPUTした経路は、実測上常に409 `GAIA_CO02`だった。

これはD-11の既存原則「400応答だけで競合と断定しない」の新しい実例であり、Supersededはない。`src/persistence/kintone/design-notes.ts`の`UPDATE_KEY_DA02_REQUIRES_REREAD`とも一致する。

## 6. D-12 / bundle添付契約への追記案

`POST /k/v1/file.json`でuploadした`fileKey`は1回限りであり、同じ`fileKey`を2回目のレコード添付に使用すると404 `GAIA_BL01`となった。したがってFN-07のbundle添付プロトコルは、添付操作ごとに新しいuploadを行い、新しい`fileKey`を消費することを前提とする。同一bundle bytesを再添付するときも、過去のupload `fileKey`を再利用しない。

これはbundle容量、保持期間、archive、復元の運用判断を閉じるものではない。D-12は`OPERATIONS_REQUIRED`を維持し、bundle添付プロトコルの前提だけを追記する。Supersededはない。

## 7. 実装計画 §4 M3完了ゲートとの対応

`docs/internal/implementation-plan.md`自体は変更しない。

| M3完了ゲート                                                                                  | 実機結果との対応                                                                                       | 公式証跡                                       | 判定・残余                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| 同一`profile + network_id + business_key`のRunを重複作成できない                              | R1修正後、並行2件の一方だけ成功、敗者`DUPLICATE_RECORD`、永続1件                                       | `03-46-57.641Z-m3-run-uniqueness.json`         | 合格                                                                  |
| attempt番号を重複または再利用しない                                                           | 並行createの一方だけ成功、敗者`ATTEMPT_NUMBER_CONFLICT`。番号1、2、3、重複・再利用0                    | `03-47-04.988Z-m3-attempt-numbering.json`      | 合格                                                                  |
| 二重書込みの各障害点から決定論的に修復または停止できる                                        | terminal Attempt→State修復、集約再計算、一意に確定不能なState/Attempt不整合は`RECONCILIATION_REQUIRED` | `03-47-14.045Z-m3-write-failure-recovery.json` | M3対象分岐は合格。未知状態は引き続きfail-closed                       |
| Network lock、Node State、Attemptのcanonical keyがvectorと一致しrepository競合試験が通る      | N1/J1 9件、S1/A1/R1 14件の計23件一致。重複INSERT裁定と並行revision競合も合格                           | `03-47-15.876Z-m3-canonical-key-conflict.json` | 合格                                                                  |
| 正常な長時間Runでheartbeatが継続し、旧token owner更新を拒否する                               | heartbeat 3回、revision 2→3→4。旧tokenを`LEASE_TOKEN_MISMATCH`で拒否                                   | `03-47-22.195Z-m3-lease-heartbeat.json`        | M3の実機範囲は合格                                                    |
| heartbeat一時断では新規Nodeを開始せず、実行中処理を原則killせず、再更新不能時は状態を書かない | 回復分岐はin-flight完了後final write 1、未回復分岐は新規Node 0・final write 0・`LEASE_UNCERTAIN`       | `03-47-26.126Z-m3-heartbeat-drain.json`        | fake executor範囲は合格。実kSQL-Flow subprocess E2Eは実装計画どおりM7 |

## 8. 証跡の範囲と残余リスク

1. 集約状態の単一更新主体をInvocation全体で結ぶ配線はM5（FN-10）で検証する。M3ではlease fencingとrepository境界までを確認した。
2. drainはfake executorによる状態遷移試験である。実kSQL-Flow subprocessを使うE2EはM7に残る。
3. 今回は単一端末`LAPTOP5`からの実行であり、複数ホスト・高並列・実ネットワーク分断は未実測である。
4. 25件のJSONは最終状態と主要観測を保持するが、修正前`RUN:<run_id>`でRunが2件作成されたraw結果、逐次stale revisionの全反復、upload `fileKey`の2回目添付は専用フィールドとして収録していない。本提案ではM3実施時に確定した実測事実として記録し、JSONに存在する値であるかのような件数やscopeを補完しない。R1の確定後契約は`design-notes.ts`と最終公式JSONで照合できる。
5. `GAIA_DA02`は一時エラーの性格を持つが、再GETでrevision前進を確認できない場合の自動再試行は認めずfail-closedを維持する。
6. `fileKey`単回性の追記はFN-07の実装前提であり、D-12の保持・archive・復元・責任者・権限の運用判断は未完了のままである。

## 9. 承認事項

ユーザーはD-24を`DECIDED`へ変更したうえで、凍結ゲートについて次のいずれかを選択する。

- **(a) 限定付きチェック:** M3の実測範囲でD-24ゲートを閉じ、Invocation全体配線をM5（FN-10）の明示的な後続ゲートとする
- **(b) M5まで未チェック:** D-24本文は`DECIDED`へ変更するが、Invocation全体配線の合格まで凍結ゲートを未チェックに保つ

いずれの場合も、D-10へのR1追加、D-11への並行PUT観測、D-12 / bundle契約への`fileKey`単回性を追記し、Supersededなしとする。
