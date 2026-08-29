# Spike D 判定案

> **注意:** 本文はユーザー承認前の判断案である。実機成功は検証環境での観測であり、kintoneの公式保証ではない。

## D-10: canonical lock key

- 判断: `保留`。64文字制限の実機再確認はN1キー長の判断材料として採用できるが、canonical test vectorは未実測
- N1 canonical bytes・key version: FDR案の `UTF-8("N1\0" + NFC(profile) + "\0" + NFC(network_id))`、`N1:` + paddingなしbase64url SHA-256。hash部43文字、合計46文字
- 実測したフィールド制限: 重複禁止フィールドは64文字まで。超過時は400 `CB_VA01`、`Enter less than 65 characters.`。46文字のN1キーは制限内
- J1移行要否・canonical bytes: 未実測・未決定
- test vector参照: 未実測
- 根拠となる測定行ID: D-01（未実測）。64文字制限は測定表「実機で確定した補足知見」
- 記録すべき残余リスク: NUL拒否、NFC、大文字小文字、UTF-8、paddingなしを固定するtest vectorと、J1移行は未実測
- FDR更新内容・状態: D-10へ64文字実測とN1が46文字で制限内である旨を追記する。既存判断のSupersededではなく補強追記。test vector未完了のため `PROPOSED` 維持案

## D-11: 重複禁止INSERT contract test

- 判断: `検証環境で成立`。判断案は「重複禁止INSERTを最終裁定として採用可」
- プロセス・ホスト・反復範囲: LAPTOP5単一ホスト、ローカルロックなし。2 worker × 10反復、3 worker × 10反復
- 成功・拒否・永続重複の集計: 合格2実行の合計はINSERT成功20、400拒否30、永続重複0。2 workerは各反復1成功・1拒否、3 workerは各反復1成功・2拒否
- 400後GETとfail-closed結果: 合格2実行の400全30件で同一keyを再GETし、`count=1` とRUNNING holderを確認して `LOCK_CONFLICT`。確認不能・別原因のfail-closed分岐は未実測
- 障害注入結果: 成功応答消失は再GETにより `ACQUIRED_BY_REGET`。revision競合とstale回収後の旧保持者PUTは409 `GAIA_CO02` で拒否。初回実行ではcleanup DELETEが403 `GAIA_NO01` となり、削除権限不足を発見
- 根拠となる測定行ID: D-03、D-05、D-06、D-07、D-10、D-11、D-13
- 記録すべき残余リスク・非保証範囲: 複数ホスト、高並列、ネットワーク分断、GET遅延、再GET確認不能分岐は未実測。検証環境での観測であり、kintoneの公式保証ではない
- FDR更新内容・状態: D-11へ実行コマンド、環境、回数、結果、残余リスクを追記し、ユーザー承認後に `VALIDATION_REQUIRED` を閉じる案。既存判断のSupersededではなく検証記録の追記・状態更新

## D-14: 新旧lock protocol移行

- 判断: `保留（未実施）`
- 全起動元・対象コマンドの範囲: 未実測
- deadlock防止・rollback方法: 一括切替、二重取得、最低version拒否のいずれも未実施
- 根拠となる測定行ID: D-14、D-15、D-16（すべて未実測）
- 記録すべき残余リスク: 旧新キーは相互排他しない。混在時の二重取得順序、deadlock、片側取得後rollback、旧runner拒否は未確認
- 明示的な後続ゲート（保留時は必須）: 全起動元と対象コマンドを列挙し、候補方式を選定してD-14〜D-16の該当試験に合格する
- FDR更新内容・状態: 未実施を追記し、`OPERATIONS_REQUIRED` を維持。Supersededなし

## 追加の設計判断材料: ロック解放プロトコル

- 第一候補: 現行kSQL-Flowの `finishRecord()` を踏襲し、終端status更新、`job_key`の空文字クリア、元キーの`job_key_done`への退避を単一UPDATEで行う
- 権限設計: 本番サービストークンへレコード削除権限を付与しない構成を可能にし、監査アプリは削除権限なしを推奨する
- 後続測定: Spike Aで一意キークリアUPDATE方式を実装し、正常解放、revision競合、応答消失、再GET裁定、権限を測定する
- 観測根拠: 初回DELETEは403 `GAIA_NO01`。現行kSQL-Flowの解放がDELETEではないことは `ksql-flow/src/logapp.ts` の `finishRecord()` に基づく
