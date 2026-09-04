# 統合仕様書レビュー(ChatGPT・2026-09-05)の採否

総合評価 8.6/10・条件付き承認。修正必須4件+改善候補4件。Claude が実装・templates/README と突き合わせて裁定し、同日反映(specification.md)。

| # | 指摘 | 採否 | 根拠・反映 |
| --- | --- | --- | --- |
| 1 | JOBログをテンプレートに含めるかが §2.1/§3.1 と §3.5 で矛盾 | 採用(所有と配布を分離して説明) | templates/README §冒頭で「配布は4アプリテンプレートが正、Console スクリプトは JOBログを作らない」が確定済み。§3.5 に「所有=kSQL-Flow、配布に含めるのは `related_job_logs` の参照を張り替えるため。既存 JOBログを使う場合は参照先を付け替える」を追記 |
| 2 | `inputs/outputs`(YAML)と `in/out`(ディレクトリ)の表現が曖昧 | 採用 | §2.2 の環境変数行を「`nodes[].inputs` / `nodes[].outputs` を持つ network で必須。入力は `<IO_DIR>/in`、出力は `<IO_DIR>/out`」へ |
| 3 | `scheduled_period` の business key のみ指定が CLI(許可)と START(`AS_OF_UNDEFINED`)で異なる | 採用 | 実装どおり(src/domain/business-key.ts は許可、src/requests/start-request.ts は拒否)。§4.6 に「CLI 共通規則。START は §6.5 の追加制約で scheduled_for 必須」を追記 |
| 4 | Markdown がエスケープされている | 不採用(該当なし) | チャット貼付時の加工。リポジトリの specification.md は prettier 合格・GitHub 描画正常 |
| 5 | `max_active_runs` と Network ロックの関係 | 採用 | ensure-run は別業務キーの未完了 Run 数を数え、Network lease は profile・network 単位で直列化。§4.2 の行に「並列度ではない」を明記 |
| 6 | ensure-run NEW の原子性 | 採用 | src/orchestration/ensure-run.ts: bundle upload → createRun(重複禁止 INSERT=コミットポイント)→ 添付検証 → ensureNodeStates(不足補完・不一致は RUN_SNAPSHOT_MISMATCH)→ Invocation。§5.3 に順序と途中失敗時の挙動の表を追加 |
| 7 | 集約説明に `BLOCKED` が混在 | 採用 | §3.2 の集約規則を条件→Run状態の対応表へ |
| 8 | 「同じ business key での再起票」の表現 | 採用 | §7.4 を「新しい Run は作られない。処理中要求との重複は起票前ガード、終端後は ensure-run が NOOP / RUN_ALREADY_EXISTS で裁定」へ |
| 構成 | 規範仕様・構築ガイド・操作ガイドへの分割 | 保留 | 現段階は仕様確定用に一冊集約を維持(レビュー自身も「今すぐ分割必須ではない」)。R4 導入手順書(docs/installation.md)が構築ガイドの受け皿になる |

## 再評価(同日・9.1/10)の採否

前回の重大論点3件は評価側が撤回(記述不足・照合事項へ引き下げ)。新たな4点:

| # | 指摘 | 採否 | 根拠・反映 |
| --- | --- | --- | --- |
| ① | 「終端」の意味が章で曖昧(activity・STOP受付・再開可否・lifecycle/resume_allowed) | 採用 | run-activity.ts(終端4状態はactivity null)、poller(STOPはRUN_TERMINAL)、ensure-run(resume条件)から、§3.2に「終端/再開可能/最終終了」の用語表と lifecycle_status・resume_allowed の位置づけを追加 |
| ② | STOP後にFAILEDになるとholdが残り、ボードから操作不能になり得る | 採用(制約明記+backlog) | **実装確認で実在**: 終端Runはactivity nullのためRERUNはensure-run `RUN_ON_HOLD`、アプリRELEASEはpoller `RUN_NOT_ON_HOLD`で拒否。CLI `cancel-run --release`のみ。R2凍結のためコードは触らず、§7.3・§9・runbookに手順を明記し P2-15 を起票 |
| ③ | §7.4の月次補正例に対し§4.7 allowlistのmonthly_summaryに`app_start: true`がない | 採用 | §4.7の例へ`app_start: true`を追加(コメント付き) |
| ④ | 起票前ガードは同時起票を完全には防げない | 採用 | §7.4を「既存の処理中要求への重複起票を抑止。同時起票の重複要求は残り得るがRunの重複はensure-runが防ぐ」へ(要求の重複とRunの重複を分離) |
