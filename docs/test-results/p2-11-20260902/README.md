# P2-11 M3 実機受入結果(2026-09-02)

- 対象: [P2-11仕様 FROZEN v6](../../p2-11-adhoc-start-spec.md) §6受入1〜4・6・8(第1段)、[実装計画](../../p2-11-implementation-plan.md)§5
- 環境: スパイク環境(E2E用実行管理/監査/操作要求/JOBログアプリ、E2E profile)。実行前に`templates/add-start-fields.console.js`をE2E操作要求アプリへ適用(ユーザー実施・デプロイ確認済み)
- 前提ビルド: ブランチ`p2-11/start-request`(M1: d7347d3 / M2: b8357b3 / M3準備: 5f00da4)+本記録と同時コミットのE2E修正

## 結果一覧(最終クリーン直列実行 05:29〜05:31 JST+VPSではなくローカル)

| シナリオ | 受入 | 結果 | 証跡JSON |
| --- | --- | --- | --- |
| p2-11-04-rejections | 受入4(拒否系・状態不変) | 合格 | 2026-09-02T05-29-08.566Z |
| p2-11-01-explicit | 受入1(explicit一気通貫) | 合格 | 2026-09-02T05-29-41.866Z |
| p2-11-02-scheduled | 受入2a/2b(定期キー・correction・as-of断面) | 合格 | 2026-09-02T05-30-01.437Z |
| p2-11-03-duplicates | 受入3(NOOP・未完了block・並行2件) | 合格 | 2026-09-02T05-30-27.999Z |
| p2-11-05-stale-regression | 受入6/8(claim後クラッシュSTALE・回帰) | 合格 | 2026-09-02T05-31-23.866Z |

- 受入2bは案件管理(読取のみ)の独立集計値をASSERTへ埋め、8月断面の件数・売上合計が`as_of=scheduled_for`のRunで一致することを直接確認(regular=定期キー導出、correction=`…@2026-08-correction-1`+同一対象期間)
- 受入3の並行敗者codeはP-04どおり固定せず(観測はRun一意・非resume・1件のみ作成)
- 受入4の非冪等(NETWORK_NOT_IDEMPOTENT)は仕様どおり単体S03のみで担保
- **P2-01回帰**: ensure-run補正(P-01: `RUN_ALREADY_EXISTS`)の影響確認として全6シナリオ再実行、全合格(05:42〜05:47の証跡JSON)。cron相当`--scheduled-for --resume`経路もp2-11-05内で確認

## 実施中に検出・修正した問題(すべてE2E側。製品コードの修正なし)

1. **NETWORK_LOCK tombstoneと状態不変検証**: ensureRunはMAX_ACTIVE_RUNS等の裁定前にNETWORK_LOCKレコードを作成し、解放はtombstone(LOCKDONE)方式でレコードが残る(実測: レコード#1009、P2-11以前からの基盤挙動)。受入4の「状態不変」をRun/Invocation/Node stateの不変と解し、検証を「stateはNETWORK_LOCKのみ増分・改版許容+監査は完全一致」へ修正(盲点を作らない形で許容型を明示)
2. **DONEのresult_code期待値**: 成功STARTのresult_codeはInvocation result codeの転記で`OK`(G-04/G-07・P2-08の規約どおり)。E2Eの期待値`SUCCESS`を修正
3. **kintone実測: 非unique文字列1行の`=`はトークン一致**: `business_key = "…@2026-08-correction-1"`のクエリが`…@2026-08`のレコードも返した(逆方向も同様の危険)。製品側は`record_key`(unique+SHA-256)の`in`クエリとJS側厳密比較で安全なことをコードで確認。E2Eの`loadRunGraph`へ取得後JS厳密一致フィルタを追加(cleanupM5Recordsと同じ前例)
4. **cron回帰fixtureの期待値未設定**: scheduled fixtureのASSERTプレースホルダ未置換で失敗→8月窓の独立集計を設定してから起動するよう修正(9月窓は案件データ0件のため対象月も8月へ)

## 残作業(M4)

- ボードUI(新規実行ボタン・入力モード切替・処理待ちSTART表示)+受入5・7
- 文書改訂(ops-first-response/runbook — allowlist除去時のstale START滞留の人手決着手順を含む)
- 本番適用(4268への3欄追補・プラグイン更新・VPS allowlistへ`app_start: true`明示は最後)
