# Spike E 測定表

> **注意:** 下表はSpike開始時の未実測テンプレートである。未実測のdurability、atomicity、互換性を保証として書かない。`execution-result-v1.draft.schema.json`はFlowNet側の検証用コピーであり、正本はkSQL-Flow同梱の`schema/execution-result-v1.schema.json`（`$id`付き）である。

| ID   | 測定項目                                | 環境   | 日時   |   回数 | API呼出数 | payload                 | 結果・障害注入結果 | 残余リスク |
| ---- | --------------------------------------- | ------ | ------ | -----: | --------: | ----------------------- | ------------------ | ---------- |
| E-01 | `describe-profile` canonical JSON再現性 | 未実測 | 未実測 | 未実測 |    未実測 | 秘密除去済みhash/byte数 | 未実測             | 未評価     |
| E-02 | `describe-profile`秘密情報除外          | 未実測 | 未実測 | 未実測 |    未実測 | field名のみ             | 未実測             | 未評価     |
| E-03 | `inspect-job` job ID                    | 未実測 | 未実測 | 未実測 |    未実測 | 秘密除去済みJSON        | 未実測             | 未評価     |
| E-04 | 非決定要素code                          | 未実測 | 未実測 | 未実測 |    未実測 | 秘密除去済みJSON        | 未実測             | 未評価     |
| E-05 | 承認済み例外manifest                    | 未実測 | 未実測 | 未実測 |    未実測 | 秘密除去済みmanifest    | 未実測             | 未評価     |
| E-06 | Attempt marker後・JOB marker前crash     | 未実測 | 未実測 | 未実測 |    未実測 | 未採取                  | 未実測             | 未評価     |
| E-07 | JOB marker成功後・最初のSQL文前crash    | 未実測 | 未実測 | 未実測 |    未実測 | 未採取                  | 未実測             | 未評価     |
| E-08 | JOB更新応答消失と再GET                  | 未実測 | 未実測 | 未実測 |    未実測 | 未採取                  | 未実測             | 未評価     |
| E-09 | 結果JSON `executionStarted`との整合     | 未実測 | 未実測 | 未実測 |    未実測 | schema検証結果          | 未実測             | 未評価     |
| E-10 | status/resultCode/exitCode整合          | 未実測 | 未実測 | 未実測 |    未実測 | schema検証結果          | 未実測             | 未評価     |
| E-11 | stdout 1 object・path atomic出力        | 未実測 | 未実測 | 未実測 |    未実測 | byte数/hash             | 未実測             | 未評価     |
| E-12 | schema配布場所・version・package化候補  | 未実測 | 未実測 | 未実測 |    未実測 | N/A                     | 未実測             | 未評価     |

## 2026-08-30 M1実機検証の要点

出典: kSQL-Flow `docs/internal/m1_verification_record_20260830.md`、`docs/kSQL-FlowからkSQL-FlowNetへの返信-20260830-M1完了報告.md` §6。

- devenxyfiの実行ログapp 4249で、template v0.4適用、`validate --check-logapp`、SUCCESS／NO_DATA、耐久`EXECUTION_STARTED`、result path、`expected-job-id`不一致、既存path拒否、`inspect-lock`／`force-unlock-job`、stdout純度のE2Eに合格した。
- kintone DATETIMEが分精度であることを実機で発見し、`EXECUTION_STARTED`応答消失後の再GET照合を双方の値の分単位正規化へ修正して合格した。Execution ResultとJSONLの時刻は秒精度を維持する。
- 128文字の`correlationId`／`attemptId`をechoし、実ログアプリへの保存と再GETに合格した。
- Windows実コンソールのCtrl+C、およびLinux VPS（Linux 6.8／Node 22）のSIGINT、SIGTERM、2回目signal、orchestrator＋SIGTERM結果JSONを実機確認した。
- contract testは22 suites／287 testsに合格し、FlowNet側でも独立再実行して同数の合格を確認した。
