# PRE-05 棚卸し結果: my-ksql-jobs 全ジョブの非冪等判定

- 実施日: 2026-08-31
- 方式: 一括棚卸し→逆引き(ユーザー指示)。判定基準の正本は[討論§11.2](./kintone-ops-roadmap-discussion.md)の7項目
- 対象範囲: `my-ksql-jobs`で**定期運用されるジョブ**。cron/`run_batch.sh`/リランポーラー/container(Cloud Run)のすべてが同一の`run-all ./jobs`を起動することを確認済みであり、定期対象は`jobs/`配下の3本で完全。`dev/`配下(64本中61本)はロック訓練・障害訓練・スケール試験用であり定期運用されない(対象外)

## 対象業務: 月次案件集計バッチ(1業務・3ジョブ)

実行順(現行run-all): `00_intake_count` → `10_test_data_gate` → `monthly_deal_summary`(`depends_on: test_data_gate`)

### ジョブ別判定(7項目)

| # | 観点 | intake_count | test_data_gate | monthly_deal_summary |
| --- | --- | --- | --- | --- |
| 1 | キー指定更新か | 書込なし | 書込なし | ✓ `UPSERT ... KEY(会社名)`(会社名は重複禁止フィールド) |
| 2 | bare INSERT/履歴追記 | なし | なし | なし |
| 3 | DELETE | なし | なし | なし |
| 4 | 採番・連番 | なし | なし | なし |
| 5 | 外部副作用(通知・請求・外部API) | なし | なし | なし |
| 6 | 集計の自己参照 | — | — | なし(集計元=案件管理、書込先=顧客管理で**別アプリ**) |
| 7 | as-ofで固定されない非決定要素 | なし | なし | **`@NOW()`あり**(下記) |

- intake_count: 読取ゲートのみ(`EXIT SUCCESS IF`)。**冪等**
- test_data_gate: 読取ASSERTのみ。**冪等**
- monthly_deal_summary: 集計→`会社名`キーのUPSERTで毎回全対象を書き直す設計(スクリプト内コメントにも「何度流しても同じ結果」と明記)。`@MONTH_START()`/`@NEXT_MONTH_START()`はas-of注入で固定される。**冪等**

### 項目7(`@NOW()`)の扱い(2026-08-31実機確認で訂正)

実機の`inspect-job --json`は`nondeterministicElements: []`を返し、**`@NOW()`を非決定要素として検出しない**(kSQL-Flowでは`@NOW()`/`@MONTH_START()`等はas-of注入から導出される決定的関数として扱われる — スクリプト内コメント「as-of注入で過去月のバックフィルも同一スクリプトで再現可能」と整合)。したがって**KSQL1306例外承認は不要**で、項目7も完全通過。当初「例外承認の実運用初例」と書いたが、実機出力を正として撤回する。

### `idempotent`宣言の検証について

現行はrun-all運用のため宣言自体が存在しない(宣言はFlowNetの`network.yaml`で新設する)。本棚卸しがそのまま**宣言の新規作成根拠**となる: 3ノードすべて`idempotent: true`(根拠は上表)。

## 逆引き結果と結論

**定期運用中の唯一の業務「月次案件集計バッチ」は、全3ノード冪等で閉じている。**

- 初回導入の技術的選定基準(vision §5「全ノード冪等で閉じられる業務」)を**そのまま満たす**
- したがって承認者問題(D-13の`--approved-by`)・縮退運用の3択は、**初回導入の前提条件から外れる**(討論§11の予測どおり)
- Dq-4のうち技術判定に依存する部分はこれで解消。残るのは「この業務を初回対象とする」という確認のみ

## 導入時の設計メモ(network.yaml化)

- 現行`depends_on: test_data_gate`はFlowNetのDAGへ`n2→n3`としてそのまま写せる。`00_intake_count`は依存なしの先頭ノード(現行はファイル名順の直列)
- business keyは`scheduled_period`(月次)が自然: `monthly_deal_summary@<YYYY-MM>`形式。バックフィルは`--business-key`+as-of固定で現行の`--as-of`運用を置き換える
- 現行のリランポーラー(`--resume-batch`)は、切替時にP2-01(FlowNet版ポーラー)またはcron `--resume`へ置き換える(移行runbookの業務単位切替・並走禁止に従う)
