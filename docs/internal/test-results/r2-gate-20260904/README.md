# R2 バージョン確定ゲート実施記録(2026-09-04)

リリース準備 R2(docs/internal/release-plan.md)の全ゲート確認の証跡。対象は version 1.0.0 確定・プラグイン manifest version 1 リセット後の main。

## 静的・単体ゲート

| ゲート | 結果 |
| --- | --- |
| `npm run build`(tsc) | 合格(pretest 経由) |
| `npm run build:plugin`(esbuild) | 合格(pretest 経由) |
| `npm run typecheck` | 合格 |
| `npm run lint`(eslint) | 合格 |
| `npm test`(単体) | 519/519 合格 |
| `npm run pack:plugin` | 合格 — zip 内部 manifest `version: 1` を二段展開で確認、恒久署名鍵使用(プラグインID不変) |

## 実機E2Eゲート(直列・profile e2e)

代表セット 13 本を直列実行し全合格。結果JSONは `tests/e2e/results/`(ローカル・秘匿済み)。

| スクリプト | 結果 | 所要 |
| --- | --- | --- |
| p2-01-01-rerun | 合格 | 37.7s |
| p2-01-02-rerun-from | 合格 | 85.3s |
| p2-01-03-rejections | 合格 | 47.5s |
| p2-01-04-stop-release | 合格 | 42.4s |
| p2-01-05-claim-stale | 合格 | 98.8s |
| p2-01-06-get-failclosed | 合格 | 15.6s |
| p2-11-04-rejections | 合格 | 30.7s |
| p2-11-01-explicit | 合格 | 17.6s |
| p2-11-02-scheduled | 合格 | 27.6s |
| p2-11-03-duplicates | 合格 | 48.7s |
| p2-11-05-stale-regression | 合格 | 62.1s |
| m5-serial-success(m系代表) | 合格 | 19.8s |
| m6-01-resume-identity(m系代表) | 合格 | 27.3s |

CSV系E2E(csv1×4+csv2×4)は段階1・段階2の受入(csv1-20260904 / csv2-20260904)で全合格済みのため本ゲートでは再実行していない。

## 特記事項

- 初回実行は preflight(未処理要求ゼロ確認)で停止。原因は P2-11 ボード受入(2026-09-02)時に UI から起票した START 要求 #105/#106(`KSQL_FLOW_TEST_P211UI01_scheduled` 系・未claim `REQUESTED`)の残渣。E2E専用要求アプリの当該2件であることを id/状態/プレフィックスで照合してから削除し、再実行で全合格。
- tag候補コミット: この記帳コミット(main 先端)。以後のコード変更が生じた場合は R2 をやり直す。
