# Spike D 判定テンプレート

> **注意:** 未実測値を保証として記載しない。実機成功は検証環境での観測であり、公式保証ではない。

## D-10: canonical lock key

- 判断: `採用 / 修正 / 保留`
- N1 canonical bytes・key version:
- J1移行要否・canonical bytes:
- test vector参照:
- 根拠となる測定行ID:
- 記録すべき残余リスク:
- FDR更新内容・状態:

## D-11: 重複禁止INSERT contract test

- 判断: `検証環境で成立 / 不成立 / 保留`
- プロセス・ホスト・反復範囲:
- 成功・拒否・永続重複の集計:
- 400後GETとfail-closed結果:
- 障害注入結果:
- 根拠となる測定行ID:
- 記録すべき残余リスク・非保証範囲:
- FDR更新内容・状態:

## D-14: 新旧lock protocol移行

- 判断: `一括切替 / 二重取得 / 最低version拒否 / 保留`
- 全起動元・対象コマンドの範囲:
- deadlock防止・rollback方法:
- 根拠となる測定行ID:
- 記録すべき残余リスク:
- 明示的な後続ゲート（保留時は必須）:
- FDR更新内容・状態:
