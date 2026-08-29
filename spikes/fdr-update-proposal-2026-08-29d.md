# FDR更新提案書（2026-08-29 第4弾、D-29）

> **反映状態: REFLECTED(2026-08-29、選択肢(a)承認)**

> **正本ではない。承認後反映。** 本書はユーザー承認後に`docs/phase1-freeze-decision-record.md`へ反映する差分案であり、本ラウンドでは`docs/`を変更しない。

## 1. 提案の結論と選択肢

D-29のrenewable Network lease、heartbeat、lease token fencing、drain、監査付き`force-unlock-network`、unique tombstone解放は、lease 6秒 / heartbeat 2秒の縮小値実測で測定対象の全分岐が仕様どおり成立した。

状態は次の2案からユーザーが最終決定する。

| 選択肢       | FDR状態               | 凍結ゲート                                   | 扱い                                                                                                     |
| ------------ | --------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **(a) 推奨** | D-29を`DECIDED`へ変更 | 限定条件を明記したうえでD-29ゲートをチェック | プロトコル意味論は全測定分岐で確認済み。残余は実運用値の決定、環境拡張、本番schema化として後続管理する。 |
| (b) 保守案   | `PROPOSED`を維持      | 未チェックを維持                             | 実測記録だけを追記し、実Cloud Run・複数ホスト・実運用スケール長時間Runまで判断を保留する。               |

推奨は(a)である。理由は、残余項目がrenewable lease、fencing、drain、強制回収というプロトコル意味論の未検証分岐ではなく、主として値決定と実行環境の拡張だからである。ただし、「正常な長時間Run」を縮小値の疑似subprocessで代替した限定を受容してゲートを閉じるかは、ユーザーの最終判断に委ねる。

## 2. ADR §11に基づく実測記録の追記案

### コマンド

results JSONは実行コマンド文字列を保持していないため、以下はREADMEに記載された再実行形式である。force-unlockの停止証拠参照は、実行事実として確認できる`spike://f/...`までを記し、秘密値やデータソースにない値を補完しない。

```powershell
node --env-file=.env spikes/f-network-lock-recovery/scripts/lease-lifecycle.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/stale-detection.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/lease-token-fencing.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/drain-mode.mjs
node --env-file=.env spikes/f-network-lock-recovery/scripts/force-unlock-network.mjs --stop-evidence-ref "spike://f/..." --reason "<記録済み理由>" --service-principal "<認証主体>" --confirmed-by "<確認者>"
```

force-unlockの初回実行は`--stop-evidence-ref`欠落により「停止証拠必須」エラーで拒否され、fail-closedを実機確認した。2回目は停止証拠参照`spike://f/...`を渡して合格した。初回拒否はresults JSONを生成せず、API処理へ進んでいない。停止証拠の内容をadapterが実照会した結果ではない。

### 環境・回数

- 実施日: 2026-08-29（JST）
- 環境: `LAPTOP5` / `win32` / Node.js `v24.14.0` / `devenxyfi.cybozu.com`
- results: 2026-08-29T14:34〜14:36 UTCに記録された5件、すべて`passed: true`
- 反復: lease lifecycle 1回、stale detection 1回、fencing 1回、drain 2分岐、force-unlock 3 case。加えてforce-unlockのCLI事前拒否1回。
- 設定: lease 6秒 / heartbeat 2秒。比率規則を維持した縮小値であり、実運用値ではない。

### シナリオ別結果

| シナリオ                          | 数値・分岐                                                                                  | 結果                                                                                                         | 出典                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| lease / heartbeat / 長時間Run代替 | 疑似subprocess `5276.8794 ms`、heartbeat 2回、間隔`2005.7992 ms` / `2734.3747 ms`           | subprocess中もrenewを継続し、exit 0、tombstone解放成功                                                       | `2026-08-29T14-34-16.545Z-lease-lifecycle.json`           |
| heartbeat API容量                 | heartbeat範囲4 calls、`0.7580237668497788 calls/s`（表示値0.758 calls/秒）、実行全体6 calls | `control_plane_api_calls`として分離計測                                                                      | 同上                                                      |
| kill / stale                      | heartbeat age `26800 ms`、observer GET 1、lock write 0                                      | stale候補化するが、停止未確認では回収しないfail-closed                                                       | `2026-08-29T14-34-27.123Z-stale-detection.json`           |
| fencing二重防御                   | シナリオ全体7 calls                                                                         | 再GETで`LEASE_TOKEN_MISMATCH`、旧revision PUTで409 / `GAIA_CO02`。旧ownerのState更新・次Node起動を拒否       | `2026-08-29T14-34-29.738Z-lease-token-fencing.json`       |
| drain回復                         | 注入2回、12 calls、State write 1、新規Node 0                                                | 結果保存後`RECOVERED_AND_CANCELLED`                                                                          | `2026-08-29T14-34-43.894Z-drain-mode.json`（`recovered`） |
| drain未回復                       | 注入3回、10 calls、State write 0、新規Node 0                                                | 結果を書かず材料保持、`RECONCILIATION`                                                                       | 同上（`unrecovered`）                                     |
| force-unlock契約                  | owner不一致 / revision不一致 / 応答消失の3 case、全体11 calls、監査1 call                   | 不一致は解放・監査なし。応答消失は再GETで`RELEASE_CONFIRMED`時だけtombstone解放し、監査1件、回収後revision 2 | `2026-08-29T14-36-07.558Z-force-unlock-network.json`      |
| 停止証拠必須                      | CLI事前拒否1回 + 証拠参照付き合格1回                                                        | 欠落時は「停止証拠必須」でAPI処理前に拒否。`spike://f/...`付きだけ合格                                       | 補足実行事実、および上記force-unlock結果                  |

5件すべてで通常解放の`unique-tombstone-update`が成功した。これは必須・重複禁止キーを空文字にせず、衝突しないtombstoneへrevision付き単一UPDATEする方式の動作記録である。

### 残余リスクと限定条件

1. lease duration、heartbeat interval、連続失敗閾値の実運用値を、API予算とRun時間分布から決定する。
2. Cloud Run停止確認adapterの判定表はモックunit testで固定済みだが、実GCP Execution照会は未実施である。
3. 複数ホストでの旧owner停止確認と回収は未実施である。
4. 実運用スケール値による長時間Runは未実施である。今回の「正常な長時間Run」は5.2768794秒の疑似subprocessによる縮小値代替である。
5. 実subprocessでのdrainは未実施である。今回の到達不能はfetchラッパー注入であり、kintone実障害ではない。
6. schema v2で`acquired_at`、`owner_instance_id`、`NETWORK_LOCK_FORCE_RELEASED`等の監査event codeを含む専用フィールドを固定する必要がある。今回は既存schemaの代替フィールドを使用した。
7. lease token照合と別レコードのState更新間にはTOCTOU窓が残る。
8. 回収後のNode Attempt照合と、未確定時の`UNKNOWN`化は未実施である。

## 3. 凍結ゲートD-29との対応

現行ゲートは「正常な長時間RunでNetwork leaseを維持し、heartbeat障害時はdrainし、FlowNetプロセスkill後はruntime停止確認と監査を伴って安全に回収できる」である。

| ゲート文言                           | 実測との対応                                                                     | 判定上の限定                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 正常な長時間RunでNetwork leaseを維持 | 疑似subprocess 5.2768794秒中にheartbeat 2回を継続                                | lease 6秒 / heartbeat 2秒の縮小値代替。実運用スケール長時間Runではない。 |
| heartbeat障害時はdrain               | 回復／未回復の両分岐で`LEASE_UNCERTAIN`、新規Node 0。保存可否も仕様どおり分岐    | fetchラッパー注入であり実subprocess・kintone実障害ではない。             |
| FlowNetプロセスkill後                | kill simulationでheartbeat age 26.8秒、stale候補化、停止未確認なら回収拒否       | 実process kill、複数ホストは未実施。                                     |
| runtime停止確認                      | 停止証拠参照欠落をCLIで拒否し、参照付きだけforce-unlockを許可                    | 参照内容の同一ホストPID / Cloud Run実照会は未実施。                      |
| 監査を伴って安全に回収               | expected値不一致をfail-closed、応答消失後の再GET確定時だけtombstone解放・監査1件 | 回収後Attempt照合・`UNKNOWN`化は未実施。                                 |

(a)を選ぶ場合のゲート追記案は、次のとおりである。

> [x] D-29: 縮小値（lease 6秒 / heartbeat 2秒）の疑似subprocessでlease維持、drain両分岐、stale候補化、lease token fencing、停止証拠必須、監査付きforce-unlockを確認。正常な長時間Runは縮小値代替であり、実運用値決定、実Cloud Run照会、複数ホスト、実運用スケール長時間Run、実subprocess drain、schema v2、回収後Attempt照合を限定条件として後続管理する（2026-08-29、詳細はD-29節）。

(b)を選ぶ場合はゲートを未チェックのまま維持し、同じ実測記録と残余項目をD-29節へ追記する。

## 4. D-14とSuperseded

D-14（新旧lock protocol移行方式）は依然未実施であり、D-29を`DECIDED`化する場合も閉じない。

今回の提案に**Supersededはない**。既存のD-29契約を削除・置換せず、実測記録、状態選択肢、限定条件を追記する。

## 5. 承認事項

ユーザーは次のいずれかを最終承認する。

- **(a) 推奨:** D-29を`DECIDED`化し、上記限定付きで凍結ゲートをチェックする。
- **(b):** D-29を`PROPOSED`のままとし、実測記録だけを追記する。

いずれの場合も、D-14は未完了、Supersededなし、残余項目は削除しない。
