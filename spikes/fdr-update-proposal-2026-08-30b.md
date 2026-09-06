# FDR更新提案書（2026-08-30 第6弾、M5ゲート判定とD-24限定解除）

> **正本ではない。承認後に`docs/internal/phase1-freeze-decision-record.md`へ反映する。** 本提案では`docs/`を変更しない。

反映状態: REFLECTED(2026-08-30)

## 1. 提案の要約

| 判断                     | 提案する扱い                                                                                                                                                               | Superseded |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| M5完了ゲート             | 実kSQL-Flow v0.7.0を使う公式6件とexe経路2件は全件合格。実装ゲートは**限定付き合格**とし、完全SUCCESSのdiamond単独実行をM7受入で補完する                                    | なし       |
| D-24                     | FN-10のlease fencing配線と受入19相当ユニットテスト、およびM5実機での自Invocationによる集約更新成立を根拠に、「集約単一主体のInvocation配線はM5で検証」の限定条件を解除する | なし       |
| D-22またはD-24運用ノート | kintone DATETIMEの分精度値を同一分内イベントの順序判定へ使わない。順序は`$id`または業務連番で判定する                                                                      | なし       |

既存判断の削除・置換はない。今回の提案に`Superseded`はない。

## 2. ADR §11に基づくM5実機記録

### 2.1 コマンド、環境、回数

- 実施日: 2026-08-30（JST）
- 環境: `LAPTOP5` / Windows / Node.js `v24.14.0` / `<subdomain>.cybozu.com`
- Execution Plane: 実kSQL-Flow v0.7.0
- node経路: `node.exe` + `C:\Users\rex02\Projects\ksql-flow\dist\cli.js`
- exe経路: 再ビルド後の`dist-bin\ksql-flow.exe`単体起動。旧版exeを検出したため再ビルドし、SHA-256照合済み。hash値自体は8件の公式JSONへ収録されていないため、本提案では値を補完しない
- FlowNet E2Eコマンド:

```powershell
$env:KSQL_FLOW_BIN = 'node.exe'
$env:KSQL_FLOW_BIN_ARGS = '["C:\\Users\\rex02\\Projects\\ksql-flow\\dist\\cli.js"]'
node tests\e2e\m5-serial-success.mjs
node tests\e2e\m5-mid-failure.mjs
node tests\e2e\m5-resume.mjs
node tests\e2e\m5-lock-conflict.mjs
node tests\e2e\m5-kill-unknown.mjs --confirmed-by $env:USERNAME
node tests\e2e\m5-cleanup.mjs

$env:KSQL_FLOW_BIN = 'C:\Users\rex02\Projects\ksql-flow\dist-bin\ksql-flow.exe'
Remove-Item Env:KSQL_FLOW_BIN_ARGS -ErrorAction SilentlyContinue
node tests\e2e\m5-serial-success.mjs
node tests\e2e\m5-cleanup.mjs
```

- 回数: 公式通し6件を各1回、exe経路2件を各1回、計8実行
- 結果: 8件すべて`passed: true`。公式通しはゲート5シナリオとcleanup、exe経路は3ノード直列SUCCESSとcleanup
- 公式証跡: `docs/internal/test-results/m5-gate-20260830/*.json`の時系列8件
- cleanup: 公式・exeの最終cleanupはいずれも残存state/audit/ローカル作業ディレクトリ0。kSQL-Flow所有のJOBログapp 4249は`NOT_DELETED`

結果は上記検証環境での実測であり、kintoneまたはWindowsの公式保証を意味しない。

### 2.2 公式証跡8件

| 経路                 | 証跡                                              | 主な結果                                                                                                                                                                |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node + `dist/cli.js` | `2026-08-30T10-09-55.220Z-m5-serial-success.json` | exit 0。Run/Invocationと3 Node/Attemptが`SUCCESS`。JOBログ3件のcorrelation/attempt/execution/job IDが一致                                                               |
| node + `dist/cli.js` | `2026-08-30T10-10-17.922Z-m5-mid-failure.json`    | exit 1。n1 `SUCCESS`、n2 `FAILED / ASSERT_FAILED`、n3 `BLOCKED`、Run `FAILED`                                                                                           |
| node + `dist/cli.js` | `2026-08-30T10-10-33.406Z-m5-resume.json`         | NEW/RESUMEともexit 1。同一Runでn1 Attempt 1を保持し、n2だけattempt 2へ進み再度`ASSERT_FAILED`、n3 `BLOCKED`                                                             |
| node + `dist/cli.js` | `2026-08-30T10-10-58.561Z-m5-lock-conflict.json`  | standaloneを先行。n1 Attempt 1を`CANCELLED / PREPARE_FAILED`としてStateを`WAITING`へ戻し、独立n2は`SUCCESS`。standaloneはexit 0、読取810件、API 65回                    |
| node + `dist/cli.js` | `2026-08-30T10-11-11.338Z-m5-kill-unknown.json`   | 耐久RUNNINGログ確認後にPID 15716をkill。n1 Attempt/State `UNKNOWN / NO_EXECUTION_RESULT`、独立n2 `SUCCESS`、n3 `BLOCKED`、Run `UNKNOWN`。残留Job lockは照会後`RELEASED` |
| node + `dist/cli.js` | `2026-08-30T10-11-28.398Z-m5-cleanup.json`        | 残存0、ローカル作業ディレクトリ0、JOBログapp 4249は非削除                                                                                                               |
| exe単体              | `2026-08-30T10-11-29.379Z-m5-serial-success.json` | exit 0。Run/Invocationと3 Node/Attemptが`SUCCESS`。JOBログ3件の相関IDが一致                                                                                             |
| exe単体              | `2026-08-30T10-11-49.349Z-m5-cleanup.json`        | 残存0、ローカル作業ディレクトリ0、JOBログapp 4249は非削除                                                                                                               |

## 3. 実装計画 §4 M5完了ゲートとの対応

`docs/internal/implementation-plan.md`自体は変更しない。同節のLOCK_CONFLICT状態契約と単体競合E2Eは同一シナリオで検証するため、以下では一つのゲートへまとめ、4項目として判定する。

| M5完了ゲート                                                | 実装・実機証跡との対応                                                                                                                                                                                                                                               | 判定・残余                                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 3ノード成功、中央失敗、複数開始点・分岐合流が仕様どおり終了 | `serial-success`で3ノードSUCCESS、`mid-failure`で中央ASSERT失敗と下流BLOCKED。diamond形状は`lock-conflict`で、n1競合後も独立開始点n2がSUCCESS、合流n3がWAITING、単体holderが完走する範囲を確認。FN-10ユニットテストは完全SUCCESSの複数開始点・分岐合流を安定順で確認 | **限定付き合格。** 完全SUCCESSパスのdiamond単独実機証跡は8件にない。M7受入へdiamond全Node/Attempt、Invocation、RunのSUCCESS確認を追加する |
| Phase 1で同時Node実行なし                                   | FN-10ユニットテストで最大同時Attempt 1、安定順を確認。直列SUCCESS実機ではAttempt/JOBログがn1→n2→n3の`$id`順で作成され、両起動経路とも完走                                                                                                                            | **合格。** 永続DATETIMEは同一分で同値のため、時刻比較自体は直列性の証拠にしない。M7では`$id`または明示的連番も保存して判定する            |
| LOCK_CONFLICT状態契約と、単体kSQL-Flowの同一`job_id`競合E2E | standalone RUNNING確認後にnetworkを開始。n1 Attempt番号1を保持して`CANCELLED / PREPARE_FAILED`、State `WAITING`、runner開始時刻なし。独立n2はSUCCESS、standaloneもexit 0で完走                                                                                       | **合格。** diamond全体はRun `RUNNING / NODES_DEFERRED`であり、完全成功試験の代用にはしない                                                |
| 不正または欠損Execution Resultを`UNKNOWN`へ分類             | kill後に結果JSON欠損を発生させ、n1 Attempt/State `UNKNOWN / NO_EXECUTION_RESULT`、Run/Invocation `UNKNOWN`、独立n2継続、n3 BLOCKEDを確認                                                                                                                             | **合格。** 実測はkillによる欠損経路。不正JSONの個別形状はFN-09ユニットテストの範囲                                                        |

以上から、M5は実装・実機境界について**限定付き合格**とする。限定はdiamond完全SUCCESSの実機証跡だけであり、競合時diamondを完全成功パスとして読み替えない。M7受入で補完後、限定を解除する。

## 4. D-24の限定条件クローズ案

### 4.1 根拠

D-24の現行限定は、M3でrepository／lease fencingとreconciliationの境界までを確認した一方、schedulerから全Node State読取り、集約計算、Run更新までを一つのInvocation所有権の下で結ぶ配線をM5（FN-10）へ残したものである。

M5で次を確認した。

1. FN-10 schedulerは一つの`RunInvocation`を受け取り、Node Attemptへ同じ`invocation_id`を配線し、全Node Stateから集約を計算してrevision付き`updateRunAggregate`を行う。通常書込みと集約書込みの直前にlease monitorを確認する。
2. 受入19相当ユニットテスト「旧token相当のfencing拒否ではRun集約とInvocationを書かない」で、fencing拒否時にRun revisionが1のまま、Invocationも非永続となることを確認した。
3. M5実機では、正常、ASSERT失敗、LOCK_CONFLICT、kill結果欠損の各分岐で、Node State集合から算出したRun集約とInvocation終端が同じInvocation相関の下で成立した。正常経路では3 Attemptすべてが同じ`invocation_id`を持ち、Run/Invocationとも`SUCCESS`となった。

これにより、M3で確認済みのlease fencingをFN-10のInvocation全体へ結ぶ限定条件は解消した。仕様受入基準19相当のfail-closedと、実機での自Invocation集約更新の両方が成立しているため、D-24節の「Invocation全体の配線検証はM5で完了する」という限定文を完了記録へ置き換える。

### 4.2 D-24追記文案

> 2026-08-30のM5（FN-10）で、schedulerから全Node State読取り、決定表による集約計算、revision付きRun更新、Invocation終端までをNetwork lock保持Invocationへ配線した。旧token相当のfencing拒否ではRun集約とInvocationを書かない受入19相当ユニットテストに合格し、実kSQL-Flow v0.7.0を用いたM5実機E2Eでは正常、ASSERT失敗、LOCK_CONFLICT、結果欠損の各分岐で自Invocationによる集約更新が成立した。これにより「集約単一主体のInvocation全体配線はM5で検証する」という限定条件を解除する。実運用スケールの長時間Run、複数ホスト、Ctrl+Break等の既存限定条件は変更しない。Supersededはない。

### 4.3 凍結ゲート注記の更新案

> [x] D-24: revision採番、canonical key、集約状態の単一更新主体を障害注入試験で確認（2026-08-30 M3実機ゲート合格。2026-08-30 M5でFN-10のlease fencing配線、受入19相当ユニットテスト、および実機での自Invocation集約更新を確認し、Invocation配線の限定を解除。詳細はD-24節）。

## 5. D-22またはD-24への運用ノート追記案

M5 E2Eで、同一Invocationの複数Node/Attemptについて`execution_started_at`、`runner_execution_started_at`、`started_at`、`finished_at`が同一分の値として永続化される事例を実際に踏んだ。たとえば公式node経路の直列SUCCESSはAttempt record ID 159、160、161の3件すべてが`2026-08-30T10:10:00Z`、exe経路は177、178、179の3件すべてが`2026-08-30T10:11:00Z`である。

したがって、次の運用ノートをD-22またはD-24へ追記する。

> kintone DATETIMEは分精度で永続化されるため、同一分内イベントの順序を`started_at`、`execution_started_at`、`runner_execution_started_at`、`finished_at`等のDATETIME値で判定してはならない。順序判定にはkintoneの`$id`または仕様で定めた単調増加の業務連番を使う。時刻は相関・表示用とし、同値を同時実行の証拠にも直列実行の証拠にも読み替えない。M5 E2Eハーネスで直列3 Attemptの永続時刻が同一分へ丸められる事例を確認した。

E2Eの監査レコード読取りは`order by $id asc`を用い、Attemptは`attempt_no`、同番号内は`$id`、Invocationは`$id`で整列する。M7受入では時刻比較による順序assertを廃止し、`$id`または業務連番で判定する。

## 6. 実測中に再確認した実装・運用知見

次はM5ゲートの合否を水増しする独立ゲートではないが、実行経路を成立させる過程で再確認した事実として残す。

- `describe-profile`の実形状では`limits`の各値が`null`になり得る。preflightとprofile snapshotは有限数または`null`を受理する。未定義・欠損と`null`を同一視しない。
- exeは旧版混入を検出して再ビルドし、SHA-256を照合してからexe単体経路を実行した。8件のJSONにはhash値がないため、具体値は本提案へ転記しない。
- WindowsのNodistシムを介すと親shimと実nodeが同一process treeに現れる。kill対象はscopeとattempt IDで絞り、列挙した親子を一つのtreeとして扱う。
- `taskkill /T`が`operation not supported`となる環境を踏んだため、列挙済みtreeのPIDを子から親の順に直接終了する。これはWindows一般の保証ではなく当該環境の実測である。
- kintone添付`fileKey`の単回性、およびunique keyの64文字上限等、M4以前の既知見と矛盾しないことを再確認した。今回のM5 JSONに専用測定値がない事項について、新しい件数や上限値は補完しない。

## 7. 残余リスクとM7補完

1. 完全SUCCESSパスのdiamond単独実機証跡がない。M7受入で、複数開始点2 Node、合流Node、Invocation、RunがすべてSUCCESSとなる実kSQL-Flow E2Eを追加する。
2. 永続DATETIMEは分精度であり、同一分内の開始・終了順序や重複有無を証明できない。M7の順序判定は`$id`または業務連番を使う。
3. 今回は単一端末`LAPTOP5`、短時間、直列E2Eである。実運用スケールの長時間Run、高並列、複数ホストは未実測である。
4. Ctrl+Break等、M5で再実測していないsignal分岐の既存限定条件は変更しない。Ctrl+C、SIGINT、SIGTERM等の既存M1記録をM5の結果として再計上しない。
5. kill→UNKNOWNはWindows実機で成立したが、Nodist以外のshim、異なるWindows版、コンテナ、Cloud Run等のprocess tree停止は未保証である。
6. cleanupはFlowNetスパイク2アプリとローカル作業領域を対象とし、kSQL-Flow所有のJOBログapp 4249を削除しない。長期保持・archive運用は本提案では閉じない。
7. 実kSQL-Flow subprocess契約の正常、ASSERT、LOCK_CONFLICT、kill結果欠損は実測した。不正JSONの全形状、timeout、全signal組合せはFN-09ユニットテストおよび後続受入の範囲である。

## 8. 承認事項

承認後、次を同じFDR更新へ反映する。

1. M5を限定付き合格として記録し、diamond完全SUCCESS実機E2EをM7受入へ追加する。
2. D-24の「集約単一主体のInvocation配線はM5で検証」という限定条件を解除し、M5完了記録へ置き換える。
3. D-22またはD-24へ、同一分内の順序をDATETIMEで判定せず`$id`または業務連番を使う運用ノートを追記する。
4. 実運用スケール長時間Run、複数ホスト、Ctrl+Break等の既存限定条件は変更しない。

いずれも既存判断の`Superseded`ではなく、検証完了記録と運用上の精度制約の追記である。
