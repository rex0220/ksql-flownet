# Spike E 測定表

> **注意:** 本表は未実測テンプレートである。未実測のdurability、atomicity、互換性を保証として書かない。

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
