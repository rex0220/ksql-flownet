# P2-16 M3 実機E2E 記録(2026-09-05)

仕様 [P2-16 操作要求ライフサイクル v2](../../p2-16-request-lifecycle-v2-spec.md)(FROZEN v1)の M3。E2E環境(profile e2e・E2E専用の実行管理/監査/操作要求/JOBログアプリ)。E2E要求アプリには `add-request-lifecycle-v2.console.js` を適用済み(CLOSE/CANCELLED/cancel_requested/03_取消済み/フィールド権限=機械6種 everyone閲覧のみ・cancel_requested 作成者編集可)。実行時の main 相当コミット: p2-16 ブランチ M0〜M2(0b30ac0)+M3 スクリプト。

## 結果(直列・全合格)

| スクリプト | 受入 | 結果 | 所要 |
| --- | --- | --- | --- |
| p2-16-01-cancel-before-claim | 1・11・12 | 合格 | 4.9s |
| p2-16-04-close | 6・7 | 合格 | 87.6s |
| p2-16-03-terminal-hold-release | 4 | 合格 | 34.9s |
| p2-16-05-close-rerun-race | 8b | 合格 | 35.1s |
| p2-16-02-cancel-claim-race | 2 | 合格 | 19.1s |
| P2-01 回帰 6本(01〜06) | — | 全合格 | 32.7 / 88.2 / 44.1 / 41.9 / 101.1 / 17.9s |
| P2-11 回帰 5本(04・01・02・03・05) | — | 全合格 | 29.1 / 17.5 / 24.5 / 47.7 / 57.5s |

結果JSONは `tests/e2e/results/`(ローカル・秘匿済み)。UNKNOWN Run への CLOSE 拒否(`RUN_UNKNOWN_NOT_CLOSABLE`)は kill と stale 回収を要するため E2E では扱わず、M2 単体で担保。

## 実装・ハーネスの発見と修正(2件)

1. **kintone DATETIME の分精度(ハーネス)**: `RUN_ARCHIVED` 監査の物理列 `resolved_at`(DATETIME・分切り捨て)と `reason` JSON の `archived_at`(秒付き)を厳密比較していた検査を分精度比較へ修正。仕様 §3.3 に物理列の精度を注記(統合仕様書 §9 の既知制約)。製品側の問題ではない
2. **実行中 Run への CLOSE 拒否の競合(ハーネス)**: バックグラウンドの longfail Run がタイミング次第で拒否検査中に終端し、「監査完全不変」検査に n1 Attempt の finalize(rev 2→3)が混入。STOP → hold 作成も同じ競合を持ち、最悪 CLOSE が受理される設計だった。**fault-hook の barrier で Attempt finalize の PUT(監査アプリ・`finished_at` を含む唯一の PUT。実行開始時は `execution_started_at` のみの部分 PUT)を before で停止**し、CLOSE 拒否(`RUN_NOT_TERMINAL`)と STOP → hold 作成を決定的に実施してから release する形へ修正。あわせて `assertPersistenceUnchanged` に差分レコードの種別・状態・revision を失敗メッセージへ出す診断を追加(今後の切り分け用)

## 実測で確定した事項

- 取消 PUT と claim PUT の競合は barrier(before / after-success)で両順序を固定でき、取消先勝ちは次周期で `CANCELLED / CANCELLED_BY_REQUESTER`、claim 先勝ちは要求が ACCEPTED→終端になる
- STOP 後に SQL が失敗した Run は FAILED+hold になり、`status --json` の `hold` が非 null。RELEASE 要求は Run 状態を問わず `DONE / RELEASED`、その後 RERUN が一次審査を通る
- CLOSE は `archive-run` が Network ロックを取得し、run-network がロック保持中は `LOCK_CONFLICT`。ARCHIVED 後の `--resume-run` は `RUN_NOT_RESUMABLE` で Attempt が増えない
- ARCHIVED 後の再 CLOSE は一次審査で `DONE / RUN_ALREADY_ARCHIVED`(child 未起動)
