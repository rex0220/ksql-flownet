# 【kSQL-FlowNet #6】障害対応編 下書きの外部レビュー裁定(2026-09-07)

対象: docs/internal/qiita-draft-6.md(commit ec497ac)。ChatGPT の指摘を復旧 runbook・仕様書 §2.2/§5.2/§5.6 と突き合わせて採否を決めた。

| # | 指摘 | 裁定 | 反映・根拠 |
| --- | --- | --- | --- |
| 必須 1 | `run-network --resume-run` に network 定義の位置引数がない。RETRY_BRAKE の CLI も完全形に | 採用 | `run-network flownet/monthly-summary/network.yaml --resume-run <run_id>`(`--rerun-from <node_id>`)の完全形へ。「第 1 引数は status と違って定義ファイルのパス」を明記(runbook §6)。図の最終ノードも修正 |
| 必須 2 | SERVICE_PRINCIPAL と REQUESTED_BY を同一人物にするのは監査上不適切では。`--stop-confirmed-by` にサービス主体を渡すべきでない | 部分採用 | runbook「前提」は「操作者は両方を自分の認証主体で設定した環境から操作する」と規定しており、仕様書 §2.2 も SERVICE_PRINCIPAL を「復旧コマンドを実行する操作者の認証主体」と定義。したがって記事の記述は正本どおりで、変数の役割分離は不採用。ただし cron 実行時との違い(ホスト / cron@host)を補足し、`--stop-confirmed-by` は環境変数ではなく「停止を確認した人の識別子」の明示に変更 |
| 必須 3 | UNKNOWN を FAILED にしただけでは安全に再実行できない。非冪等は resume が拒否される | 採用 | 表を「未実行、または部分書込みを補償して再実行できる状態へ戻した / 冪等性とリラン条件を確認して再開」「補償したうえで打ち切る」へ。本文に補償完了と非冪等の resume 拒否(仕様書 §5.3)を明記 |
| 必須 4 | 監査レコードの「手で追記」を具体化(runbook 所定の手順、元の event_id、重複確認、実施者・理由) | 採用 | runbook「CLOSE(archive-run)の復旧」に従う旨、元の event_id を使う、同一 event_id の不在を再確認、`record_type`/`result_code`/`record_key = OP:<event_id>`/`reason` JSON の内容、推測で埋めない、を本文に |
| 追加 | PID 再利用の考慮 | 採用 | 「PID が存在する場合は本人とは限らない。開始時刻・コマンドライン・ホスト再起動時刻も証拠に」を追加(runbook の残余リスクと同旨) |

## 第 2 巡(521c8b5 に対して)

| # | 指摘 | 裁定 | 反映 |
| --- | --- | --- | --- |
| 1 | 判断フローで lease 生存(LIVE)のロックを「ロックなし」と同じ経路へ流している | 採用 | lock の状態を LIVE / stale_candidate / なし の 3 分岐に。LIVE は「実行中。待つ、必要なら STOP 要求」で止め、UNKNOWN 裁定や強制解放へ進めない。本文にも 1 文追加 |
| 2 | 「自由記述の主体入力は存在しない」と `--stop-confirmed-by` のプレースホルダーが食い違う | 採用 | 前提を「操作者の主体は環境変数から監査に入る。--stop-confirmed-by は確認者を記録する引数で通常は操作者本人($KSQL_FLOWNET_REQUESTED_BY)」に整理し、例も環境変数に統一 |
| 3 | kintone 側の仕様 2 点(DATETIME 分精度、API トークン作成者=Administrator)に出典か実測の注記 | 採用 | 分精度は「分単位で保存(秒は切り捨て)。筆者の実測」、Administrator は #5 の該当箇所を「API トークン認証の仕様。検証環境でも同じ」に |
