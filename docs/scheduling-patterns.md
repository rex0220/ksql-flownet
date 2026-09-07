# スケジュール連携の運用パターン

kSQL-FlowNet はスケジューラを持たない([統合仕様書 §1.2](./specification.md))。「いつ動かすか」「先行ジョブの完了を待ってから動かすか」は外部(OS の cron・シェルスクリプト・network 定義内のゲート)で表現する。本書はその設計理由と、実運用で必要になる連携を本体に手を入れずに実現するパターンをまとめる。

## 1. なぜ本体にスケジュール制御を持たせないか

| 持たせた場合の問題 | 本製品の選択 |
| --- | --- |
| 常駐スケジューラが落ちると「定刻に動かなかった」障害が増え、監視・再起動の責務を抱える | OS 標準の cron に委ねる。cron は OS のサービスとして管理でき、監視対象が増えない。ただし cron はサーバー停止中に過ぎた発火を補完しないため、未実行期間はボードで検知し `SCHEDULED_FOR` で対象日時を指定して実行する |
| 「次回発火時刻」「待ちキュー」といった揮発状態の置き場所(kintone か、ローカルか)が必要になる | 状態は kintone 上の Run / Lock / 操作要求だけ。FlowNet は呼ばれた時点の状態を見て裁定する one-shot CLI に徹する |
| ネットワーク間トリガー(A 完了で B 起動)を内蔵すると Control Plane に入口が増え、fail-closed の境界が広がる | 起動トリガーは外部に置き、本体は DAG の整合・排他・再開性だけに責任を持つ |

## 2. 現場で必要になる連携

| ケース | 内容 | 使うパターン |
| --- | --- | --- |
| A. 遅延による衝突 | 01:00 の前処理 A が長引き、02:00 起動の後処理 B(A の成果物前提)が先に動く | パターン 1(直列連結)、補助としてパターン 2(ゲート) |
| B. 業務カレンダー | 「第3営業日」「祝日を除く月曜」など cron 式で表せない日付条件 | パターン 3(カレンダー判定) |
| C. 即時連鎖 | A が SUCCESS になった直後に B を起動したい(cron で待つ時間が無駄) | パターン 1(直列連結) |

## 3. パターン 1: ラッパースクリプトで直列連結(推奨)

cron から `run-network` を直接呼ばず、複数 network を順に実行するシェルスクリプトを 1 本置く。`run-network` は成功・NO-OP で exit 0、失敗・拒否で exit 1 を返す([統合仕様書 §5.1](./specification.md))ので、`set -e` だけで「A が成功したときだけ B」が成立する。

```bash
#!/bin/bash
# /opt/ksql/my-ksql-jobs/run_daily_chain.sh
# cron: 0 1 * * * flock -n /run/lock/flownet-daily-chain.lock /opt/ksql/my-ksql-jobs/run_daily_chain.sh >> /var/log/ksql/flownet-daily-chain.log 2>&1
set -euo pipefail
. /root/.ksql-flownet.env          # kSQL-FlowNet の環境変数(installation.md §8.1)
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
- **翌日以降に手動リカバリする場合は対象日を環境変数で渡す。** 既定の `TARGET` は実行日の日付になるため、そのまま叩くと前日分の B は実行されない: `SCHEDULED_FOR="2026-09-04T00:00:00+09:00" ./run_daily_chain.sh`
- **失敗の検知を運用に組み込む。** A が失敗すると `run-network` は stderr にエラーを書いて exit 1 で終わり、スクリプトはそこで止まる。cron は exit code ではなく標準出力・標準エラーの有無でメールを送るため、cron ホストに MTA またはメールリレーを設定していれば `MAILTO` で失敗時のエラー出力が届く。メール環境のないサーバーでは届かないので、外部監視や通知スクリプトを別途用意する。あわせて、ボードの「終了済み・対応が必要なRun」([統合仕様書 §7.2](./specification.md))で A の `FAILED` を検知してリランする流れ([一次対応手順](./ops-first-response.md))とセットで運用する
- A と B の `scheduled_for` を揃えるため、両 network の `business_key_policy` は同じ period(例: day)にする。period が異なる場合はパターン 2 を併用する

## 4. パターン 2: 下流 network の先頭に「先行完了ゲート」を置く

[統合仕様書 §9](./specification.md) の回避策。下流 network の最初のノードを ASSERT だけの SQL にし、先行の結果が揃っていなければ fail-closed で `FAILED` に倒す。上流完了後にボードからリランすれば続行できる。

**2a. 業務データで判定する(推奨)** — 上流が書き込んだ業務アプリの状態を直接検証する。kSQL-Flow の profile に追加設定が要らず、上流の成果物そのものを見るため Run の記録より実態に近い。

```sql
-- @ksql name: ds_gate_intake
-- @ksql timeout: 60
-- @ksql dialect: 1
ASSERT (
  SELECT COUNT(*) FROM LAPP_日次実績
  WHERE 取込日 = @TODAY()
) > 0, '先行の日次取込データがありません';
```

`@TODAY()` 等の時刻関数は実行時刻ではなく **Run の `as_of`(対象期間)を基準に評価される**(kSQL-Flow の仕様書 `docs/ksql_flow_spec.md` §5.3「実行基準時刻の固定」)。翌日にリランしても対象日の判定が変わらない。

`COUNT(*) > 0` を完了条件にできるのは、「正常完了なら必ず 1 件以上あり、途中停止時に部分書込みが残らない」ことを業務上保証できる場合だけである。0 件が正常な日がある、または部分書込みがあり得る業務では、上流が全処理の最後にだけ書く完了マーカーを検査する:

```sql
ASSERT (
  SELECT COUNT(*) FROM LAPP_取込完了管理
  WHERE 対象日 = @TODAY() AND 状態 = 'COMPLETE'
) = 1, '先行の日次取込が完了していません';
```

**2b. 実行管理アプリのメタデータで判定する(変種)** — 実行管理アプリを kSQL-Flow の profile に**閲覧専用トークンで logical app として登録**し、上流 network の Run 状態を検証する。SQL には Run の業務キーを埋め込めない(kSQL-Flow へ渡るのは `as_of` だけ)ため、上流 Run の `as_of` を as-of 基準の時刻関数で**対象期間の半開区間**に絞る。**「未完了がない」だけの判定では、上流がまだ一度も起動していない(cron 遅延・スクリプト失敗)場合に素通りする**ので、「対象期間の SUCCESS が存在する」ことを主条件にする。月次の例:

```sql
-- @ksql name: mc_gate_upstream_run
-- @ksql timeout: 60
-- @ksql dialect: 1
-- 主条件: 対象月の上流 Run が SUCCESS で存在する(未起動・失敗・不明はここで止まる)
ASSERT (
  SELECT COUNT(*) FROM LAPP_FLOWNET_STATE
  WHERE record_type = 'NETWORK_RUN'
    AND network_id = 'monthly_intake'
    AND status = 'SUCCESS'
    AND as_of >= @MONTH_START() AND as_of < @NEXT_MONTH_START()
) >= 1, '先行 monthly_intake の対象月の SUCCESS Run がありません';
-- 補助条件: 補正 Run など、対象月に未完了の上流 Run が残っていない
ASSERT (
  SELECT COUNT(*) FROM LAPP_FLOWNET_STATE
  WHERE record_type = 'NETWORK_RUN'
    AND network_id = 'monthly_intake'
    AND status IN ('CREATED', 'RUNNING', 'FAILED', 'UNKNOWN')
    AND as_of >= @MONTH_START() AND as_of < @NEXT_MONTH_START()
) = 0, '先行 monthly_intake に未完了の Run があります';
```

- 主条件は対象月の補正 Run の SUCCESS も通す(通常 Run・補正 Run のいずれでも対象月の正常な成果があればよい、という意図)。定期キーの Run だけを対象にするなら `business_key` も照合する
- `as_of` は kintone DATETIME(UTC 保存)。`@MONTH_START()` / `@NEXT_MONTH_START()` は Run の `as_of` を基準に評価されるため、上限を持つ半開区間で対象月だけを拾える(上限がないと将来日付の Run が判定に混ざる)
- kSQL の時刻関数は現在 `@NOW()` / `@TODAY()` / `@MONTH_START()` / `@NEXT_MONTH_START()` であり、**翌日境界を返す関数がないため日次粒度の 2b ゲートは書けない**。日次は 2a(業務データ)で判定する
- 2b は実行プレーン(kSQL-Flow)が Control Plane のアプリを読む形になる。閲覧専用トークンに限定し、書込は行わない([統合仕様書 §8.1](./specification.md))。この条件記述の難しさが、2a を推奨とする理由でもある
- ゲートは「動くべきでないときに止める」保険であり、起動順そのものはパターン 1 か cron の時刻で作る

## 5. パターン 3: 業務カレンダーの判定

cron 式では「第3営業日」を表せない。毎日発火する cron から呼ぶラッパースクリプトの先頭で判定し、対象日でなければ何もせず exit 0 する。

```bash
#!/bin/bash
# /opt/ksql/my-ksql-jobs/run_monthly_close.sh — cron: 毎日発火
set -euo pipefail
. /root/.ksql-flownet.env
cd "$(dirname "$0")"

if [ "${MANUAL_BACKFILL:-0}" = "1" ]; then
  # 手動補完: 対象月の指定を必須にし、手動であることをログに残す
  if [ -z "${SCHEDULED_FOR:-}" ]; then
    echo "MANUAL_BACKFILL=1 では SCHEDULED_FOR が必須です" >&2
    exit 2
  fi
  TARGET="$SCHEDULED_FOR"
  echo "手動補完: scheduled_for=$TARGET"
else
  # 定期実行: 当月を対象に、営業日カレンダー(kintone のカレンダーアプリ、またはサーバー上の CSV)で判定する
  TARGET="$(TZ=Asia/Tokyo date +%Y-%m-01T00:00:00+09:00)"
  if node --env-file=.env scripts/is-third-business-day.mjs; then
    :
  else
    rc=$?
    if [ "$rc" -eq 10 ]; then
      echo "対象日ではないためスキップ"; exit 0
    fi
    echo "営業日判定に失敗しました: exit=$rc" >&2
    exit "$rc"
  fi
fi

node --env-file=.env /opt/ksql/ksql-flownet/dist/cli/index.js run-network flownet/monthly-close/network.yaml \
  --resume --scheduled-for "$TARGET"
```

未実行の月を手動で補完するときは `MANUAL_BACKFILL=1 SCHEDULED_FOR="2026-08-01T00:00:00+09:00" ./run_monthly_close.sh` のように実行する。手動補完で「今日が第 3 営業日か」を判定すると実行できないため、`MANUAL_BACKFILL=1` を明示してカレンダー判定を省略する。このとき `SCHEDULED_FOR` は必須で、無ければ何もせず exit 2 で止まる(現在月を誤って流さないため)。手動補完であることと対象月は標準出力に残る。`SCHEDULED_FOR` の有無で自動判定する作りも可能だが、専用フラグにすると「カレンダー制約を意図的に外した」操作がログと手順に残る。

判定スクリプトの終了コードは `0`(対象日)、`10`(対象日ではない)、それ以外(判定処理の異常: カレンダーアプリの API エラー・認証失敗・CSV 破損など)に分ける。判定不能を正常スキップにすると月次処理が静かに欠落する(fail-open)ため、異常時は非 0 で停止する。

判定を network の先頭ノード(カレンダーアプリへの ASSERT)に置く方法もあるが、対象日でない日に毎日 `FAILED` の Run が積み上がるため、スクリプト側で判定する方が運用が静かになる。

## 6. 採らないパターン: SQL や上流ジョブから操作要求アプリへ START を書く

「A の最終ノードで操作要求アプリに B の START レコードを INSERT し、ポーラーに拾わせる」案は採用しない。

- 操作要求アプリは**人の操作を受ける入口**であり([統合仕様書 §8.1](./specification.md))、機械が起票すると人の操作と区別できなくなる
- API トークン経由で作成したレコードの作成者は kintone の仕様上 `Administrator` になり、要求者相関([統合仕様書 §8.3](./specification.md))が失われる
- 得られる効果(A 成功後に B を起動)はパターン 1 で、監査(誰が起動したか)は Invocation の `requested_by` で、いずれも既存機能で満たせる

## 7. 使い分け

| やりたいこと | パターン |
| --- | --- |
| 同じ日・同じ月の A → B を確実な順序で動かす | 1(直列連結) |
| 周期が違う上流(日次)の結果が揃ってから下流(月次)を動かす | cron の時刻差 + 2a(業務データゲート) |
| 上流が失敗・未完了のまま下流が動くのを防ぐ | 2a または 2b(ゲート) |
| 営業日・祝日を考慮して起動する | 3(スクリプトで判定) |
| A 完了の瞬間に B | 1(直列連結) |
