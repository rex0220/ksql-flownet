# 復旧runbook: stale検知から解決・resumeまで

対象: kSQL-FlowNet。FlowNetプロセスの異常停止(kill、ホスト障害、電源断)後に、Network lockの回収、実行中Nodeの突合、UNKNOWN解決、Runのresumeを安全に行う手順。

現在の動作仕様は[統合仕様書](./specification.md)を参照。設計判断の経緯は `docs/internal/phase1-freeze-decision-record.md` D-26/D-29、`docs/internal/job-network-phase1-spec.md` §7・受入25 に記録がある。

## 前提

実行管理アプリの「00_Run状況」activityボードは一次切り分けの補助表示である。判定時刻にはブラウザ時刻を使うため、復旧判断ではCLI `status --json`を正とし、画面との表示差や不審な表示があればCLIのactivity、lock owner、lease、Invocationを確認してから以下の手順へ進む。

- 操作者は`KSQL_FLOWNET_SERVICE_PRINCIPAL`と`KSQL_FLOWNET_REQUESTED_BY`を自分の認証主体で設定した環境から操作する(自由記述の主体入力は存在しない)。
- 全ての書込み操作(force-unlock-network、resolve-node、record-job-unlock)は理由ファイルと証拠参照が必須で、監査レコードが残る。
- FlowNetはJob lock(kSQL-Flow所有、実行ログアプリ)を直接変更しない。Job lockの回復はkSQL-Flow側の`inspect-lock`/`force-unlock-job`で行い、その結果JSONを`record-job-unlock`でFlowNet監査へ関連付ける(D-26)。

## 手順

### 1. stale検知

```
ksql-flownet status <network_id> --profile <profile> --json
```

- `lock.stale_candidate: true`はstale**候補**であり、停止の証明ではない(D-29)。lease超過だけを理由に回収してはならない。
- kintone DATETIMEは分精度のため、保存された`lease_expires_at`は最大59秒切り捨てられている。stale判定とforce-unlockのlease検査は、この上限60秒を加算した保守的判定で行われる(実lease失効から最大59秒遅れてstale候補になる。2026-08-30実測反映)。
- `lock: null`ならlockは既に解放済み。手順4へ。
- 復旧に必要な識別子はこの出力の`recovery_identifiers`から取得する(以降の手順で手入力しない)。

### 2. 旧owner停止確認

lockの`owner_instance_id`(status出力)の形式で分岐する。

- `local-pid://<host>/<pid>`: 同一ホスト上でのみ`--stop-method local_pid`による自動確認が可能(PID不在=ESRCHのみ停止確認とする。PID再利用は残余リスクとして監査detailに記録される)。**別ホストからは自動確認できない** — 対象ホストにログインして確認するか、手動確認(下記)に切り替える。
- `projects/.../executions/...`(Cloud Run): `--stop-method cloud_run_job_execution`。`KSQL_FLOWNET_GCP_ACCESS_TOKEN`(`run.executions.get`のみの最小権限)が必要。Executionがterminal(completionTime設定済)である場合だけ停止済みと判定される。RUNNING/PENDING/権限不足/通信失敗/未知状態は全てfail-closed。
- 上記で自動確認できない場合: `--stop-method manual`。プロセス一覧・コンソールログ・基盤の管理画面等で旧ownerの停止を人が確認し、その証拠(スクリーンショット保管先、チケット等)を`--stop-evidence-ref`へ記録する。

### 3. Network lock強制回収

```
ksql-flownet force-unlock-network <network_id> \
  --profile <profile> \
  --expected-owner-invocation-id <status出力のrecovery_identifiers値> \
  --reason-file <理由ファイル> \
  --evidence-ref <インシデント参照> \
  --stop-confirmed-by <確認者> \
  --stop-evidence-ref <停止証拠参照> \
  --stop-method <local_pid|cloud_run_job_execution|manual>
```

fail-closed挙動(いずれも解放・監査なしでExit 1):

| エラーコード | 意味 | 対処 |
| --- | --- | --- |
| `LEASE_STILL_ACTIVE` | lease生存中 | 失効を待つ。生存中の回収は行わない |
| `OWNER_MISMATCH` | 期待ownerと不一致 | statusを取り直し識別子を確認 |
| `STOP_NOT_CONFIRMED` | 停止確認不能 | 手順2をやり直す。確認できるまで回収しない |
| `HEARTBEAT_ADVANCED` | 確認中にlockが更新された | 旧ownerは生きている。回収中止 |
| `REVISION_CONFLICT` | 解放PUTが競合 | statusを取り直して再判断 |
| `RELEASE_UNCONFIRMED` | 応答消失後の再GETで自書込を確認できず | lockレコードを目視確認してから再実行 |

成功時は`NETWORK_LOCK_FORCE_RELEASED`監査が1件残る。**注意**: 解放成功後の監査追記のみが失敗した場合(`AUDIT_FAILED`)、再実行はLOCK_NOT_FOUNDになるため、監査アプリへ手動で同内容のOPERATION_AUDITレコードを追記して補完する(stderrの内容を転記)。

### 4. 実行中Nodeの突合

回収後に`--resume-run`を実行すると、schedulerのノード選択前に**孤児裁定**が走る: 旧invocationが残したRUNNING Attemptをkintoneジョブログ(4249)とattempt_id相関で突合し、終端ログ(SUCCESS/FAILED等)があればその結果を適用、照合できなければ`UNKNOWN`(result_code `NO_EXECUTION_RESULT`)へ移す(受入25、2026-08-30実機ドリルで検証済み)。ジョブログ読取に失敗した場合は裁定せずエラー停止する(fail-closed)。強制回収がNode Attemptを直接FAILED/SUCCESSへ変更することはない(D-29)。

- `status --json`の`reconciliation.inconsistencies`と`node_states`で、UNKNOWNのNodeと`recovery_identifiers.resolve_node`を確認する。
- Job lockが残留してジョブが再実行できない場合はkSQL-Flow側で`inspect-lock`→停止確認→`force-unlock-job`を実施し、その結果JSONを:

```
ksql-flownet record-job-unlock --result-file <LOCK_RECOVERY_RESULT.json> \
  --run-id <run_id> --node-id <node_id> \
  --reason-file <理由> --evidence-ref <参照> --stop-confirmed-by <確認者>
```

でFlowNet監査へ関連付ける(4249のレコードを直接編集しない)。

### 5. UNKNOWN解決

業務データ(対象アプリの実データ、ジョブログ)を照合し、実際の結果に基づいて解決する:

```
ksql-flownet resolve-node --run-id <run_id> --node-id <node_id> \
  --to <SUCCESS|FAILED|CANCELLED> \
  [--manual-completion | --compensation] \
  --reason-file <照合結果の要約> --evidence-ref <照合証拠> \
  --stop-confirmed-by <確認者> --stop-evidence-ref <停止証拠>
```

- `SUCCESS`は「処理が実際に完了していたことを確認した」場合のみで、`--manual-completion`必須。
- 取消・補償を実施した場合は`--compensation`で、SUCCESSにはできない(下流を進めない解決)。
- 非冪等NodeのSUCCESS解決は、requested_byとも実行主体とも異なる`--approved-by`が必須。

### 6. resume

```
ksql-flownet run-network <network.yamlのパス> --resume-run <run_id> ...
```

- 第1引数はnetwork定義ファイルのパス(例: `/opt/ksql/my-ksql-jobs/flownet/monthly-summary/network.yaml`)であり、`status`のようにnetwork IDを取るのではない

- run_idは変わらず、invocation_idだけが増える。SUCCESS済みNodeは再実行されない。
- 非冪等のFAILED Nodeは自動再実行されない(手順5で解決してから進める)。

## ボード・操作要求アプリからの再開・停止・解除

### ボード(プラグイン)からのリラン手順(推奨)

一次対応の通常経路は、実行管理アプリの「00_Run状況」ボードからのボタン操作である。

1. 「00_Run状況」を開き、対象Runを探す。実行が止まったRunは「進行中のRun」(INTERRUPTED/STOPPED)または「終了済み・対応が必要なRun」(FAILED/CANCELLED)に表示される。エラー内容は行のエラー概要と、レコード番号リンク先の詳細画面(関連JOBログ)で確認する
2. 行の「**リラン要求**」ボタンを押し、理由を入力して確認のうえ起票する。成功表示に出る要求レコードへのリンクを控える
3. ポーラーは5分間隔で処理する。ボードを再読込し、要求の終端(`DONE`/`REJECTED`)とRunの状態を確認する。`DONE / OK`でRunがSUCCESSなら完走である
4. RETRY_BRAKE解除など開始ノードの指定が必要な場合は、**レコード詳細画面**のリラン要求を使い、二次対応者から指示されたNode IDだけを`rerun_from_node`へ入力する
5. `UNKNOWN`のRunにはボタンが表示されない(Run IDのコピーボタンのみ)。Run IDを添えて二次対応者へ連絡する
6. 要求が`REJECTED`になったら、結果メッセージの理由コードに応じて本runbookの該当節(`LOCK_CONFLICT`・`STALE`等)へ進む。同じ要求を繰り返さない

停止は「停止要求」(次ノード境界で停止)、停止解除は「解除要求」ボタンで同様に起票する。ボタンの出し分け・文言の詳細は[一次対応1ページ](./ops-first-response.md)を参照。

### 操作要求アプリへの直接追加(ボードが使えない場合)

プラグイン未導入・要求アプリ未接続などでボタンが表示されない場合は、「kSQL-FlowNet 操作要求」アプリに新規レコードを追加して行う。`run_id`と理由を入力し、操作種別を選ぶ。既存要求の状態・claim・結果フィールドは編集しない。

| 操作 | 入力 | 完了の確認 | 注意 |
| --- | --- | --- | --- |
| `RERUN` | `run_id`、理由。必要時だけ`rerun_from_node` | 要求が`DONE`。`result_code`と実行管理・監査履歴も確認 | hold中、LIVE、SUCCESS、照合不能なRunは拒否される |
| `STOP` | `run_id`、理由 | 要求が`DONE`になり、Runが次ノード境界で停止 | 実行中のSQLは途中停止しない |
| `RELEASE` | `run_id`、理由 | 要求が`DONE`になりholdが解除 | RELEASE自身はRunを再開しない。ただし定期`--resume`が次回起動時に再開し得る |

**停止要求後にRunがFAILEDになった場合**(実行中のSQLが失敗)、holdが残ったままボードには「リラン要求」が出るが、RERUNは`RUN_ON_HOLD`、解除要求は`RUN_NOT_ON_HOLD`で拒否される。二次対応者がCLIでholdを解除してからリランする:

```
ksql-flownet cancel-run --run-id <run_id> --release --reason-file <理由ファイル>
```

### START要求(P2-11)

STARTは未作成の業務実行単位を作る要求であり、既存Runの再開には使わない。ボードの「新規実行」または操作要求アプリへの直接追加で起票する。`DONE`は要求処理の完了であってRun成功ではないため、必ず実行管理アプリのNETWORK_RUNとボードで成否を追跡する。

STARTが`REJECTED / STALE`になった場合は、次の順で照合する。

1. 要求レコードの`network_id`、`business_key`、`scheduled_for`、`claimed_at`、`claimed_host`、`claim_heartbeat_at`を控える。
2. 対象networkの定義とキーpolicyからbusiness keyを再導出し、`ksql-flownet status <network_id> --profile <profile> --business-key <business_key> --json`を実行する。
3. 要求のclaim時刻以後に新しいNETWORK_RUNが出ていないか、ボード、実行管理、監査履歴、JOBログで確認する。新Runがあれば再起票せず、そのRunと業務結果を追跡する。
4. 新Runが出ていないこと、live owner・矛盾・複数一致がないことを二次対応者が確認できた場合だけ、新しいSTART要求を起票する。確認不能なら再起票しない。

network定義の配備中は、キー再導出と実行時定義がずれるため、**先にポーラーを停止**する。定義を配備し`validate`と`poll-requests --check`を完了してからポーラーを再開する。`app_start: true`の有効化は最後に行い、allowlist開放時はプラグイン設定のSTART許可ネットワーク一覧も`ネットワーク名, network_id[, 入力モード[, business_keyテンプレート]]`のCSV形式（例: `月次案件集計(当月分の起動), monthly_deal_summary, 定期`、`月次案件集計(補正), monthly_deal_summary, 補正, {ネットワークID}@{年}-{月}-correction-1`）で更新する。

allowlistからnetworkを除去、または`app_start`を無効化した後に、そのnetworkの`ACCEPTED` STARTが滞留した場合は自動決着させない。二次対応者が次を行う。

1. ポーラーを停止し、要求の3入力欄とclaim情報を控える。
2. 上記STALE手順で新Run、Invocation、監査、JOBログ、live ownerを照合する。Runが作成済みなら、そのRunの状態と業務結果を記録する。
3. 自動回収不能であることと照合結果を作業記録へ残し、要求レコードを手動で`request_state=REJECTED`、`result_code=STALE`へ更新する。`result_message`には「allowlist変更後の人手決着」であること、確認したRun IDまたは「新Runなし」、確認者、確認日時を記録する。元の入力欄・claim欄は変更しない。
4. 要求一覧から滞留が消えたことを確認する。networkを再許可する場合は、定義検証と`poll-requests --check`後にポーラーを再開し、必要なSTARTは別の新規レコードとして起票する。

この手動更新は通常の一次操作ではなく、allowlist変更で自動回収経路を失った要求を監査可能に終端する二次対応手順である。

ボード起票のRERUNが`REJECTED / LOCK_CONFLICT`になった場合は、一次対応者に同じ要求を繰り返させない。二次対応者が本runbookの手順1〜3に従って旧ownerの停止を確認し、`force-unlock-network`でstale Network lockを回収した後、一次対応者へ**ボードのリラン要求ボタンをもう一度押す**よう依頼する。M3 B-1/B-2では、1回目がkill後のlock競合で拒否され、回収後の2回目はジョブログ証拠による孤児裁定を経てSUCCESSまで完走した。同じ経路でも証拠が見つからなければUNKNOWNへ移るため、その場合は再要求せず手順5の解決へ進む。

同一failure kindが3回連続した`RETRY_BRAKE`は、通常のRERUNだけでは対象ノードを再実行しない。原因(SQL、入力データ、認証・接続設定等)を修正してから、新しいRERUN要求の`rerun_from_node`へブレーキ対象の冪等Node IDを指定する。要求結果が`DONE / RETRY_BRAKE`のままなら、対象Node、冪等性、修正内容を二次対応者が再確認する。非冪等NodeやUNKNOWNはアプリ操作で強行しない。

### STALE要求の照合

`REJECTED / STALE`は、要求の実行有無または結果をポーラーが確定できなかった状態であり、未実行の意味ではない。**同じRunへRERUN・STOP・RELEASEを再要求してはならない。** 次の順で照合する。

1. 要求レコードの`run_id`、`claimed_at`、`claimed_host`、`claim_heartbeat_at`を控える。
2. `ksql-flownet status <network_id> --profile <profile> --run-id <run_id> --json`でInvocation、Node State、activity、lock ownerを取得する。
3. 監査履歴の`requested_by=app-request:<record_id>:...`、要求claim時刻以後のInvocation、kSQL-Flow JOBログの`attempt_id`を突合する。
4. 実行済みならそのInvocationの結果を正として業務データまで確認する。未実行を証明できた場合だけ、新規要求の可否を二次対応者が判断する。矛盾・UNKNOWN・生存ownerがあれば本runbookの手順1〜5へ上げる。

要求アプリのGET失敗時は、ポーラーはclaimもSTALE更新もchild起動もしない。claim後の到達不能ではchildを即killせず、heartbeat停止後もFlowNet側LIVE中はSTALE化しない。回復後または非LIVE確認後に上記規則へ収束するため、画面だけを根拠に再要求しない。

### SSH/CLIへ上げる条件

次のいずれかではアプリ操作を止め、二次対応者がSSH/CLIで調査する。

- `STALE`、`UNKNOWN`、`RUN_LIVE`、`STATUS_UNAVAILABLE`、`RUN_ID_AMBIGUOUS`、または同じ要求の結果が照合できない
- RETRY_BRAKEの原因修正・対象Node・冪等性を確定できない、または`rerun_from_node`でも解除できない
- stale Network lock、孤児RUNNING Attempt、Job lock残留、非冪等FAILED、手動解決・補償が必要
- `poll-requests --check`が失敗する、要求アプリの権限やallowlist/定義が本番構成と一致しない
- kSQL-Flow実行時に`VALIDATION_ERROR`となり、`profile名 + ":" + job_id`が64 UTF-16単位を超える疑いがある。これはジョブロックキーの実測上限で、現行`validate`では検出されない

## 運用上の注意(2026-08-31追記)

- **ノード実行時間の上限**は現状kSQL-Flow側の`batch_timeout_sec`と、FlowNetのrun-subprocessのgraceful→forced kill経路に依存する。FlowNet側のノード単位上限時間は未実装(backlog: docs/internal/implementation-plan.md P2-04)。ハング疑い時は`status --json`のlock heartbeatとジョブログで生存を判別する。
- **決定的に失敗するノードの定期resume**は、同一failure kindが3回連続した時点で`RETRY_BRAKE`により通常のresume / RERUNでは再実行されなくなる(attemptは無制限には増えない)。原因を修正したうえで`rerun_from_node`(CLIでは`--rerun-from`)に対象Node IDを指定して明示的に解除する(§7参照)。

## 残余リスク(FDR記載の再掲)

- lock照合から状態更新までのTOCTOU窓(D-29)。Job lockが最終防波堤だが、Network集約の整合はfencing頼み。
- local_pidのPID再利用窓。確認時刻を監査detailに記録して緩和。
- 解放成功直後の監査追記失敗窓(上記手順3の補完手順で回復)。
- 実Cloud Run Executionの照会は現状mock検証のみで実機照会は未実装(経緯: docs/internal/phase1-freeze-decision-record.md D-29)。
