# kSQL-FlowNet 設計・仕様レビュー 統合まとめ(訂正版)

- 作成: 2026-09-02 / 対象: P2-11 仕様確定、スケジューラとしての評価、「SQL専用インターフェース」を巡る3モデル討議
- 突合先(この版の記述はすべて以下の現物と照合済み): `docs/specification.md`、`docs/execution-contract-v1.md`、`docs/internal/architecture-separation-adr.md`、`docs/internal/job-network-phase1-spec.md`、`docs/internal/ksql-flownet-vision.md`、`docs/internal/p2-11-adhoc-start-spec.md`(v6)

**初版からの主な訂正**

| # | 初版の記述 | 訂正 |
| --- | --- | --- |
| 1 | 「P2-11 v5 FROZEN」 | **v6 が FROZEN**(2026-09-02、M0コード確認4点完了・凍結ゲートF-01再判定済み) |
| 2 | 処理前取消(`CANCELLED`)をP2-11の確定仕様として記載 | **X-1採用によりP2-12へ切り出し**。P2-11に取消は含まれない(§8「起票後の取消手段はP2-12まで提供されない」) |
| 3 | M0コード確認の結果に言及なし | **4点の結果を本文へ収録**。うち2点でCLI改修が確定(§1-5) |
| 4 | 「非冪等ノードは画面リランを全面禁止」 | **誤り**。RERUNでは非冪等ノードは*除外*されるだけでRun自体は実行される。全面拒否は**STARTの三重ゲート③のみ**(§2-4) |
| 5 | 安全装置の列挙に`MAX_ACTIVE_RUNS`なし | **追加**。実運用で最初に詰まる制約(§2-4) |
| 6 | correctionの前提条件に言及なし | **追加**。correction STARTは元RunがSUCCESSのときだけ通る(§1-6) |
| 7 | パターンCに書込みの但し書きなし | **追加**。外部観測ワーカーは**読取専用**に限る(§3-3) |
| 8 | 「RETRY_BRAKE(同一エラー3連続失敗)」 | **正しい**。`specification.md`「同じ空でない failure kind が末尾から3回以上連続したノード」で裏付け(初版レビュー時の「出典未確認」指摘は撤回) |

---

## 1. P2-11: START要求 仕様の確定(v6 = FROZEN)

不定期ジョブ(締めのやり直し・補正Run・臨時集計)をkintone操作要求アプリから起動する「START要求」の仕様が、外部レビュー6巡(Gemini / ChatGPT / Claude)を経て凍結されました。

### 1-1. 起動コマンド契約の厳格化

- **`--resume` / `--resume-run` の付与を禁止**。STARTを経由してRERUNの受理条件(hold / `resume_allowed` / 非LIVE / 終端SUCCESS拒否)をバイパスする裏口を根本遮断する。単体で「STARTのargvにresumeが含まれない」ことを固定
- 重複・未完了案内時のCLI `--json` 出力へ `blocked_run_ids` を追加(M2)
- `outcome` とG-07分類の写像: NEW作成→`DONE` / 完了済み→`DONE / NOOP_ALREADY_SUCCESS` / 未完了案内・Invocation作成前の検証拒否→`REJECTED`

### 1-2. correction(補正)経路の整合性

`scheduled_period` network の補正実行では、`business_key`(補正名)と `scheduled_for`(対象期間)の**両方指定を必須**とし、as-of を対象期間に固定する。「8月補正なのに9月断面を集計する」静かなデータ破壊を防ぐため。`business_key` 単独指定は `AS_OF_UNDEFINED` で fail-closed 拒否。

### 1-3. 三重ゲート(`specification.md` §6.4)

| ゲート | 判定場所 | 必須条件 |
| --- | --- | --- |
| 1. 起票権限 | kintone | 操作要求アプリへレコード追加できる |
| 2. network allowlist | ポーラー | 対象entryに boolean の `app_start: true` がある |
| 3. 冪等性 | network定義 | 全ノードが明示的に `idempotent: true` |

②③を分離した根拠: 非冪等ノードを含むnetworkの**新規起動**自体に `--approved-by` は不要(それは `resolve-node` の要件)で、未実行ノードの初回実行に二重実行リスクもない(Phase 1 §7.2)。危険の本質は「アプリの追加権限者なら誰でも外部副作用(請求・通知)を発火できる」という**権限とレビューの問題**であり、冪等性の証明の問題ではない。

### 1-4. 主要な拒否・完了コード(`specification.md` §6)

`AS_OF_UNDEFINED` / `KEY_POLICY_MISMATCH` / `INVALID_TIMESTAMP_FORMAT` / `RUN_ALREADY_EXISTS`(同一業務キーの未完了Run) / `MAX_ACTIVE_RUNS` / `LOCK_CONFLICT` / `NOOP_ALREADY_SUCCESS` / `STALE`。要求の `DONE` は**要求処理の終端**を表し、Runの `SUCCESS` を意味しない。

### 1-5. M0コード確認4点の結果(2026-09-02実施)

仕様が実装事実に依存していた4点を、凍結前に実コードで確認した。**うち2点でCLI改修が確定**している。

| # | 確認事項 | 結果 |
| --- | --- | --- |
| ① | `scheduled_period` へ `--business-key` 単独が受理されるか | **受理される**(`business-key.ts:249-262`)。キー=指定値、`as_of = null` で起動時刻断面になり、**N-1の危険は実在することが確認された**。ポーラー側の `AS_OF_UNDEFINED` 拒否が必要かつ正。CLI変更不要 |
| ② | 両フラグ同時指定の挙動 | **`BUSINESS_KEY_INPUT_CONFLICT` で拒否される**(`business-key.ts:240-248`)。すなわち**correction経路は現行CLIでは成立しない**。`ensure-run.ts:504` の `as_of` 解決は既に汎用のため、**M2のCLI後方互換拡張1点**(両指定時は business_key を採用し、scheduled_for は検証のうえ as-of にのみ使用)で成立。凍結ゲートF-01はこの計上で解消 |
| ③ | 重複案内経路のJSONに run_id が載るか | **載らない**(`run_id: null`、blockedByは非JSON時のstderrのみ / `run-network-command.ts:152-172`)。`blocked_run_ids` 追加が**必要と確定** |
| ④ | NOOP経路のJSONに run_id が載るか | **載る**(`run-network-command.ts:113-120`)。契約成立・作業不要 |

**「FlowNet本体無改修」の例外は2件**になった。①`blocked_run_ids` はP2-01 G-04と同じ**CLI表示境界**の後方互換拡張だが、②の `BUSINESS_KEY_INPUT_CONFLICT` 撤廃は**入力検証セマンティクスの変更**であり、①より重い。正本記録としてはこの区別を残すこと。

### 1-6. 処理前取消(`CANCELLED`)— P2-12へ切り出し

起票後〜claim前(最大5分)の取消は、第5巡でv5へ入れたのち、**第6巡X-1の採用によりP2-12へ切り出された**。理由: 取消はP2-01(REVIEWED)の**状態機械・権限モデル・G-09境界**を書き換える「拡張」ではなく「改訂」であり、1巡しかレビューを経ていなかった。P2-09が同型の問題をP2-10として切り出した判断と同じ。

同巡でChatGPTが取消設計に競合規則の欠落(I-04)を、Claudeが受入配置の矛盾(受入8がM3で実施不能)・`ACCEPTED`行に出る効かない取消ボタン・フィールドACL・G-09改訂のM0漏れ・作業分割漏れを検出しており、**独自のレビューサイクルが必要であることの裏付け**になった。採用判断自体は維持し、実現はP2-12の個別仕様・レビューで行う。

**現時点の帰結**: 起票後の取消手段はP2-12まで存在しない。誤起票に気づいた場合は、起動後のRunを `STOP` で止める。

### 1-7. 運用上の重要な帰結(誤解しやすい点)

**correction START は、元Runが `SUCCESS` のときだけ通る。** `max_active_runs`(既定1)の active 定義は「`resume_allowed = true` かつ status が `SUCCESS` 以外」であり、除外条件の `ARCHIVED` / `resume_allowed = false` を**書く経路が現行実装に存在しない**(前者はP2-10、後者はP2-03残余)。したがって:

| 状況 | 結果 |
| --- | --- |
| 8月締めが `SUCCESS` → 補正キーでSTART | 通る(§1-2の主目的経路) |
| 8月締めが `FAILED` のまま → 補正キーでSTART | `MAX_ACTIVE_RUNS` で拒否。**正しい操作はRERUN** |
| 8月締めが `FAILED` のまま → 9月分の臨時START | 同上 |

操作モデル表の「失敗・中断した既存Runの再開・やり直しはRERUN」は、この制約の裏返しである。未完了Runを閉じる汎用手段はP2-10(ARCHIVED化)に依存する。

---

## 2. ジョブスケジューラとしての本質と評価

汎用スケジューラ(Airflow等)との比較において、kSQL-FlowNetは「超軽量・高耐久・業務データ整合性特化型」のControl Planeとして高い完成度を持つ。

### 2-1. 外部インフラ依存の極小化

RDBMS、Redis、Kubernetes、常駐デーモンを持たない。**VPS 1台 + cron 2本**(定期実行の `run-network --resume --scheduled-for …` と5分間隔の `poll-requests`)**+ kintoneアプリ3本**(実行管理・監査履歴・JOBログ)だけで、分散ロック(renewable lease)、フェンシング(revision)、監査証跡、状態管理を完結させている。kintoneへHTTPS発信できれば足り、受信ポートの開放は不要。

### 2-2. 業務キー中心の一意性制御

`profile + network_id + business_key` の正準一意性を、kintoneの重複禁止制約で担保する。二重実行を物理的に排除し、その裁定はensure-runが単独で持つ(ポーラーやUIの重複確認は補助であって正ではない — 不変条件I-02)。

### 2-3. 直列実行への割り切り

DAGの安定トポロジカルソートを持ちながら、ノードの並列実行は行わない(Phase 1)。これにより分散ロック・デッドロック・部分失敗の複雑性を排除している。並列化はPhase 2の対象で、着手条件は「初回本番の実測で実行時間が締切を圧迫、または業務が直列表現で書けなくなったとき」。

### 2-4. 起動・再開の多層防御(訂正・補完)

| 層 | 制約 | 効果 |
| --- | --- | --- |
| 時間 | 5分cronポーラーによる非同期性 | 即時実行はしない。STOPはノード境界まで効かない(実行中SQLは完走) |
| Run状態 | `RUN_LIVE`(生存中Invocation owner) / `RUN_ON_HOLD`(停止hold中) | 二重実行と、停止したRunの勝手な再開を拒否 |
| 失敗の連鎖 | `RETRY_BRAKE` — 同じ空でない failure kind が末尾から3回以上連続したノード | 同じ失敗の機械的繰り返しを止める。解除は `--rerun-from` |
| **同時性** | **`MAX_ACTIVE_RUNS`(既定1)** | **同一networkで未完了Runは1本まで。実運用で最初に詰まる制約(§1-7)** |
| 判定不能 | `STALE` — claim後の実行有無・結果を確定できない | 自動再実行しない。STARTでは**再導出した業務キーでRunを照合**し、LIVE ownerなしを確認できた場合だけREJECTEDへ倒す |
| 人の判断 | `UNKNOWN` を含むRunはRERUN拒否 / `resolve-node` はCLI専権(証跡・承認必須) | 判断を要する復旧を画面から外す |

**非冪等ノードの扱いは、STARTとRERUNで異なる**(初版の誤りの訂正):

- **START(新規起動)**: 三重ゲート③により、**1つでも `idempotent: true` でないノードがあればnetwork全体を拒否**。誰でも押せる経路で外部副作用を発火させないための、P2-11固有の運用判断
- **RERUN(再開)**: 拒否しない。Phase 1 §7.1-8 のとおり「`FAILED`/`CANCELLED` は `idempotent: true` のノードだけを `WAITING` へ戻す。`idempotent: false` は状態を維持し、そのノードと子孫を対象から除外する。**依存しない系統の評価と実行は継続する**」。P2-09のボードも終端FAILEDにリランボタンを出す
- `UNKNOWN` 側は結果として画面リラン不可。Phase 1 §10 の集約(1件以上 `UNKNOWN` → Run status `UNKNOWN`)により、RERUN受理条件(`CREATED/RUNNING/FAILED/CANCELLED`)から外れるため

---

## 3. 「SQL以外のインターフェースが無い」制約を巡る結論

3モデルの批評を、凍結仕様・ADR・Execution Contract v1と照合して確定した内容。

### 3-1. 防御力の源泉(事実の整理)

**「SQLだから安全・冪等」ではない。** `UPDATE APP SET c = c + 1` のような非冪等SQLは容易に書ける。Phase 1 §4.2 が明示するとおり、決定性検査は「**冪等性の証明ではない**」補助検査であり、「`idempotent` 宣言の正しさは**定義作成者の責務**」である。「キー指定のないINSERTや外部への通知は完全に決定的でも非冪等であり、逆に時刻関数を含んでもキー指定UPSERTなら冪等でありうる」とも同条にある。

本質は、**人が `idempotent: true` と宣言したものを信じる代わりに、定義検証・bundleの実体保存・展開時のtraversal防止・直列スケジューラ・停止・再開・監査という枠組みで外側から囲っていること**にある。この理解は拡張方針の判断に直結する(§3-2)。

なお再現性の範囲も限定されている。Phase 1 §2.4 は「`sql_sha256` だけでは元ファイルが失われた場合に再開できない」として**実体保存(bundle)**を採用し、Execution Contract §11 は「snapshotは外部データ、権限、kintone設定、**外部API応答を固定しない**。Execution Resultは**再現性の保証ではなく**、実際に使用したversion・as-of・profile・件数を記録する」と定めている。固定できるのはコード面のみ。

### 3-2. 拡張アプローチの判定

**パターンA: SQL UDF(`SELECT notify_slack(...)` 等)— 却下**

「スケジューラに手を入れないから安全」に見えるが、実際は**契約を壊さないのではなく、契約の検査対象を迂回して同じリスクを持ち込む**。条文根拠:

- Phase 1 §4.2 が「**外部への通知は完全に決定的でも非冪等**」と、通知を非冪等の代表例として名指ししている
- `inspect-job` の非決定要素検査が見るのは時刻関数・乱数であって**副作用ではない**。`idempotent: true` の宣言が**ツールで検出できない嘘**になる
- Phase 1 §7.1 の resume は `FAILED` の冪等ノードを `WAITING` へ戻す → 通知が再送。kSQL-Flow内部のchunkリトライでも再送
- Execution Contract §11「snapshotは外部API応答を固定しない」→ 再現性の外へ出る
- Contract §10 の秘密情報規律に対し、外部APIトークンをSQL層へ持ち込む必要が生じる
- ADR §7 は汎用executorの前提として **allowlist・secret受渡し・sandbox・stdout/stderr上限・signal・冪等性・補償・実行環境管理**の8点を挙げ「別仕様で定義した後に追加する」としている。UDF経路は**このゲートを通らずに同じ能力を入れる**

**パターンB: executor拡張 — 将来の既定路線(現在は保留)**

新提案ではなく**ADRが既に敷いた路線**。ADR §7 は `executor: {type: ksql-flow, sql: ...}` というスキーマ形まで示し、§8 利点に「将来executorを拡張できる」と明記している(定義キーは `runner:` ではなく `executor.type`)。Execution Contract v1 を満たす限定Capability Runnerとして追加する。着手条件の合意まで着手しない(§3-4)。

**パターンC: 外部観測ワーカー — 通知・後続連携の正解(推奨)**

実行管理アプリの終端をGETして通知する独立のone-shotスクリプト。FlowNet本体・DAG・スキーマ・Execution Contractのいずれにも触れない。P2-01のポーラーと同型(kintoneアプリを介した機械間連携、常駐しないcron起動)で、vision §2「常駐プロセスはFlowNetの外に置く」とも整合する。

**但し書き(必須)**: 実行管理・監査アプリは**機械専用**であり、プラグイン・外部からは**GET限定**(P2-08 §4 G-09 / P2-09 §5)。したがって外部観測ワーカーは**読取専用に限る**。書き込めば機械専用制約(人が書く場所と機械が書く場所の分離)を壊す。「本体を汚さない」はこの前提でのみ成立する。

### 3-3. 設計の真のトレードオフ

制約の真の代償は「表現力不足」ではなく、通知や帳票をFlowNetの外へ出すことで、**「DAGの完走」と「業務の完了」が一致しなくなる**点にある。これはPhase 1 §10 の「Run集約 `RUNNING` は生きた実行の存在を意味しない」と同じ、**状態の意味がずれる**問題である。

ただし通知に関しては、P2-01 §6 が「通知連携はしない。アプリの一覧(`01_未処理要求` / `02_拒否された要求`)+kintoneリマインダーで運用する」と方針化済みで、P2-08/09のボードがその実装。**DAG内部へ無理に持ち込む必要はない**。

### 3-4. 着手条件(Gate)

プロジェクト規律(vision §8 原則4「測定してから作る」、§7「Phase 2以降は需要ドリブンであり、着手条件を先に決める」)に従い、以下を置く。

> **executor拡張(パターンB)の着手条件**
> SQL外の処理(帳票生成、ファイル転送等)を**ノードとして順序に組み込む**必要が実業務で2件以上発生し、かつパターンC(外部観測ワーカー)では代替できないと確認できたとき。

---

## 4. 総括

kSQL-FlowNetは、安易な汎用化(Airflow化)の誘惑を退けている。それは消極的な取りこぼしではなく、ADR §9 が棄却案として「最初から汎用オーケストレータにする → 任意コード実行、secret、sandbox、補償等の範囲が急増するため不採用」と**明示的に記録した判断**である。

「業務締めデータの一意性と整合性を絶対に破壊しない」という目的に対し、意図された制約(SQL専用・直列実行・機械専用アプリ)と明示的な契約(Execution Contract v1)を貫いている。今回の討議は新しい方針を作ったのではなく、**その判断の根拠を条文で固定し、拡張路線に着手条件を与えた**ものと位置づけられる。

---

## 付録: 正本への反映先

原則1「正本第一・FDR再審議」に従い、この文書の結論は以下へ正式反映する(この文書自体は討議記録であって正本ではない)。

| 反映先 | 内容 |
| --- | --- |
| `internal/architecture-separation-adr.md` §7 Executor拡張 | パターンAの却下(§3-2の条文根拠つき)と、パターンBの着手条件(§3-4)を追記 |
| `internal/ksql-flownet-vision.md` §7 Phase表 | 「executor拡張」の行を追加し、着手条件列へ §3-4 を記載(現在この項目はどのPhaseにも置かれていない) |
| `internal/ksql-flownet-vision.md` §7 or 運用文書 | パターンC(外部観測ワーカー)を通知の推奨形として記載し、**読取専用**の制約(§3-2但し書き)を併記 |
| P2-12 仕様(新規起票) | 処理前取消。引き継ぐ論点: 競合規則(I-04)、受入配置(X-2)、`ACCEPTED`行のボタン抑止(X-3)、フィールドアクセス権(X-4)、G-09再改訂(X-5)、作業分割(X-6)、更新者≠取消者・変更履歴を正、409握りつぶし+再読込 |
