# R2 バージョン確定ゲート やり直し実施記録(2026-09-05)

P2-16(操作要求ライフサイクル v2)を v1.0.0 に同梱したため、release-plan R2 をやり直した。対象は main `92bad60`(P2-16 M0〜M5 取り込み・plugin version 1 リセット済み)。前回の記録は [r2-gate-20260904](../r2-gate-20260904/README.md)。

## 静的・単体ゲート

| ゲート | 結果 |
| --- | --- |
| `npm run build`(tsc) | 合格 |
| `npm run build:plugin`(esbuild。PUT リテラル 1 回のみ・DELETE/cursor/bulk なしの境界検査込み) | 合格 |
| `npm run typecheck` | 合格 |
| `npm run lint` | 合格 |
| `npm run format:check`(リポジトリ全体) | 合格 |
| `npm test`(単体) | 575/575 合格(P2-16 で +56) |
| `npm run pack:plugin` | 合格 — manifest `version: 1`、恒久署名鍵(プラグインID不変) |

## 実機E2Eゲート(直列・profile e2e・全合格)

| スクリプト | 結果 | 所要 |
| --- | --- | --- |
| p2-01-01〜06(6本) | 合格 | 43.9 / 88.1 / 42.0 / 41.1 / 90.7 / 17.1s |
| p2-11-04・01・02・03・05(5本) | 合格 | 31.6 / 18.9 / 25.8 / 49.5 / 59.7s |
| m5-serial-success / m6-01-resume-identity(m系代表) | 合格 | 18.9 / 31.3s |
| p2-16-01・04・03・05・02(5本) | 合格 | 4.4 / 84.6 / 38.0 / 34.0 / 21.3s |

CSV系E2E(csv1×4+csv2×4)は csv1/csv2-20260904 で合格済みのコードから変更がない(src/io・kSQL-Flow 契約は P2-16 で不変)ため再実行していない。

## 凍結

- tag 候補コミット: 本記録+本番適用記録の commit(main 先端)。以後のコード変更は R2 をやり直す
- 例外として記録: 本番適用中に、プラグイン起動ログの版表示がハードコード `v2` で manifest(1)と食い違うことが判明し、build 時に manifest version を埋め込む修正(plugin/scripts/build.mjs・plugin/src/desktop.ts のログ 1 行)を入れた。src/ とポーラー・CLI は不変で、E2E はプラグイン bundle を実行しないため E2E は再実行せず、単体 575 件・typecheck・lint・build:plugin・pack:plugin の再実行で確認した
- 本番適用(要求アプリ追補・プラグイン更新・VPS `92bad60`・smoke)の記録は [p2-16-production-20260905](../p2-16-production-20260905/README.md)
