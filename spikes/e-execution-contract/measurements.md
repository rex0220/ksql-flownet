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

## 2026-08-30 M5実機E2EによるSpike E完結記録

出典: `docs/internal/test-results/m5-gate-20260830/*.json` 8件、`tests/e2e/README.md`、`tests/e2e/support.mjs`。環境は`LAPTOP5` / Windows / Node.js `v24.14.0` / `devenxyfi.cybozu.com`、Execution Planeは実kSQL-Flow v0.7.0である。

| ID   | 測定項目                                   |                                        経路・回数 | 実測結果                                                                                                                                                                                                     | 出典                                                                           | 残余リスク                                                                 |
| ---- | ------------------------------------------ | ------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| E-13 | 正常Execution Result契約の実subprocess消費 |              node + `dist/cli.js` 1回、exe単体1回 | 両経路ともexit 0。Run/Invocationと3 Node/Attemptが`SUCCESS / OK`。FlowNet AttemptとJOBログ3件のcorrelation/attempt/execution/job IDが一致                                                                    | `10-09-55.220Z-m5-serial-success.json`、`10-11-29.379Z-m5-serial-success.json` | 完全SUCCESS diamondは未実測。DATETIMEは分精度で順序証明に使えない          |
| E-14 | ASSERT失敗Execution Resultの分類           |                          node + `dist/cli.js` 1回 | n2を`FAILED / ASSERT_FAILED`、下流n3を`BLOCKED / ALL_SUCCESS_NOT_SATISFIED`、Run/Invocationを`FAILED / NODE_FAILED_OR_BLOCKED`へ分類                                                                         | `10-10-17.922Z-m5-mid-failure.json`                                            | ASSERT以外の全業務失敗codeを実機網羅していない                             |
| E-15 | `LOCK_CONFLICT`のpre-execution契約         | node + `dist/cli.js` network 1回 + standalone 1回 | standalone RUNNING確認後に同じ`job_id`を競合。Node Attempt 1を`CANCELLED / PREPARE_FAILED`、runner開始時刻なし、Node Stateをattempt番号保持の`WAITING`へ戻した。独立n2はSUCCESS、standaloneはexit 0で完走    | `10-10-58.561Z-m5-lock-conflict.json`                                          | 競合時diamondはRun `RUNNING / NODES_DEFERRED`。完全成功パスの代用ではない  |
| E-16 | subprocess kill後の結果欠損分類            |                          node + `dist/cli.js` 1回 | JOBログの耐久RUNNING確認後に対象process treeをkill。結果JSON欠損をn1 Attempt/State `UNKNOWN / NO_EXECUTION_RESULT`、Run/Invocation `UNKNOWN / NODE_RESULT_UNKNOWN`へ分類し、独立n2は継続SUCCESS、n3はBLOCKED | `10-11-11.338Z-m5-kill-unknown.json`                                           | Windows/Nodist経路の実測。全OS・shim・signal組合せは未実測                 |
| E-17 | 起動経路互換とcleanup                      |              node + `dist/cli.js` 6件、exe単体2件 | 公式通し6件とexe経路2件の全8件が`passed: true`。各最終cleanupは残存state/audit/ローカル作業ディレクトリ0、JOBログapp 4249は非削除                                                                            | `docs/internal/test-results/m5-gate-20260830/`の時系列8件                               | exe再ビルド後のSHA-256値、E2E全体のAPI呼出総数はJSON未収録のため転記しない |

M5により、FlowNetがkSQL-Flow Execution Contractを実subprocess越しに消費し、正常、決定的ASSERT失敗、SQL開始前のLOCK_CONFLICT、開始後killによる結果欠損を安全側へ永続化する主要境界を実測した。これをSpike Eの実subprocess測定の完結点とする。既存E-01〜E-12の個別未実測欄を、M5 JSONに存在しない値で埋め戻すことはしない。

実行時には、`describe-profile.limits`が`null`を含み得る実形状、kintone DATETIMEの分精度、Nodist shim親子、`taskkill /T`非対応を確認した。順序はDATETIMEではなく`$id`または業務連番で判定し、killはscopeとattempt IDで対象treeを限定する。exe旧版検出後は再ビルドとSHA-256照合を行ったが、hash値は公式JSONにないため本表には記載しない。
