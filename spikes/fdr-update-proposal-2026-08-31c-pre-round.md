# FDR再審議提案 2026-08-31c: PREラウンド(PRE-01 activity / PRE-02 ブレーキ / PRE-06 cancel-run)

状態: PROPOSED(承認待ち)
契機: 運用UI討論の合意(討論§10.2/§13)とvision確定。3件は相互依存(activityのSTOPPED値はcancel-runのhold状態から導出)のため同一ラウンドで審議・実装し、test vectorを一度に確定する。

## A. PRE-01: `status --json`のactivity導出(4値)

read-only出力の追加。保存データ・既存フィールドの意味は不変。

| activity      | 条件(判定順)                                                                                                                         | 一次対応                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| (付与しない)  | Run statusが終端(SUCCESS/FAILED/CANCELLED/UNKNOWN)                                                                                   | statusに従う                               |
| `STOPPED`     | 未終端 かつ 当該run_idの`CANCEL_REQUEST`が`REQUESTED`/`ACCEPTED`                                                                     | 意図停止中。再開は`cancel-run --release`後 |
| `LIVE`        | 未終端 かつ Network lockが存在し、owner invocationが当該Runに属し、lease生存(`lease_expires_at + 60秒 > now` — 分精度保守判定と同一) | 待つ                                       |
| `IDLE`        | 未終端 かつ `started_at`がnull かつ 上記以外                                                                                         | 開始前の停止。resumeで再開                 |
| `INTERRUPTED` | 未終端 かつ `started_at`非null かつ 上記以外                                                                                         | 必ず対応(復旧runbook手順1へ)               |

- **共有test vector**: 入力(Run/lock/CANCEL_REQUESTの組)→期待activityのfixture JSONを`tests/fixtures/status-activity/`へ置き、CLI実装と将来の案A v1プラグインの双方の受入条件とする
- FDR審議は「導出定義の確定」のみ(保存意味論の変更なし)

## B. PRE-02: 連続失敗ブレーキ

resume準備(FAILED→WAITING戻し)の変更。

- **規則**: 冪等FAILEDノードについて、Attempt履歴の**末尾から連続する「status=FAILED かつ 同一failure_kind」のattempt数がN回以上**なら、`WAITING`へ戻さず対象から除外する(非冪等FAILEDと同じ除外系に載せる。下流は除外、独立系統は継続)
- `CANCELLED / PREPARE_FAILED`(LOCK_CONFLICT等)は仕様§8.2どおり**数えず、連続の連鎖も切らない**(透過)。UNKNOWNは連鎖を切る(そもそも自動再実行対象外)
- **N=3を既定**とする(設定拡張はP2-03残余)。除外時はNode State `status_reason`へ`RETRY_BRAKE`系の理由、Invocation reasonへ診断1行
- **解除経路は新設しない**: 既存の`--rerun-from <node>`(冪等ノードは既存attemptがあっても許可=R2-1改定済み)が明示的な人の判断としてそのまま機能する
- カウントはresume時に孤児裁定が取得済みのAttempt一覧を流用(API増なし)。NEW invocationは対象外

## C. PRE-06: `cancel-run`(CLI起点のRun単位停止要求)

討論§13の確定条件に基づく。

- **永続化**: state appへ独立record_type `CANCEL_REQUEST`(record_key=`CANCEL:<run_id>`で1 Run 1レコード、状態遷移で再利用)。orchestratorが書くRun/Lockレコードへは相乗りしない
- **状態機械**: `REQUESTED`(CLIが作成/再要求) → `ACCEPTED`(orchestratorがノード境界で受理し停止) → `RELEASED`(CLI `--release`で解除)。全遷移revision fencing付き
- **CLI**: `cancel-run --run-id <id> --reason-file <path>` / `cancel-run --run-id <id> --release --reason-file <path>`。要求者は`KSQL_FLOWNET_REQUESTED_BY`環境変数(他の運用系CLIと同一)。要求・解除とも理由必須(レコード自体が監査を兼ねる)
- **orchestrator動作**: (1)各ノード起動前+resume準備時に当該run_idの`CANCEL_REQUEST`をGET(+1/ノード境界)。(2)`REQUESTED`検出→`ACCEPTED`へ遷移→新ノードを起動せず、実行中subprocessは完走を待ち、Invocationを`CANCELLED / STOP_REQUESTED`で正常終端、lockは通常解放。(3)`REQUESTED`/`ACCEPTED`が存在する間、ensure-runはresumeを`RUN_ON_HOLD`(fail-closed、要求record参照を表示)で拒否 — **hold既定**(cron自動resumeが止めたRunを再開してしまう衝突の防止)
- **読取失敗の扱い**: cancel確認のGETが到達不能の場合は既存のdrain規律に乗る(特別扱いしない — 討論§13.1-2)
- Node Stateは変更しない(WAITINGのまま)。新しいNode State値・Run status値は作らない

## D. 仕様・文書への反映(承認後)

1. 仕様: §7.4として`cancel-run`(状態機械・hold・STOP_REQUESTED)、§5.3へブレーキ規則、status規則へactivity導出、を**Phase 1.1追補**として追記(FDR §13へ本再審議を記録)
2. 受入マトリクスへ3項目追加(activity 4値vector、ブレーキ両分岐、cancel→hold→release→resumeの実機)
3. runbook/一次対応1ページ該当箇所(「停止は次のノード境界まで効かない」等)
4. templates: state appへ`CANCEL_REQUEST`用のrecord_type選択肢追加が必要か確認(dropdown選択肢追加のみ。既存アプリへはadjustスクリプト同様の追補)

## E. 実装・検証(承認後、通常サイクル)

codex実装(unit: vector全件・ブレーキ境界・cancel状態機械・RUN_ON_HOLD・透過/連鎖切り)→Claudeレビュー→実機E2E(m8-01: cancel→hold→release→resume完走、m8-02: ブレーキ発動→rerun-fromで解除、m8-03: activity 4値の実機確認)→証跡→マージ。

## 承認依頼

A(activity 4値定義)・B(ブレーキN=3・rerun-from解除)・C(cancel-run hold既定)・D/Eの実施を承認いただけますか。
