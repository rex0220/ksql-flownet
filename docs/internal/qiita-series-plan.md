# Qiita シリーズ記事案(kSQL-FlowNet)

- 作成: 2026-09-06 / 状態: 案
- #1 は公開済み: [kintone のバッチを「ジョブの網」として運用する — kSQL-FlowNet](https://qiita.com/rex0220/items/24470d6223c1b4ed4031)(全体像・設計判断・1.0.0 の検証)。Qiita 上のタイトルは「【kSQL-FlowNet #1】kintone のバッチを「ジョブの網」として運用する」へ改題し、本文冒頭に連載予定の一覧を追加する
- タイトル形式: kSQL Flow 連載([【kSQL Flow #1】](https://qiita.com/rex0220/items/893ab4016a5aaf595642))と同じ体系にする。`【kSQL-FlowNet #N】<編名>: <問い>`。#1 の本文に連載予定(#1〜#10)を列記し、各回の公開時に #1 の一覧へリンクを足す
- 方針: 各回は「1 つの問いに答える」単位にし、正本(仕様書・手順書・runbook)の要約ではなく、読者がその回だけで手を動かせる形にする。画面・実行結果は検証スペースのテストデータで撮る

## 読者の旅に沿った構成

| # | 仮題 | 答える問い | 読者 | 主な素材(リポジトリ) | 目安 |
| --- | --- | --- | --- | --- | --- |
| 2 | [導入編: kintone とサーバーを 0 から運用開始まで](https://qiita.com/rex0220/items/2308e4ccf5a363680d31)(公開済み 2026-09-06) | 何を用意して何をすれば動くのか | kintone 管理者 + サーバー担当 | docs/installation.md、templates/README、plugin/README、R5 の検証記録 | 手順書の要約+各手順の画面 8〜10 枚。手順書との差分は「詰まった箇所」だけ |
| 3 | [network 定義編: 既存の kSQL-Flow ジョブを DAG にする](https://qiita.com/rex0220/items/45f04c2748570953629b)(公開済み 2026-09-07) | 手元の SQL をどう network.yaml に束ねるか | kSQL-Flow 利用者 | 仕様書 §4(network_id / business_key の役割、§4.7 フォルダー構成)、`validate` / `plan` | ゲート(ASSERT)を先頭に置く設計、冪等の宣言基準、job_id 64 文字、`{network_id}@` の命名 |
| 4 | 運用編: ボードから動かす | 運用担当者は毎日何を見て何を押すのか | 一次対応者 | docs/ops-first-response.md、仕様書 §6〜§7、ボードの画面 | 3 セクションの読み方、START 3 モード、取消、RERUN / STOP / RELEASE / CLOSE、結果コード早見 |
| 5 | スケジュール連携編: cron と network の分担 | 複数 network を定刻にどう並べるか | サーバー担当 | docs/scheduling-patterns.md、仕様書 §7.4 の例 | 直列連結スクリプト、ASSERT ゲートによる fail-closed、営業日判定、翌月 cron が前月を再開しない話 |
| 6 | 障害対応編: 判定できないときに止まる設計 | 失敗・UNKNOWN・ロック残留のとき何をするか | 二次対応者 | docs/runbook-recovery.md、`status --json`、`archive-run`、`force-unlock-network` | fail-closed の実際、証跡必須の復旧コマンド、CLOSE の不可逆性、stale lock の回収手順 |
| 7 | CSV 入出力編: サーバー上の CSV を network で読む・書く | CSV を kintone 外とやり取りする network はどう組むか | サーバー担当 | docs/csv-io-operations.md、`inputs` / `outputs` の封じ込め規則 | IO ルート、sha256 の baseline、percent encoding(`@` → `%40`)、MUTATED の扱い |
| 8 | 設計編: 機械専用アプリと業務キーの一意性 | なぜ kintone のアプリを状態ストアにできるのか | 設計者 | 仕様書 §3・§5.3・§8、record_key(SHA-256 の 46 文字)、リースロック、Execution Contract v1 | kintone の制約(分精度・64 文字一意・offset 上限)をどう設計で吸収したか。人と機械の書込分離 |
| 9 | 検証編: 実機 E2E とフォールト注入 | 「二重起動しない」をどう証明したか | 開発者 | tests/e2e(fault-hook の barrier、claim レース、finalize 競合)、test-results | E2E ハーネスの作り(KSQL_FLOW_TEST スコープ、本番拒否)、P2-16 の受入記録 |
| 10 | AI 協働編: Codex が実装し Claude がレビューする開発 | 1 人+AI で仕様 → 実装 → 検証をどう回したか | 開発者 | docs/internal の仕様(FROZEN)・レビュー裁定表、installation-claude-code.md | 外部レビュー(Gemini / ChatGPT / Codex)を正本で裁定する運用、Claude Code 併用の導入手順 |

## 公開順の案

2 → 3 → 4 は導入の流れそのものなので連続して出す。5〜7 は運用が始まってから必要になる内容で、読者の反応を見て順序を入れ替えてよい。8〜10 は設計・開発の裏側で、kSQL-Flow 連載の読者向け。

## 各回の共通事項

- 冒頭に「この回で分かること」と「前提(#1・#2 のどこまで済んでいるか)」を 3 行で書く。末尾に前後の回へのリンク
- 実行結果は CLI の JSON(`--json`)か画面のキャプチャで示し、文章で言い換えない
- 実アプリ ID・ドメイン・トークン・実業務値は写さない(検証スペースのテストデータで撮る)
- 記事から正本(仕様書・手順書・runbook)へリンクし、記事側に仕様を二重に書かない
- 下書きは `docs/internal/qiita-draft-<回>.md`、外部レビューの裁定は `docs/internal/qiita-review-<日付>.md` に残す(#1 と同じ運用)
