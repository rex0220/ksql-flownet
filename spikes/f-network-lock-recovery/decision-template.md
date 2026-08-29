# Spike F 判定テンプレート

> **注意:** 未実測値を保証として記載しない。停止確認不能・競合・応答消失・再GET不一致はfail-closedとする。

## D-29: Network lock recovery

- 判断: `採用 / 修正 / 保留`
- 判断日・判断者:
- lease duration・heartbeat intervalと境界:
- drain開始条件・新規Node停止規則:
- 実行中subprocessと結果保存規則:
- stale候補化条件:
- lease token fencing結果:
- 同一／別ホスト停止確認方法:
- Cloud Run terminal受理状態・fail-closed状態:
- `force-unlock-network`のexpected owner／revision／token／再GET規則:
- 監査event必須項目:
- 回収後Attempt照合・UNKNOWN規則:
- `control_plane_api_calls`容量評価:
- 根拠となる測定行ID:
- 記録すべき残余リスク（TOCTOU窓を含む）:
- 明示的な後続ゲート（保留時は必須）:
- FDR D-29へ反映する状態と本文:
