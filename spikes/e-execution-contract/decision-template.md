# Spike E 判定テンプレート

> **注意:** 未実測値を保証として記載しない。Schema草案を正本またはACCEPTED契約として扱わない。

## D-22: SQL開始証跡

- 判断: `採用 / 修正 / 保留`
- 耐久`EXECUTION_STARTED`の保存・revision・再GET規則:
- `executionStarted`との役割分離:
- crash／応答消失時のUNKNOWN境界:
- 根拠となる測定行ID:
- 記録すべき残余リスク:
- FDR更新内容・状態:

## D-23: idempotent検査

- 判断: `採用 / 修正 / 保留`
- job ID検査規則:
- 非決定要素codeの安定集合:
- 例外manifestと承認主体:
- 静的検査で証明しない範囲:
- 根拠となる測定行ID:
- 記録すべき残余リスク:
- FDR更新内容・状態:

## Execution Contract v1 §13

- 判断日・判断者:
- Schema配布場所・package化:
- Schema/version互換規則:
- resultCode追加時のconsumer規則:
- `--result-json <path>`上書き・atomicity:
- `executionId`発行時点・形式:
- JOB schema移行・rollback:
- 未決のまま残す項目と後続ゲート:
- 根拠となる測定行ID:
- 記録すべき残余リスク:
- 契約§13へ反映する本文:
