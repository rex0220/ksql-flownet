# スケジュール連携の運用パターン

kSQL-FlowNet はスケジューラを持たない([統合仕様書 §1.2](./specification.md))。「いつ動かすか」「先行ジョブの完了を待ってから動かすか」は外部(OS の cron・シェルスクリプト・network 定義内のゲート)で表現する。本書はその設計理由と、実運用で必要になる連携を本体に手を入れずに実現するパターンをまとめる。

## 1. なぜ本体にスケジュール制御を持たせないか

| 持たせた場合の問題 | 本製品の選択 |
| --- | --- |
| 常駐スケジューラが落ちると「定刻に動かなかった」障害が増え、監視・再起動の責務を抱える | OS 標準の cron に委ねる。cron は再起動耐性が高く、監視対象が増えない |
| 「次回発火時刻」「待ちキュー」といった揮発状態の置き場所(kintone か、ローカルか)が必要になる | 状態は kintone 上の Run / Lock / 操作要求だけ。FlowNet は呼ばれた時点の状態を見て裁定する one-shot CLI に徹する |
| ネットワーク間トリガー(A 完了で B 起動)を内蔵すると Control Plane に入口が増え、fail-closed の境界が広がる | 起動トリガーは外部に置き、本体は DAG の整合・排他・再開性だけに責任を持つ |

## 2. 現場で必要になる連携

| ケース | 内容 | 使うパターン |
| --- | --- | --- |
| A. 遅延による衝突 | 01:00 の前処理 A が長引き、02:00 起動の後処理 B(A の成果物前提)が先に動く | パターン 1(直列連結)、補助としてパターン 2(ゲート) |
| B. 業務カレンダー | 「第3営業日」「祝日を除く月曜」など cron 式で表せない日付条件 | パターン 3(カレンダー判定) |
| C. 即時連鎖 | A が SUCCESS になった直後に B を起動したい(cron で待つ時間が無駄) | パターン 1(直列連結) |

## 3. パターン 1: ラッパースクリプトで直列連結(推奨)

cron から `run-network` を直接呼ばず、複数 network を順に実行するシェルスクリプトを 1 本置く。`run-network` は成功・NO-OP で exit 0、失敗・拒否で exit 1 を返す(§5.1)ので、`set -e` だけで「A が成功したときだけ B」が成立する。

```bash
#!/bin/bash
# /opt/ksql/my-ksql-jobs/run_daily_chain.sh — cron: 0 1 * * *
set -euo pipefail
cd "$(dirname "$0")"
FLOWNET=/opt/ksql/ksql-flownet/dist/cli/index.js
TARGET="${SCHEDULED_FOR:-$(TZ=Asia/Tokyo date +%Y-%m-%dT00:00:00+09:00)}"

# A: 前処理。失敗(exit 1)ならここで止まり、B は起動しない
node --env-file=.env "$FLOWNET" run-network flownet/daily-intake/network.yaml --resume --scheduled-for "$TARGET"

# B: A が exit 0(SUCCESS または完走済み NO-OP)のときだけ即座に実行
node --env-file=.env "$FLOWNET" run-network flownet/daily-summary/network.yaml --resume --scheduled-for "$TARGET"
```

- cron 行は 1 本になり、「A はたぶん 1 時間で終わる」という見込みの時間差起動が不要になる(ケース A・C)
- A が完走済みで NO-OP(exit 0)でも B は進む。B も完走済みなら NO-OP で終わるため、同じ日に再発火しても安全
- A が失敗した日は B が起動しない。A をボードからリランして成功させた後、B は翌日の cron まで動かない。**当日中に B も動かしたい場合は同じスクリプトを手動実行する**(A は NO-OP、B が実行される)
- A と B の `scheduled_for` を揃えるため、両 network の `business_key_policy` は同じ period(例: day)にする。period が異なる場合はパターン 2 を併用する

## 4. パターン 2: 下流 network の先頭に「先行完了ゲート」を置く

仕様書 §9 の回避策。下流 network の最初のノードを ASSERT だけの SQL にし、先行の結果が揃っていなければ fail-closed で `FAILED` に倒す。上流完了後にボードからリランすれば続行できる。

**2a. 業務データで判定する(推奨)** — 上流が書き込んだ業務アプリの状態を直接検証する。kSQL-Flow の profile に追加設定が要らず、上流の「成果物が本当にある」ことを見るため最も確実。

```sql
-- @ksql name: ds_gate_intake
-- @ksql timeout: 60
-- @ksql dialect: 1
ASSERT (
  SELECT COUNT(*) FROM LAPP_日次実績
  WHERE 取込日 = TODAY()
) > 0, '先行の日次取込データがありません';
```

**2b. 実行管理アプリのメタデータで判定する(変種)** — 実行管理アプリを kSQL-Flow の profile に**閲覧専用トークンで logical app として登録**し、上流 network の Run 状態を検証する。SQL には Run の業務キーを埋め込めない(kSQL-Flow へ渡るのは `as_of` だけ)ため、「上流に未完了 Run が残っていない」形が扱いやすい:

```sql
-- @ksql name: ds_gate_upstream_run
-- @ksql timeout: 60
-- @ksql dialect: 1
ASSERT (
  SELECT COUNT(*) FROM LAPP_FLOWNET_STATE
  WHERE record_type = 'NETWORK_RUN'
    AND network_id = 'daily_intake'
    AND status IN ('CREATED', 'RUNNING', 'FAILED', 'UNKNOWN')
) = 0, '先行 daily_intake に未完了の Run があります';
```

- 2b は実行プレーン(kSQL-Flow)が Control Plane のアプリを読む形になる。閲覧専用トークンに限定し、書込は行わない(§8.1)
- ゲートは「動くべきでないときに止める」保険であり、起動順そのものはパターン 1 か cron の時刻で作る

## 5. パターン 3: 業務カレンダーの判定

cron 式では「第3営業日」を表せない。毎日発火する cron から呼ぶラッパースクリプトの先頭で判定し、対象日でなければ何もせず exit 0 する。

```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
# 営業日カレンダーは kintone のカレンダーアプリ、またはサーバー上の CSV から判定する
if ! node scripts/is-third-business-day.mjs; then
  echo "対象日ではないためスキップ"; exit 0
fi
node --env-file=.env /opt/ksql/ksql-flownet/dist/cli/index.js run-network flownet/monthly-close/network.yaml \
  --resume --scheduled-for "$(TZ=Asia/Tokyo date +%Y-%m-01T00:00:00+09:00)"
```

判定を network の先頭ノード(カレンダーアプリへの ASSERT)に置く方法もあるが、対象日でない日に毎日 `FAILED` の Run が積み上がるため、スクリプト側で判定する方が運用が静かになる。

## 6. 採らないパターン: SQL や上流ジョブから操作要求アプリへ START を書く

「A の最終ノードで操作要求アプリに B の START レコードを INSERT し、ポーラーに拾わせる」案は採用しない。

- 操作要求アプリは**人の操作を受ける入口**であり(§8.1)、機械が起票すると人の操作と区別できなくなる
- API トークン経由で作成したレコードの作成者は `Administrator` になり、要求者相関(§8.3)が失われる
- 得られる効果(A 成功後に B を起動)はパターン 1 で、監査(誰が起動したか)は Invocation の `requested_by` で、いずれも既存機能で満たせる

## 7. 使い分け

| やりたいこと | パターン |
| --- | --- |
| 同じ日・同じ月の A → B を確実な順序で動かす | 1(直列連結) |
| 周期が違う上流(日次)の結果が揃ってから下流(月次)を動かす | cron の時刻差 + 2a(業務データゲート) |
| 上流が失敗・未完了のまま下流が動くのを防ぐ | 2a または 2b(ゲート) |
| 営業日・祝日を考慮して起動する | 3(スクリプトで判定) |
| A 完了の瞬間に B | 1(直列連結) |
