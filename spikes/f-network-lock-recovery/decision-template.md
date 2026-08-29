# Spike F D-29判断案

> **判断案であり正本ではない。** 最終判断とFDRへの反映はユーザー承認後に行う。

## D-29: Network lock recovery

- 判断案: **採用**。FDR状態は`DECIDED`化を推奨する。ただし、下記の残余項目を限定条件として明記し、凍結ゲートをチェックするかはユーザーが最終判断する。
- 判断日・判断者: 2026-08-29（JST）／判断者はユーザー承認時に記録
- 実測環境: `LAPTOP5` / `win32` / Node.js `v24.14.0` / `devenxyfi.cybozu.com`、単一ホスト
- lease duration・heartbeat intervalと境界: lease 6秒、heartbeat 2秒。`heartbeat < lease`かつ`heartbeat <= lease / 3`を満たす縮小値。実運用値は未決定。
- heartbeat・subprocess: 疑似subprocess `5276.8794 ms`中にheartbeat 2回（間隔`2005.7992 ms`、`2734.3747 ms`）を継続し、exit 0。
- drain開始条件・新規Node停止規則: heartbeat連続2回失敗で`LEASE_UNCERTAIN`へ遷移。回復／未回復の両分岐でdrain後の新規Node起動0。
- 実行中subprocessと結果保存規則: 両分岐で疑似subprocessは完走。再更新成功時だけ結果を保存して`RECOVERED_AND_CANCELLED`、失敗時はStateを書かずreconciliation材料を保持して`RECONCILIATION`。
- stale候補化条件: heartbeat age 26.8秒、lease期限超過でstale候補化。observerはGET 1回、lock write 0回で、旧owner停止未確認なら回収しない。
- lease token fencing結果: 旧ownerを再GETの`LEASE_TOKEN_MISMATCH`とState PUTのHTTP 409 / `GAIA_CO02`の二重防御で拒否。旧ownerのState更新・次Node起動はいずれも不許可。
- 同一／別ホスト停止確認方法: 管理済み停止証拠参照を必須とする契約を確認。参照欠落の初回CLI実行は「停止証拠必須」で拒否し、`spike://f/...`を渡した2回目だけ合格。同一ホストPIDの実停止確認、別ホスト確認、参照内容のadapter照会は未実施。
- Cloud Run terminal受理状態・fail-closed状態: モックunit testで`SUCCEEDED` / `FAILED` / `CANCELLED`だけをterminal受理し、`RUNNING` / `PENDING` / 未知状態 / 403 / 通信失敗をfail-closedに固定済み。実Cloud Run照会は未実施の手動項目。
- `force-unlock-network`のexpected owner／revision／token／再GET規則: owner不一致・revision不一致は解放も監査もせずfail-closed。lease identity、stale候補、停止証拠、新heartbeat・ownerなしも必須。応答消失時は再GETの`RELEASE_CONFIRMED`時だけ成功扱い。
- 監査event必須項目: network、profile、lock key、旧owner、旧lease token、認証主体、確認者、理由、証拠、停止確認方法、時刻、結果、回収後revision。成功caseで監査1件を確認。schema v2で専用field/event codeを固定する。
- 通常解放: 必須・重複禁止キーをunique tombstoneへrevision付き単一UPDATEする方式で、5結果すべて解放成功。
- 回収後Attempt照合・UNKNOWN規則: 仕様上は開始証跡とJob lockを照合し、未確定時は`UNKNOWN`とする。Spike Fでは未実施。
- `control_plane_api_calls`容量評価: heartbeat計測範囲4 calls、`0.7580237668497788 calls/s`（表示値0.758 calls/秒）。実行全体6 calls。縮小値の単発測定であり、実運用容量評価は未完了。
- 根拠となる測定行ID: F-01〜F-08、F-14、F-16、F-17。F-09は停止証拠参照の必須契約のみ確認。F-10〜F-13、F-15、F-18の実環境測定は未実施。
- 記録すべき残余リスク: Network token照合とState更新間のTOCTOU窓、実運用値未決定、単一ホスト・短時間・縮小値測定、fetchラッパー注入、実runtime停止確認なし、Attempt照合未実施、schema v1代替fieldの使用。
- 明示的な限定条件／後続項目:
  1. API予算とRun時間分布からlease duration、heartbeat interval、連続失敗閾値の実運用値を決定する。
  2. 実Cloud Run Execution照会を行う。
  3. 複数ホストで旧owner停止確認と回収を測る。
  4. 実運用スケール値の長時間Runと実subprocess drainを測る。
  5. schema v2で`acquired_at`、`owner_instance_id`、監査event code等の専用フィールドを固定する。
  6. 回収後Attempt照合と未確定時`UNKNOWN`を実測する。
- FDR D-29へ反映する状態と本文: 推奨は`PROPOSED`から`DECIDED`への変更と、縮小値で測定対象の全分岐が成立した記録の追記。残余項目はプロトコル意味論の未決ではなく、値決定・環境拡張・本番schema化の限定条件として残す。代案は`PROPOSED`維持で実測記録だけを追記する。

## 判断案の要約

D-29のrenewable lease + heartbeat + lease token + drain + 監査付き`force-unlock-network`のプロトコルは、縮小値実測で対象となった全分岐が仕様どおり成立した。通常解放のunique tombstone方式も動作した。したがって`DECIDED`化を推奨するが、凍結ゲートの「正常な長時間Run」は縮小値の疑似subprocessによる代替であり、上記限定条件を承認可能とするかはユーザーの最終判断に委ねる。

D-14（新旧lock protocol移行方式）は依然として未実施であり、D-29の判断では閉じない。
