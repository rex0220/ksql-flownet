# FDR再審議提案 2026-08-31b: `--rerun-from`非冪等拒否条件の精緻化(R2-1)+文書明確化

状態: REFLECTED(2026-08-31承認・実施済み。m7-05実機合格、受入マトリクス更新済み)
契機: 凍結後外部評価(`docs/internal/phase1-spec-review-2.md` R2-1)。凍結版に対する初の再審議。

## A. 再審議対象: 受入12・§7.2の拒否条件(意味論変更)

### 現行規則の問題(裏取り済み)

現行: 「対象集合に`idempotent = false`のノードが**含まれる**場合は実行しない」(§7.2 546行、受入12、`ensure-run.ts` 733-741行)。実行履歴を見ないため:

- §4.1の例(`send_invoice: idempotent=false`が終端)では、§9のCLI例`--rerun-from aggregate_customer`が**常に拒否**される。非冪等な終端ノード(通知・請求・外部連携)を持つDAGは実務の多数派であり、`--rerun-from`が事実上使えない
- `--resume`は未実行の非冪等ノードを普通に初回実行するため非対称(同じ未実行`send_invoice`が、resumeでは走り、rerun-fromでは全体を止める)

### 改定案

> 対象集合のうち、`idempotent = false` **かつ 既存のNode Attemptを持つ(`latest_attempt_no > 0`)** ノードがある場合は拒否する。未実行(`latest_attempt_no = 0`)の非冪等ノードは、`--resume`と同様に初回attemptとして実行できる。

根拠: `--rerun-from`が`--resume`に対して追加するリスクは「実行済みノードの強制再実行」だけである。attemptを一度も持たないノードの初回実行は、resumeが行う実行と完全に同一であり、二重実行リスクは存在しない。

### 検討して見送った代替案

「FlowNet耐久開始マーカー(`execution_started_at`)を持つattemptがある場合のみ拒否」(§8.1の二重マーカー意味論に厳密整合。LOCK_CONFLICTでPREPARE_FAILEDのみのattemptを持つ非冪等ノードも許可できる)— より精密だが規則が複雑化する。`latest_attempt_no > 0`案では、このPREPARE_FAILEDのみのコーナーケースは**保守側(拒否)**に倒れ、その場合は`--resume`で自然に継続できるため実害がない。Phase 1は単純・保守側の`latest_attempt_no > 0`を採用し、マーカー基準への精緻化はPhase 2判断とする。

### 変更箇所

1. 仕様§7.2(546行): 拒否条件の文言改定+見送った代替案の1行注記
2. 仕様§12受入12(748行): 「対象集合に`idempotent = false`かつ既存attemptを持つノードがあれば拒否する」へ
3. `ensure-run.ts`: 判定を`!value.idempotent && value.latest_attempt_no > 0`へ、エラーメッセージも「実行済み非冪等ノード」へ(コード名`RERUN_FROM_NON_IDEMPOTENT`は維持)
4. unit回帰: 未実行非冪等の許可 / 実行済み非冪等の拒否 / PREPARE_FAILEDのみ(latest_attempt_no>0)の拒否
5. E2E追加(m7-05): §4.1型DAG(非冪等終端が未実行)で`--rerun-from`成功、同ノード実行後は拒否、の両分岐を実機検証。受入マトリクス受入12を更新

## B. 同時実施する文書明確化(意味論変更なし、R2-2/5/6/7)

1. §10: 「Run集約`RUNNING`は未完了の意であり、生きた実行の存在を意味しない。実行中の判別はNetwork lockのowner/stale_candidateで行う。UNKNOWN>RUNNING>FAILEDの優先順位は安全側の意図的な設計である」を明記
2. §4.2: 「非決定要素検査は補助であり、`idempotent`宣言の正しさは定義作成者の責務。キー指定のないINSERTや外部通知は決定的でも非冪等である」を明記
3. §4.3: `max_active_runs`へ「並列度ではない(Phase 1はNetwork lockにより常に直列)」を追記
4. §7.1: resume手順へreconciliation実施(受入18)のステップを追記(実装との整合)
5. §14(789/794行): 凍結版/FDR ACCEPTEDに合わせ文面更新
6. FDR冒頭: 「本文中の日付付き追記にある『PROPOSEDを維持する』等は当時の履歴であり、現在状態は§2判断表とヘッダが正」の注記
7. §9: NEW時の`as_of`決定(`--scheduled-for`指定時はその値、なければ実行時刻。snapshotへ固定しresume中は不変)を明記
8. runbook(recovery): ノード実行時間の上限は現状kSQL-Flow側`batch_timeout_sec`とrun-subprocessのkill経路に依存する旨を注記(P2-04の現状記録)

## C. Phase 2バックログ追加

implementation-planへ: P2-02(ノード境界停止要求 — 実行中subprocessは完走待ち・次ノード不起動、優先度高)、P2-03(同一ノード連続失敗N回のブレーキ)、P2-04(FlowNet側ノード単位上限時間)。

## 実施順

FDR追記(本提案の承認記録+D-19/受入12関連節の改定履歴)→仕様・文書改定→codex実装+unit→E2E m7-05実機→受入マトリクス更新→コミット(docs/fix/testを分割)。
