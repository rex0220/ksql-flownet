# Phase 1 移行runbook: 旧run-all運用からkSQL-FlowNetへの切替

対象: 既存の`ksql-flow run-all`バッチ運用をkSQL-FlowNetのNetwork Runへ切り替える手順。契約の定義はFDR D-27(移行境界)・D-06(status移行規則)が正本。

## 原則(D-27)

- 旧`batch_id`をPhase 1の`run_id`へ**変換しない**。旧実行にはbusiness key・不変bundle・Node Stateがなく、同一業務Runとして安全に継続できない。
- 旧履歴が業務上必要な場合のみ、`legacy_batch_id`を持つ**監査専用参照**として取り込む。resume判定・重複判定には一切使用しない。
- 切替後の業務は新しいNetwork Runとして開始する(初回は`--business-key`または`--resume --scheduled-for`のNEW経路)。

## 手順

### 1. 切替前提の確認: 未完了旧バッチ0件

切替対象ジョブ群について、JOBログアプリ(4249)に未完了(`RUNNING`)の旧run-allバッチが**0件**であることを確認する:

```
対象job_idごとに: status = "RUNNING" のJOBレコードを照会(読取のみ)
```

- 0件でない場合は切り替えない。終端まで待つか、旧運用の手順で明示停止・解決(kSQL-Flow側の`inspect-lock`→停止確認→`force-unlock-job`)してから再確認する。
- kintone DATETIMEは分精度のため、確認は件数(0件)で行い、時刻の前後関係で判断しない。

### 2. JOBログ相関フィールドの互換確認

Phase 1のJOBログ相関(`attempt_id`等)はkSQL-Flow M1で追加済み。旧schemaレコード(相関フィールド空)との互換は次で成立する:

- FlowNetのジョブログ照合は常に`attempt_id`相関で照会するため、旧レコードは検索に一致せず、誤って裁定材料になることはない(fail-closed方向)。
- 旧レコードの読取・表示は従来どおり(フィールド追加は既存レコードを破壊しない。kintoneのフィールド追加は既存レコードでは空値)。

### 3. スケジューラ切替

- 外部スケジューラ(cron等)のエントリを`ksql-flow run-all`から`ksql-flownet run-network <network> --resume --scheduled-for <期間起点>`へ置き換える(D-30: 起動時刻・missed run・catch-upは外部スケジューラの責務のまま)。
- 定義YAMLは`validate`/`plan`で事前検証し、初回実行前にトークン権限(state/audit書込可、業務アプリはSQL読取のみ、削除権限不要)を確認する。

### 4. 旧履歴の監査取り込み(必要時のみ)

業務上、旧バッチ履歴への参照が必要な場合に限り、対象履歴をOPERATION_AUDIT相当の監査レコードとして取り込む。取り込み形式:

- `legacy_batch_id`(旧batch_id)、対象期間、取り込み理由、取り込み実施者を記録する。
- `run_id`・R1キー・Node Stateへは**変換しない**。`SKIPPED (filtered)`等の旧選抜外はresume可能な状態へ変換しない(FDR 350行)。

### 5. 切戻し(rollback)

FlowNet運用を停止して旧運用へ戻す場合:

1. 外部スケジューラのエントリを旧`run-all`へ戻す。
2. 実行中のNetwork Runがあれば完走を待つか、`status --json`で状態確認→必要なら復旧runbook(`docs/runbook-phase1-recovery.md`)の手順でUNKNOWN解決まで終わらせる。未完了Runを放置したまま旧運用を再開しない(Job lockはkSQL-Flow所有のため旧運用と競合しないが、業務の二重実行判断が壊れる)。
3. FlowNetのstate/auditアプリは削除せず監査として保持する(resume_allowedをfalse化する運用は任意)。
4. 再切替時は手順1(未完了0件確認)からやり直す。

## 残余リスク

- 旧run-allと新Network Runの並走は、同一`job_id`についてはNode lock(kSQL-Flow所有)が最終防波堤になるが、業務単位の重複判定(business key)は旧側に存在しない。**切替は業務(ジョブ群)単位で行い、同一業務の新旧並走を残さない**こと。
- 旧履歴取り込みは手動運用であり、取り込み漏れは監査参照の欠落として残る(業務判断)。
