# FDR更新提案書（2026-08-29）

> **正本ではない。** 本書は、ユーザー承認後に `docs/phase1-freeze-decision-record.md` へ反映する差分案である。本ラウンドでは `docs/` を変更しない。

## 1. 変更区分

| 判断 | 提案する扱い                                                       | Supersededか                                        |
| ---- | ------------------------------------------------------------------ | --------------------------------------------------- |
| D-10 | 64文字実測による補強追記。`PROPOSED`維持                           | いいえ。既存キー案を置き換えない                    |
| D-11 | contract test記録を追記し、`VALIDATION_REQUIRED`を閉じる状態更新案 | いいえ。既存の契約表現を検証結果で補強する          |
| D-12 | roundtrip・改ざん検知の部分進捗を追記。`OPERATIONS_REQUIRED`維持   | いいえ。運用判断は未完了                            |
| D-26 | 現行Job lockの通常解放方式と権限境界を追記。`PROPOSED`維持         | いいえ。force-unlock所有境界を置き換えない          |
| D-29 | Network lockの通常解放方式の第一候補を追記。`PROPOSED`維持         | いいえ。renewable lease・強制回収契約を置き換えない |

今回、以前の判断を撤回または置換する提案はないため、`Superseded` として残す旧判断はない。

## 2. D-11を閉じるための記録案

### 提案本文

2026-08-29、kintone検証環境で重複禁止INSERTのcontract testを実施した。結果は検証環境での観測であり、kintoneの公式保証ではない。重複禁止INSERTを分散ロック取得の最終裁定として採用できると判断する。

実行環境は `LAPTOP5 / Windows (win32) / Node v24.14.0 / devenxyfi.cybozu.com / app 4257`、単一ホスト、ローカルロックなしである。results JSONは実行コマンド文字列を保持していないため、以下はJSONと同じworker数・反復数を再現するコマンドとして記録する。

```bash
node --env-file=.env spikes/d-lock-contract/scripts/lock-contention.mjs
node --env-file=.env spikes/d-lock-contract/scripts/lock-contention.mjs --workers 3 --iterations 10
node --env-file=.env spikes/d-lock-contract/scripts/response-loss.mjs
node --env-file=.env spikes/d-lock-contract/scripts/revision-conflict.mjs
node --env-file=.env spikes/d-lock-contract/scripts/stale-reclaim.mjs
```

反復と結果:

- 2 worker × 10反復: INSERT成功10、400 `CB_VA01`拒否10、永続重複0、API 50回、Σ `durationMs` = 10,224.8544 ms、合格
- 3 worker × 10反復: INSERT成功10、400 `CB_VA01`拒否20、永続重複0、API 70回、Σ `durationMs` = 14,482.3754 ms、合格
- 400となった全30件は同じkeyを再GETし、`count=1` とRUNNING holderを確認して `LOCK_CONFLICT` と裁定
- 成功応答消失: API 3回、786.1514 ms。再GETで同一holderを確認し `ACQUIRED_BY_REGET`、合格
- revision競合: API 6回。finish-record更新は200、旧revisionのreclaimer更新は409 `GAIA_CO02`、再GETでfinish-recordを確認、合格
- stale回収後の旧保持者復帰: API 6回。旧revision更新は409 `GAIA_CO02`、再GETでreclaimerとlease identity保持を確認、合格
- 初回2 worker × 10反復ではロック裁定は成功10・拒否10・重複0だったが、cleanup DELETEが全10件403 `GAIA_NO01` となり削除権限不足を発見した。この実行は `passed=false` であり、上記合格集計には含めない

参照results:

- `spikes/d-lock-contract/results/2026-08-29T10-43-16.516Z-lock-contention.json`
- `spikes/d-lock-contract/results/2026-08-29T10-52-31.819Z-lock-contention.json`
- `spikes/d-lock-contract/results/2026-08-29T10-52-32.766Z-response-loss.json`
- `spikes/d-lock-contract/results/2026-08-29T10-52-34.357Z-revision-conflict.json`
- `spikes/d-lock-contract/results/2026-08-29T10-52-35.719Z-stale-reclaim.json`
- `spikes/d-lock-contract/results/2026-08-29T11-05-59.901Z-lock-contention.json`

残余リスクは、複数ホスト、高並列、ネットワーク分断、GET遅延、再GET確認不能分岐が未実測であること。D-14の新旧lock移行は未実施であり、本判断では閉じない。

### 状態変更案

FDR一覧のD-11を `VALIDATION_REQUIRED` から `DECIDED` へ更新し、上記記録をD-11節へ追記する。既存の「公式保証とは表現しない」「400だけで競合と断定しない」という契約は維持する。

## 3. D-12の部分進捗と残項目

### 提案本文

2026-08-29、同じ検証環境とapp 4257で、4KiB / 1MiB / 10MiBを各1回roundtripし、全件でZIP自己検証とSHA-256一致を確認した。API呼出数は各6回、計18回。10MiBではupload 4,301.0974 ms（約4.3秒）、download 7,431.3807 ms（約7.4秒）であり、10MiBはkSQL-FlowNet独自上限候補として実用域と判断する。これはkintoneの公式上限を示さない。

正常download後の1 byteローカル改ざんでは、API 7回のシナリオでhash不一致を検知し、`CORRUPTION_DETECTED_FAIL_CLOSED` となった。

bundle取得契約には、`POST /k/v1/file.json` の `fileKey` が添付専用であることを明記する。添付後にレコードを再GETし、添付フィールド内の新しい `fileKey` を取得してdownloadしなければならない。

実行条件を再現するコマンド（results JSONは実行コマンド文字列を保持しない）:

```bash
node --env-file=.env spikes/b-bundle/scripts/bundle-roundtrip.mjs
node --env-file=.env spikes/b-bundle/scripts/bundle-corruption.mjs
```

参照results:

- `spikes/b-bundle/results/2026-08-29T11-04-00.864Z-bundle-roundtrip.json`
- `spikes/b-bundle/results/2026-08-29T11-04-03.307Z-bundle-corruption.json`

未実施のため残す項目は、添付差替え・削除権限の確認、archive先からの復元、resume可能期間と保持期間の運用、外部immutable storage、監査保持、定期復元試験、通常bundleを含む複数サイズ分布の統計、取得不能時のfail-closedである。

### 状態変更案

D-12へ検証記録を追記するが、FDR §11が `OPERATIONS_REQUIRED` を閉じる条件とする責任者、権限、保持期間、復旧手順が未決定であるため、状態は `OPERATIONS_REQUIRED` のままとする。Supersededではない。

## 4. D-10の64文字実測による補強

### 提案本文

重複禁止フィールドは実機で64文字まで入力でき、超過時は400 `CB_VA01`、`Enter less than 65 characters.` となることを再確認した。D-10のN1案は `N1:` 3文字とpaddingなしbase64url SHA-256 43文字の合計46文字であり、この実測制限内に収まる。

この記録はキー長の適合性だけを補強する。canonical bytesのtest vector、J1移行、新旧lock protocol移行は未実測である。

### 状態変更案

D-10本文への補強追記とし、Supersededにはしない。test vectorが未完了のため `PROPOSED` を維持する。

## 5. D-26 / D-29関連のロック解放・権限設計

### D-26への追記案

現行kSQL-FlowのJob lock通常解放は、レコードDELETEではなく、終端status更新、`job_key`の空文字クリア、元キーの`job_key_done`への退避を単一UPDATEで行う。実装根拠は `ksql-flow/src/logapp.ts` の `finishRecord()` である。したがって、本番サービストークンへレコード削除権限を付与しない構成を可能にし、Job lockを含む監査アプリには削除権限を付与しないことを推奨する。

これは通常解放方式の追記であり、D-26のforce-unlock所有境界、旧保持者停止確認、監査、応答消失時のfail-closedを置き換えない。`PROPOSED` を維持する。

### D-29への追記案

FlowNet所有のNetwork lockでも、通常解放プロトコルは一意キークリアUPDATE方式を第一候補とする。終端・解放情報と一意キーのクリアをrevision付き単一UPDATEにまとめ、通常運用ではDELETEを要求しない。強制回収時も、expected owner、revision、lease token、旧owner停止証拠の確認という既存契約を維持する。

Spike Aでこの方式を実装し、正常解放、revision競合、応答消失、再GET裁定、削除権限なしのサービストークンでの動作を測定する。D-29のrenewable lease、heartbeat、drain、強制回収判断を置き換えず、`PROPOSED` を維持する。

## 6. 承認後の反映チェック

- D-11の状態を閉じるか、残余リスクを理由に `VALIDATION_REQUIRED` を維持するかをユーザーが最終承認する
- D-12の10MiBを「上限」ではなく「上限候補」と記載し、`OPERATIONS_REQUIRED` を維持する
- D-10、D-26、D-29は追記のみとし、既存判断を削除しない
- D-14は未実施のまま閉じない
- すべての実測結果に「検証環境での観測であり公式保証ではない」を残す
