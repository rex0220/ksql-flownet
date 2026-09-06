# 【kSQL-FlowNet #3】network 定義編 下書きの外部レビュー裁定(2026-09-07)

対象: docs/internal/qiita-draft-3.md(commit d1ed862)。ChatGPT の指摘を仕様書 §4・§5.3 と実装(LeaseMonitor・ensure-run)と突き合わせて採否を決めた。

| # | 指摘 | 裁定 | 反映・根拠 |
| --- | --- | --- | --- |
| 必須 1 | 冪等性の定義「毎回同じ結果」は読取ゲート(データ修正後に FAILED→SUCCESS)と矛盾。「累積する副作用を起こさず正しい状態へ収束」が正しい | 採用 | 定義を書き換え、ゲートの例で補足。判断基準も「副作用がない / 収束する / 累積する」の観点へ。UPSERT は `as_of` 固定の入力を全件書き直す前提を明記 |
| 必須 2 | 「`false` があっても resume はできる」が表の「resume 拒否」と矛盾 | 採用 | 「cron / CLI から新規 Run は起動できる。resume で `false` ノードの再実行が必要なら拒否され、resolve-node 後に再開。START 対象にはならない」へ。表も「再実行対象に含まれると」に |
| 必須 3 | lease は最長ノードより長くする必要はない(heartbeat で更新され続ける。lease は heartbeat 途絶後の猶予) | 採用 | 実装どおり(実行中は LeaseMonitor が heartbeat で lease を更新)。説明とまとめ表を「heartbeat 途絶後の保持時間、ノードの実行時間に依存しない、300/60 秒は 5 回分の余裕」へ。「ロック取得と resume は別」も明記 |
| 漏れ | 配置図に `monthly_deal_summary.sql` がない | 採用 | ツリーに追加 |
| 手順 | 定義変更時はポーラーだけでなく定期 cron も止める(すべての新規起動経路) | 採用 | 「ポーラーと対象 network の cron を停止するか発火時刻を避けて配置。validate → plan → kSQL-Flow validate -f → --check の後に再開」へ |
| 表現 1 | `plan` は「SQL に触れない」より「kintone API を呼ばず SQL を解析・実行しない」 | 採用 | 書き換え(定義読込時に SQL ファイルの存在は見るため) |
| 表現 2 | 仕様書リンクを v1.0.0 タグ固定に | 採用 | 冒頭とリンク節を `blob/v1.0.0/` へ |
