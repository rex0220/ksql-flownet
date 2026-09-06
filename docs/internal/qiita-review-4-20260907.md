# 【kSQL-FlowNet #4】運用編 下書きの外部レビュー裁定(2026-09-07)

対象: docs/internal/qiita-draft-4.md(commit 8e8dfd4)。ChatGPT の指摘を仕様書 §6.4〜§6.7・§7.3 と突き合わせて採否を決めた。

| # | 指摘 | 裁定 | 反映・根拠 |
| --- | --- | --- | --- |
| 必須 1 | START 許可 CSV は認可ではない。「一覧にない network は NETWORK_NOT_ALLOWED」は誤り | 採用 | CSV は入力候補、自由入力でも三重ゲートを満たせば起動できる、拒否されるのは allowlist にない/app_start 無効の network、と書き換え(仕様書 §6.4・§7.4) |
| 必須 2 | 補正モードで対象期間と業務キーの両方を渡すと KEY_POLICY_MISMATCH になるのでは | 不採用(表は正しい) | 仕様書 §6.5: scheduled_period の補正は business_key と scheduled_for の **両方必須**(片方だけなら AS_OF_UNDEFINED)。KEY_POLICY_MISMATCH は explicit に scheduled_for を付けた場合。表に「両方必須」「対象期間は as_of に使われる」「片方だけだと AS_OF_UNDEFINED」を追記 |
| 追加 1 | IDLE の行がボタン表にない | 採用 | 「ボタンなし。Run レコードはあるが未開始(started_at なし)。起動処理が続けば LIVE、長く IDLE なら二次対応者へ」を追加(仕様書 §7.3) |
| 追加 2 | フロー図の CLI 名を抽象化(RELEASE が見えない) | 採用 | 「要求に対応する CLI 操作を実行」へ |
| 追加 3 | RETRY_BRAKE の表現 | 採用 | 「同じ失敗が 3 回続いたため、次の定期 resume でも再実行しない安全装置が働いている」へ |
