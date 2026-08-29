# Spike B 判定案

> **注意:** 本文はユーザー承認前の判断案である。10MiBはkSQL-FlowNet独自上限の候補であり、kintoneの公式上限ではない。

## D-12: bundle保持

- 判断: `条件付き採用`。判断案は「10MiBは上限候補として実用域」
- 判断日・判断者: 判断案作成 2026-08-29。最終判断者はユーザー承認待ち
- kSQL-FlowNet独自上限: 10MiBを候補とする。確定は通常bundleサイズ分布と運用余裕の測定後
- 実測したサイズ範囲・通常bundle分布: 4KiB / 1MiB / 10MiBを各1回。全roundtripでSHA-256一致。通常bundle分布と反復統計は未実測
- 10MiB所要時間: upload 4,301.0974 ms（約4.3秒）、download 7,431.3807 ms（約7.4秒）
- 改ざん検知: 正常取得後の1 byte改ざんでhash不一致を検知し、`CORRUPTION_DETECTED_FAIL_CLOSED`
- bundle取得契約: upload時の `POST /k/v1/file.json` の `fileKey` は添付専用。添付後にレコードを再GETし、添付フィールド内の新しい `fileKey` を取得してdownloadする
- resume可能期間: 未実測・未決定
- 保存先とimmutable性: kintone添付でroundtripのみ実測。外部immutable storageは未実測・未決定
- archive先・移送条件・監査保持期間: 未実測・未決定
- 削除権限・承認: 添付差替え・削除権限と承認は未実測・未決定
- 復元試験の頻度と合格条件: archive先からの手動復元を含め未実測・未決定
- `resume_allowed = true`時の削除防止策: 最低規則案は検証済みbundleを取得不能にする削除の禁止。権限制御と承認フローは未実測
- 根拠となる測定行ID: B-01〜B-06
- 記録すべき残余リスク: 添付差替え・削除権限、archive先からの復元、保持期間運用、外部immutable性、複数サイズ分布の統計、取得不能時のfail-closedは未実測
- 明示的な後続ゲート（保留時は必須）: B-07〜B-14の権限・archive・保持・復元項目を実施し、責任者、権限、保持期間、復旧手順を決定する
- FDR D-12へ反映する状態と本文: roundtripと改ざん検知の部分進捗、およびfileKey再取得プロトコルを追記する。既存判断のSupersededではなく検証記録の追記。運用必須項目が残るため `OPERATIONS_REQUIRED` 維持案
