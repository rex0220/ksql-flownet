# Phase 1 復旧runbook: stale検知から解決・resumeまで

対象: kSQL-FlowNet Phase 1。FlowNetプロセスの異常停止(kill、ホスト障害、電源断)後に、Network lockの回収、実行中Nodeの突合、UNKNOWN解決、Runのresumeを安全に行う手順。

正本: `docs/phase1-freeze-decision-record.md` D-26/D-29、`docs/job-network-phase1-spec.md` §7・受入25。本runbookは手順書であり、契約の定義はFDRが優先する。

## 前提

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
ksql-flownet run-network <network_id> --resume-run <run_id> ...
```

- run_idは変わらず、invocation_idだけが増える。SUCCESS済みNodeは再実行されない。
- 非冪等のFAILED Nodeは自動再実行されない(手順5で解決してから進める)。

## 残余リスク(FDR記載の再掲)

- lock照合から状態更新までのTOCTOU窓(D-29)。Job lockが最終防波堤だが、Network集約の整合はfencing頼み。
- local_pidのPID再利用窓。確認時刻を監査detailに記録して緩和。
- 解放成功直後の監査追記失敗窓(上記手順3の補完手順で回復)。
- 実Cloud Run Executionの照会はPhase 1では判定表のmock検証のみ(FDR D-29限定事項)。
