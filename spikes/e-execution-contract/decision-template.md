# Spike E 判定テンプレート

> **判断済み（2026-08-30）:** kSQL-Flow M1完了報告と実機検証記録、およびFlowNet側の独立検証に基づく。FlowNet側のSchema草案は検証用コピーであり、正本はkSQL-Flow同梱schemaとする。

## D-22: SQL開始証跡

- 判断: 採用（2026-08-30）
- 耐久`EXECUTION_STARTED`の保存・revision・再GET規則: expected revision 1でJOBを更新し、成功確認後にJSONL、最初のSQL文の順とする。応答消失時は同一record IDを再GETし、DATETIMEを分単位へ正規化して一致した場合のみ続行する。
- `executionStarted`との役割分離: JOB markerはSQL開始直前への到達を示す耐久証跡、Execution Resultは有効な最終JSONの要約とする。
- crash／応答消失時のUNKNOWN境界: 更新失敗、不一致、照会不能ではSQL未開始でfail-closed。有効な結果JSONがなければFlowNetが耐久証跡からUNKNOWNを裁定する。
- 根拠となる測定行ID: E-06〜E-10、および`measurements.md`の2026-08-30 M1実機検証要点
- 記録すべき残余リスク: FlowNetのJSON欠損UNKNOWN化はFN-09で実装する。
- FDR更新内容・状態: D-22を`DECIDED`、§12ゲートを完了とする。

## D-23: idempotent検査

- 判断: 採用（2026-08-30）
- job ID検査規則: `inspect-job --json`のjob IDをbundle作成時にmanifestへ固定し、FlowNetが照合する。
- 非決定要素codeの安定集合: 公開診断codeのうち`KSQL1306`のみ。`KSQL1305`は警告であり非決定要素ではない。
- 例外manifestと承認主体: `KSQL1306`の承認済み例外manifestをFlowNetのFN-07／M4で実装する。
- 静的検査で証明しない範囲: `KSQL1302`／`KSQL1303`は`validate`責務。乱数・外部状態参照は未検出を検出済みと扱わず、静的検査だけで冪等性を証明しない。
- 根拠となる測定行ID: E-03〜E-05、およびM1完了報告 §4 D-23
- 記録すべき残余リスク: FN-07の例外manifest運用が未実装のため、§12ゲートは未完了とする。
- FDR更新内容・状態: D-23を`DECIDED`、§12ゲートは未チェックを維持する。

## Execution Contract v1 §13

- 判断日・判断者: 2026-08-30、オーナー承認。FlowNet側で独立検証済み。
- Schema配布場所・package化: kSQL-Flow同梱`schema/execution-result-v1.schema.json`（`$id`付き）を正本とし、FlowNet側draftは検証用コピーとする。
- Schema/version互換規則: contract `ksql-flow.execution/v1`。unknown field／未知resultCode・categoryは整合条件の範囲でadditiveに受理する。producerのより厳格な安全制約は許容する。
- resultCode追加時のconsumer規則: 未知値はstatus／Exit／executionStartedの整合を検査してadditiveに扱う。
- `--result-json <path>`上書き・atomicity: 既存pathはAPI前拒否、same-directory tempへ書込み・fsync後atomic renameする。
- `executionId`発行時点・形式: batchIdと同値のUUID v4をプロセス起動時・lock取得前に発行する。
- JOB schema移行・rollback: template v0.4と移行Consoleスクリプトを使用し、ACLスクリプトを別途案内する。追加field／選択肢／一覧の削除でrollback可能。
- 未決のまま残す項目と後続ゲート: 契約§13は全項目決定済み。FlowNet側TODOはFN-09（JSON欠損UNKNOWN化、capability検証、矛盾拒否）、FN-07（`KSQL1306`例外manifest）、FN-12（force-unlock監査関連付け）、M7（ログアプリテンプレート同梱とACLスクリプト案内。M1完了報告Q14行）で追跡する。
- 根拠となる測定行ID: E-01〜E-12、2026-08-30 M1実機検証要点、M1完了報告 §2〜§6
- 記録すべき残余リスク: D-26のRUNNING実recordに対する`RELEASED`／`CONFLICT`実機再現、FlowNet側の上記実装責務。
- 契約§13へ反映する本文: 全未決項目へ決定済み注記を付し、正本schema、producerの厳格化許容、実機・contract test根拠を記録して契約を`ACCEPTED`へ昇格する。
