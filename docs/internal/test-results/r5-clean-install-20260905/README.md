# R5 クリーンインストール検証記録(2026-09-05)

release-plan R5。R3 の検証スペース(4 アプリ)と本番 VPS 上の別ディレクトリを使い、[導入手順書](../../../installation.md)と [Claude Code 併用版](../../../installation-claude-code.md)の分担どおりに手順 1〜10 を通した。kintone 側はユーザー、サーバー側は Claude(SSH)。

## 環境

| 項目 | 値 |
| --- | --- |
| kintone | 検証スペース: 実行管理 4279 / 操作要求 4278 / 監査履歴 4280 / kSQL Flow 実行ログ 4281(R3 でテンプレートから作成) |
| サーバー | 本番 VPS と同一ホスト。`/opt/ksql-r5/{my-ksql-jobs,ksql-flownet}`、`/root/.ksql-flownet-r5.env`、`/root/flownet-request-allowlist-r5.yaml`、`/var/log/ksql-r5/`、`/var/tmp/ksql-flownet-r5` |
| kSQL-FlowNet | main `a1e30fe`(1.0.0)を clone+build |
| kSQL-Flow | ジョブ資材 `my-ksql-jobs` `0090cbb` を clone、`npm install`(ksql-flow 0.7.0) |
| profile | `r5`(prod のコピー。実行ログ=4281、業務アプリ 4246/4247 は閲覧のみトークン参照) |
| network | `flownet/intake-check/network.yaml`(読取専用 SQL 2 本: `00_intake_count.sql`・`10_test_data_gate.sql`、`app_start: true`)。業務データへは書かない |

## 手順書との差分(検証環境の都合)

- パス・ログ・profile に `-r5` / `r5` を付けた(本番と同居のため)
- network 定義はジョブ資材リポジトリへ commit せず、VPS 上の clone にローカル配置した(手順書は git 経由の配置を求める)
- ジョブ資材 `.env` の業務アプリ閲覧のみトークンは本番 `.env` からサーバー内で複写した(値は表示・転記していない)
- トークン値は `.env-TEST`(ローカル・git 管理外)を SSH でサーバーへ送り、サーバー内で環境ファイルへ結合した(併用版の「人が SSH で転記」の代替)

## 結果

| 手順 | 内容 | 結果 |
| --- | --- | --- |
| 2〜3 | テンプレートから 4 アプリ(R3)、API トークン 5 本の発行と「アプリを更新」 | OK(ユーザー) |
| 4 | 4278 に `add-request-lifecycle-v2.console.js`(フィールドアクセス権)、4281 に kSQL-Flow の `logapp_v04_field_acl.console.js` | OK(ユーザー。トークンでは field/acl を読めないため API 確認は不可、取消の成立で機能確認) |
| 5 | プラグイン設定「START を許可するネットワーク」に `案件件数ゲート(当月), intake_check, 定期` | OK(ユーザー) |
| 6 | clone、`npm install`、`.env`、`validate --check-logapp --profile r5` | OK: `ログアプリ (ID 4281) は 8.2 のフィールド定義を満たしています` |
| 7 | clone、`npm ci`、`npm run build`、`--version` | OK: `1.0.0` |
| 8 | 環境ファイル(export 形式・0600・LF)、network `validate`/`plan`、allowlist、起動スクリプト `chmod +x` | OK。`plan` の業務キー `intake_check@2026-09` |
| 9 | `poll-requests --check` | OK: `ok networks=1 request_app=readable` |
| 9 | 初回定期実行 `run_intake_check.sh --json` | OK: `NEW / SUCCESS`。`status intake_check --profile r5 --json` の Run = SUCCESS、lock なし。監査履歴 4280 に RUN_INVOCATION 1 + NODE_ATTEMPT 2(OK / NO_DATA)、実行ログ 4281 に相関 ID 付き 2 件 |
| 9 | 取消 smoke: 未処理要求が空 → ボードから START 起票(`intake_check@2026-09-smoke`) → 取消 → 再読込で `REQUESTED` かつ `取消` を API 確認 → ポーラー手動実行 | OK: `requested=1 claimed=0 cancelled=1`、要求 #1 = `CANCELLED / CANCELLED_BY_REQUESTER`、`claimed_at` 空、Run は増えず |
| 10 | root の crontab に 2 行登録(バックアップ `/root/crontab.bak-r5-*`)、次周期のログ | OK: 23:20 に `poll-requests: requested=0 …` が `/var/log/ksql-r5/flownet-requests.log` へ出力 |

## 見つかった不備と反映

| # | 不備 | 反映 |
| --- | --- | --- |
| 1 | `status` は `--profile` 必須だが、手順書 §9 の例に無かった | 手順書と併用版の例へ `--profile prod` を追加(`bf5fdd4`) |
| 2 | 本番からの複写で `.env` に CRLF が混入した(手順書 §8.1 の注意どおりの事象) | サーバー上で LF に修正。手順書の記述は妥当なので変更なし |
| 3 | `.env-TEST` が `.gitignore` の対象外だった | `.env-*` を追加(`3a944c6`) |

## 非管理者アカウントでの取消(ChatGPT 導入手順書レビュー指摘 1 の実機確認)

要求 #1 の起票者は管理者(`rex0220`)だったため、一次対応者相当のアカウント `Alex2013`(手順書 §4 の表どおり: 操作要求 4278 は閲覧・追加・編集+アプリ管理、実行管理・監査履歴・実行ログは閲覧+アプリ管理。cybozu 管理者ではない)で再起票した。

- 要求 #2(START `intake_check@2026-09-smoke`、作成者 `Alex2013`)は起票直後にボードの「取消」で `cancel_requested=取消` になった。**非管理者でも `cancel_requested` の PUT が通る**(アプリのレコード編集権限+作成者へのフィールド編集権限の組合せが正しい)
- 次の cron 周期(23:25)でポーラーが処理: `requested=1 claimed=0 cancelled=1`、要求 #2 = `CANCELLED / CANCELLED_BY_REQUESTER`、`claimed_at` 空。cron 経由のポーラーでも取消経路が成立
- 他フィールドを編集できないことの直接確認(非管理者で機械フィールドを編集して拒否されること)は行っていない。フィールドアクセス権は追補スクリプトが適用した構成(everyone 閲覧のみ)であり、テンプレート適用後の同スクリプトの動作は E2E 要求アプリ・本番要求アプリと同一

## 後始末

- 検証用の cron 2 行を削除した(削除前後の crontab を `/root/crontab.bak-r5-*` に保存)。本番の cron 2 行は不変
- `/opt/ksql-r5`、`/root/.ksql-flownet-r5.env`、`/root/flownet-request-allowlist-r5.yaml`、`/var/log/ksql-r5` は残置(再検証用。不要になれば削除)
- 検証用 4 アプリのトークンは、値が Claude のツール出力に表示された経緯があるため再発行を推奨(本番トークンは含まない)
