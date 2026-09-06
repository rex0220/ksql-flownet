# FDR反映提案 2026-08-30c: M6ゲート実機判定の結果反映

状態: REFLECTED(2026-08-30承認・反映済み)
証跡: `docs/internal/test-results/m6-gate-20260830/`(公式実行6/6合格、2026-08-30 14:05-14:14 JST相当)、mainコミット 8f73937(製品修正)・9f94bb9(ハーネス+証跡)

## A. M6完了ゲートの判定結果(implementation-plan 237-244行)

| ゲート                                    | 判定           | 証跡                                                                                                |
| ----------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| resumeでrun_id不変・invocation_idのみ増加 | 合格           | m6-01                                                                                               |
| UNKNOWN経路だけ停止・独立系統継続         | 合格           | m6-02(FlowNet生存kill)、m6-04(FlowNet死亡→resume)                                                   |
| 非冪等Nodeの自動再実行なし                | 合格           | m6-03                                                                                               |
| 全手動操作に認証主体と証拠                | 合格           | m6-03(ATTEMPT_RESOLUTION全項目)、m6-04(NETWORK_LOCK_FORCE_RELEASED全項目)                           |
| statusは無変更で復旧識別子を返す          | 合格           | m6-05($revision全件前後比較、lease_token非出力)                                                     |
| Cloud Run照会のfail-closed                | 合格(限定付き) | unit判定表+m6-06(形式不一致/トークン未設定/未知method)。実GCP照会は未実施(既存のD-29限定事項のまま) |

提案A: implementation-planのM6を完了扱いとし、M6ゲート証跡参照を追記。

## B. 実機が捕捉した製品バグ4件+機能ギャップ1件(修正済み・回帰テスト固定済み)

1. **DATETIME分精度round-trip(FN-12照合)**: resolution照合の`resolved_at`完全一致が常時失敗 → JSON詰め側に完全ISOを保存し照合。教訓: 一意キー由来のフィールドは照合不要、キーが運ばない主張(resolved_outcome等)のみ照合する。
2. **同(FN-13応答消失裁定)**: `finished_at`完全一致要求を除去($id+tombstoneキー+revision+1で自書込証明維持)。
3. **同(lease失効判定)**: 保存`lease_expires_at`は最大59秒切り捨て → `stale_candidate`とLEASE_STILL_ACTIVEに+60秒の保守判定を導入(回収適格が最大59秒遅れる=fail-closed方向)。
4. **release×自己heartbeatのrevision競走**: lock解放前にlease監視を停止+release 409時はlease_token自己確認つき1回再試行。間欠的な解放失敗→LOCK_CONFLICT残置を解消(m6-01で2回実測)。
5. **孤児RUNNING Attempt裁定の欠落(受入25)**: resume時、旧invocationのRUNNING Attemptをジョブログ(attempt_id相関)で突合し、終端は適用・照合不能はUNKNOWN(NO_EXECUTION_RESULT)・ログ読取失敗はfail-closed停止。m6-04で実機検証。

提案B: FDR D-29節へ実測補記として1-5を追記(特に「kintone DATETIMEは分精度であり、round-trip完全一致照合を契約にしてはならない。同一性は一意キー、内容照合はキー外の主張のみ」を明文化)。design-notesへkSQL実測上限(バッチ20文・temp table 16個)とAPI実測レイテンシ(~35ms/call、検証環境)を追記。

## C. 復旧runbook(M6作業項目8)

`docs/runbook-phase1-recovery.md` を新設(stale検知→停止確認3方式→強制回収fail-closed対処表→突合(孤児裁定/D-26 record-job-unlock)→UNKNOWN解決→resume、残余リスク4件)。m6-04ドリルは「statusの復旧識別子だけで回収→裁定→解決→resume完走」を実機で通しており、runbook経路の成立を確認済み。

提案C: FDRのrunbook参照(D-29節・凍結ゲート)からこのrunbookを正式参照とする。

## D. 残余リスク・未了事項(変更なしの確認)

- 実Cloud Run Executionの照会(D-29限定事項、M7/運用)
- 複数ホストでの停止確認・回収(手動運用維持)
- 解放成功後の監査追記失敗窓(runbookに手動補完手順を記載済み)
- resolution照合のキー由来フィールド簡素化(動作は正常。整理はM7バックログ扱い)

## 承認依頼

上記A〜Cの反映(implementation-plan M6完了化、FDR D-29実測補記、runbook正式参照)を承認いただけますか。
