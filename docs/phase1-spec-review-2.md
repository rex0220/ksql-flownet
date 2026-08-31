# Phase 1 凍結版 外部評価と検証結果(2026-08-31)

凍結直後にClaude/Geminiの2系統で仕様書+実装コードを相互評価した結果と、指摘のコードレベル裏取り、対処区分。凍結後のためすべての意味論変更はFDR再審議手続きに乗せる。

- 評価対象: Phase 1凍結版(FDR ACCEPTED、受入28/28、実装0.1.0)
- Gemini評: 総合S。Fail-Closed一貫性・4層モデル・不変バンドル・残余リスクの誠実な記載を評価。Phase 2論点として並列化時のAPIレート調停、チャンク再開の補償設計を提示
- Claude評: 状態モデルの狙いは達成と評価しつつ、以下6件+文書整合を指摘

## 指摘の裏取り結果と対処区分

### R2-1. `--rerun-from`が非冪等子孫を無条件拒否(重大・裏取り済み)

**確認**: `ensure-run.ts` 733-741行は`selectedStates`を`!value.idempotent`のみでフィルタし、実行履歴(latest_attempt_no)を見ない。仕様§12受入12の文言「対象集合に`idempotent = false`があれば拒否する」どおりの実装であり、**仕様レベルの規則が過剰**。§4.1例(`send_invoice: idempotent=false`が終端)では§9のCLI例自体が常に拒否される。`--resume`は未実行の非冪等ノードを普通に初回実行するため非対称。

**評価**: 指摘は正当。二重実行リスクがあるのは「既にattemptを持つ非冪等ノード」のみ。未実行(latest_attempt_no=0)の非冪等ノードの初回実行を拒む安全上の根拠はない。

**対処区分**: **FDR再審議(R2-1提案)** — 拒否条件を「`idempotent = false` かつ 既存attemptあり(latest_attempt_no > 0)」へ精緻化。仕様§7.2/受入12の文言修正+実装+回帰テスト。

### R2-2. Run集約`RUNNING`が「実行中」と「中断・未完了」を区別しない(裏取り済み)

**確認**: `run-aggregate.ts` — WAITING+SUCCESS混在で`started_at`ありは`RUNNING`。lease drain後(NODES_DEFERRED)・LOCK_CONFLICT WAITING戻し後は、プロセス不在でもRun=`RUNNING`が正常系として存在する。UNKNOWN>RUNNING>FAILEDの優先順位も実装どおり(RUNNINGノードとFAILEDノード混在時はRUNNING)。

**評価**: 指摘は正当。判別自体はstatus CLIのlock owner/stale_candidateで可能であり、意味論変更なしで文書明確化が先。

**対処区分**: **文書明確化** — §10へ「Run`RUNNING`は未完了の意であり、生きた実行の存在を意味しない(実行中の判別はNetwork lockのowner/stale_candidateで行う)」と、UNKNOWN優先/FAILED劣後が意図的である旨を明記。`status_reason`への`INTERRUPTED`相当の付与はPhase 2候補。

### R2-3. 停止(cancel)の正規経路がない(裏取り済み)

**確認**: CLIにcancel系なし。停止要求はプロセスkill→drain/孤児裁定→UNKNOWN→resolve-nodeの最高コスト経路に落ちる。

**評価**: 指摘は正当。評価者提案の「ノード境界でのみ検査する停止要求フラグ(実行中subprocessは完走待ち、次ノード不起動)」はPhase 1意味論を変えず追加可能で、通常停止がUNKNOWNを作らなくなる。

**対処区分**: **Phase 2バックログ(P2-02)** — 優先度高。graceful-stop(SIGBREAK)の現挙動はm7-04で安全性確認済みだが、正規UIとしては不足。

### R2-4. ワークフロー層に試行回数上限がない(裏取り済み)

**確認**: 冪等FAILEDはresumeごとに無条件WAITING復帰(§5.3)。ノード単位のattempt上限はコードに存在しない。cron毎時`--resume`構成では決定的失敗ノードがattemptを無限に積む。

**評価**: 指摘は正当。二重実行リスクはないがAPI・レコード消費が無限。ブレーキ(「同一ノードの連続失敗N回で明示フラグなしでは着手しない」)は安全モデル側の追加。

**対処区分**: **Phase 2バックログ(P2-03)** — ただし運用回避策(cron側のalert/停止、resume_allowed=false化)をrunbookへ追記する軽量対処はFDR再審議なしで可能。

### R2-5. `idempotent`検証が冪等性ではなく決定性を見ている

**確認**: §4.2の検査は非決定要素(時刻関数・乱数)の検出であり、操作の冪等性(キー指定UPSERT vs bare INSERT)は判定していない。`idempotent`フラグ自体は定義作成者の申告。

**評価**: 指摘は正当(概念整理として)。検査を「冪等性の検証済み」と読ませない文書上の注意が必要。操作種別分類はkSQL-Flow側の解析能力が必要でPhase 2。

**対処区分**: **文書明確化** — §4.2へ「本検査は補助(非決定要素の検出)であり、`idempotent`宣言の正しさは定義作成者の責務。キー指定のないINSERTや外部通知は決定的でも非冪等である」と明記。

### R2-6. `max_active_runs`の名前が並列度と誤読される

**確認**: 定義は「未完了Run本数」。D-03によりPhase 1で同時実行は起きない。

**対処区分**: **文書明確化** — §4.3へ「並列度ではない(Phase 1の実行はNetwork lockにより常に直列)」を1行追記。改名は破壊的変更のためPhase 2判断。

### R2-7. 文書整合(小)

| 項目 | 確認結果 | 対処 |
| --- | --- | --- |
| §7.1手順にreconciliationが無い(§10は前提にしている) | 実装・受入18には存在。手順書き漏れ | 文書修正 |
| §14がFDR `PROPOSED`前提の文面のまま(789/794行) | 確認。ヘッダの凍結版表記と矛盾 | 文書修正 |
| FDR本文のD-09/D-26/D-29節に「`PROPOSED`を維持する」が残存 | 日付付き追記の履歴として残っているが、節へ直接飛ぶ読者が誤読 | FDR冒頭へ「日付付き追記は履歴であり現在状態は§2表とヘッダが正」と注記 |
| §9 CLI例に`--as-of`が無い/NEW時のas_of導出が未記載 | 確認(676行に規則のみ) | 文書修正(NEW時: `--scheduled-for`または実行時刻から決定しsnapshotへ固定、を明記) |
| FlowNet側にノード単位上限時間が無い | kSQL-Flowの`batch_timeout_sec`+run-subprocessのkill経路依存 | Phase 2候補(P2-04)。runbookへ現状の依存関係を注記 |

## まとめ

- **FDR再審議対象**: R2-1(rerun-from拒否条件の精緻化)のみ — 意味論変更を伴う唯一の項目
- **文書明確化(意味論変更なし)**: R2-2、R2-5、R2-6、R2-7の4件
- **Phase 2バックログ追加**: P2-02(ノード境界停止要求)、P2-03(連続失敗ブレーキ)、P2-04(FlowNet側ノード上限時間)
- Gemini指摘のPhase 2論点(並列化のレート調停、チャンク補償)はPhase 2設計時の入力として本書を参照する
