# EXEC-01: 登録済みコマンド executor(cli-kintone 対応) 仕様案

- 文書状態: **DRAFT(着手条件未達 — 提案のみ。実装へ進めない)**
- 起案日: 2026-09-02
- 正本参照: [architecture-separation-adr.md](./architecture-separation-adr.md) §7(Executor拡張)・§8.1(ロック階層)・§6(Snapshot境界)、[execution-contract-v1.md](../execution-contract-v1.md) §2・§6・§7・§8・§9・§10、[job-network-phase1-spec.md](./job-network-phase1-spec.md) §4.2・§4.4・§7.1・§7.3・§10、[p2-11-adhoc-start-spec.md](./p2-11-adhoc-start-spec.md) §4(三重ゲート)、[data-io-and-executor-summary.md](./data-io-and-executor-summary.md)
- **方針変更の明示**: ADR §7 は「Phase 1 の executor は `ksql-flow` だけとする」「任意 shell、Python、HTTP、SFTP、Cloud Run 等は実装しない」としている。本仕様は**任意 shell を引き続き実装しない**まま、**運用者が登録した固定コマンドに限って** executor を1種類追加する提案である。ADR §7 の改訂を伴う(§9)。
- **着手条件(未達)**: vision §8 原則4「測定してから作る」に従い、次を満たすまで実装へ進めない。
  > SQL 外の処理を**ノードとして順序に組み込む**必要が実業務で **2件以上**発生し、かつ**取込/配信アダプタでは代替できない**と確認できたとき。

---

## 1. 目的と非目的

**目的**: **添付ファイル(FILE)の取込・取り出しを、DAG の順序に組み込めるようにする。**

これは kSQL IMPORT が構造的に非対応(R12「添付ファイル(FILE)は kSQL IMPORT 非対応」)であり、**Execution Contract を拡張しても到達できない**唯一の領域である。それ以外の理由でこの executor を使ってはならない。

**非目的**:

- **任意 shell / Python / 任意スクリプト**の実行(ADR §7 の禁止を維持)
- **外部ホストへの接続**(FTP / SFTP / HTTP / S3)。§2 の判定基準により対象外
- **到着待ち・Sensor・常駐ポーリング**(Phase 1 §4.4 の責務境界を維持)
- **CSV / JSON の export**(Execution Contract の拡張で吸収する — §2)
- **通知・帳票生成・ファイル転送**
- kSQL-cli の登録(§2)

---

## 2. 判定基準 — なぜ cli-kintone だけか

本仕様は次の2段の判定を通ったものだけを対象とする。この基準自体を ADR §7 へ移す(§9)。

**第1段(一般則)**
> 既存 executor(kSQL-Flow)で到達できる機能は **Execution Contract を拡張して吸収する**。構造的に到達できない機能だけをコマンド登録する。

**第2段(除外条件)**
> ただし、**到着待ち・外部ホストへの接続・不可逆な後始末**のいずれかを含むものはノードにしない。

適用結果:

| 候補 | 第1段 | 第2段 | 判定 |
| --- | --- | --- | --- |
| **cli-kintone**(添付込み import / export) | 到達不能(FILE は kSQL 非対応) | 該当なし(kintone のみ・待たない・消さない) | **対象** |
| kSQL-cli(IMPORT / EXPORT) | **到達可能**(Contract v1.1 に `--import-csv` / `--export-csv` を足せば届く) | — | **対象外**。登録すると Contract を通る経路と通らない経路が並立し、監査・ロック・as-of 固定・bundle が片方だけ効く |
| FTP / SFTP 取得 | 到達不能 | **3つとも該当**(外部ホスト・到着待ち・取得後削除) | **対象外**。取込アダプタで扱う |
| 帳票(PDF / Excel)・通知 | 到達不能 | 要個別判定 | 現時点では**対象外**(別途着手条件) |

---

## 3. 方式

### 3-1. 全体像

```
network.yaml (bundle に入る)
  nodes:
    - id: import_receipts
      executor: { type: command, command: <キー>, args: {...} }
                                    │
                                    ▼
orchestrator ──subprocess──▶ ksql-flownet-command-runner
                               (Execution Contract v1 準拠のラッパー)
                                    │ allowlist を引く
                                    ▼
                            /etc/ksql-flownet/commands.yaml  (VPS・非秘密・bundle 外)
                                    │
                                    ▼
                               cli-kintone ──▶ kintone
```

**orchestrator から見た形は変わらない。** subprocess を起動し、Execution Contract v1 の structured result を受け取る。増えるのは executor の種別だけで、**新しい契約は作らない**(§3-4)。

### 3-2. network 定義に書けるもの

```yaml
nodes:
  - id: import_receipts
    executor:
      type: command
      command: cli-kintone-import-with-attachments   # allowlist のキー
      args:
        app: "1200"
        file: "receipts_{business_key}.csv"          # 入力ディレクトリからの相対
        attachment_dir: "receipts_{business_key}"
    depends_on: [prepare_master]
    trigger_rule: all_success
    idempotent: true      # allowlist の宣言と一致しなければ検証エラー(§4-1)
```

**定義に書けるのはコマンド名(allowlist のキー)と引数の値だけ。** 実行パス、argv の組み立て、許可フラグ、`lock_key`、通す環境変数は**すべて allowlist が持つ**。定義を書く人は実行の中身を決められない。

`{business_key}` などのプレースホルダは orchestrator が Run の値で解決する。**任意の文字列は展開しない**(§4-4)。

### 3-3. command allowlist(VPS 上・非秘密・二次対応者が編集)

```yaml
# /etc/ksql-flownet/commands.yaml
commands:
  cli-kintone-import-with-attachments:
    exec: /usr/local/bin/cli-kintone
    argv_template:
      - "record"
      - "import"
      - "--app"           , "{app}"
      - "--file-path"     , "{input_dir}/{file}"
      - "--attachments-dir", "{input_dir}/{attachment_dir}"
      - "--update-key"    , "レコード番号"        # 冪等の構造的担保(§4-1)
    required_args: [app, file, attachment_dir]
    forbidden_args: ["--delete-all", "--guest-space-id"]   # 不可逆・範囲逸脱の禁止
    idempotent: true
    lock_key: "{profile}:cliktn:app{app}"       # Node ロックへの参加(§4-2)
    env_allowlist: [KINTONE_BASE_URL, KINTONE_API_TOKEN]
    io_dir_allowlist: ["/var/lib/ksql-flownet/io"]
    timeout_sec: 900
    app_start: false                            # P2-11 三重ゲート②と同粒度(§5)
```

- **追加は VPS 上のファイル編集(二次対応者作業)。** allowlist に載せること自体がリリース判断であり、判断した人がファイルに残る — P2-11 の `app_start` と同じ運用線
- 既定はすべて **fail-closed**: 未登録キーは検証エラー、`idempotent` 未指定は `false` 扱い、`env_allowlist` 未指定は環境変数を一切渡さない

### 3-4. command runner — Execution Contract v1 への適合

**新しい契約は作らない。** `ksql-flownet-command-runner` が Execution Contract v1 準拠の Runner として振る舞い、orchestrator 側は無改修で済む。

| Contract v1 の要求 | command runner での実現 |
| --- | --- |
| `--result-json <path\|->` | 起動結果を structured result として出力。stdout へ JSON 以外を出さない(§6) |
| `--correlation-id` / `--attempt-id` | そのまま受領し、監査相関に使う |
| `--expected-job-id` | **`--expected-command <allowlist キー>` に読み替える**(SQL の論理 job ID に相当する identity 検証。executor 種別ごとの identity として Contract へ明記 — §9) |
| 耐久 `EXECUTION_STARTED`(§8.1) | **runner の責務**。cli-kintone は JOB ログアプリへ書かないため、runner が実行前に書く。これは「実行したか不明」の裁定材料であり省略不可 |
| capability negotiation(§9) | `command-runner capabilities --json` が `executionContracts` と、**登録済みコマンドのキー一覧・各エントリの canonical hash・cli-kintone のバージョン**を返す |
| graceful cancel(§7) | SIGTERM 受領後は**新しいコマンドを起動せず、実行中の cli-kintone は完走を待つ**(Phase 1 §4.5 の drain 規律と同じ) |
| secret 規律(§10) | `env_allowlist` に列挙された環境変数のみ子プロセスへ渡す。stdout / stderr は上限付きで切り詰め、トークン様の文字列をマスクしてから結果へ載せる |
| Exit code 互換(§5) | cli-kintone の exit code を Contract の status / resultCode へ写像(§4-6) |

---

## 4. 不変条件と安全設計

### 4-1. 冪等性を「宣言」ではなく「引数の形」で担保する

任意 shell との決定的な違いはここにある。

- `record import` は **`--update-key` を argv_template に固定**する(UPSERT になる)。定義側から外せない
- **`forbidden_args`** に不可逆操作(`--delete-all` 等)を列挙し、runner が argv 組み立て後に再検査する
- `record export` は読み取りのみで当然冪等
- network 定義の `idempotent` が allowlist エントリの `idempotent` と**一致しなければ検証エラー**(`validate` / bundle 作成前)

**それでも「宣言の正しさは登録者の責務」は残る。** ただし責務の所在が、定義を書く人ではなく**コマンドを登録する二次対応者**に移る。`inspect-job` に相当する自動検査は存在しない(Phase 1 §4.2 の非決定要素検査は SQL 専用)ため、この点は明示的な残余リスクとして受け入れる(§8)。

### 4-2. Node ロックへの参加

ADR §8.1 のロック階層は `{profile}:{job_id}`(kSQL-Flow が SQL から解決する論理 job ID)であり、command ノードには論理 job ID が存在しない。

- **`lock_key` を allowlist エントリで宣言**し、runner が実行前に取得する
- キーは **`{profile}:cliktn:app{app}` のように専用の予約セグメント `cliktn` を挟む**。ADR §8.1 が `__net__` を予約語としているのと同型で、**SQL ノードの論理 job ID 空間と衝突させない**
- **同一アプリを触る SQL ノードとの競合は検出できない**(名前空間が別のため)。これは制約として明記し、運用で「添付取込ノードと同じアプリを触る SQL ノードを並行させない」を DAG 設計で担保する(Phase 1 は直列実行なので、同一 Run 内では問題にならない。別 Run・単体実行との競合が残余リスク)

### 4-3. bundle と snapshot 整合

bundle(ADR §6)は `network.yaml` / `manifest.json` / `jobs/*.sql`。**command の実体は bundle に入らない**(exec パス・argv テンプレートは VPS 上の allowlist にある)。

そのままでは Phase 1 §2.4 の「実体保存で担保する」が成立しないため、`describe-profile`(Contract §9.2)と同じ手口で補う:

- Run 作成時に、**使用する allowlist エントリの canonical JSON hash** と **cli-kintone のバージョン**を Network Run snapshot へ保存する
- resume 時に現在値と比較し、**不一致なら SQL を開始せず fail-closed**(新しい Network Run を要求)
- 入力データファイル(CSV・添付)は **bundle に入れない**。業務データが実行管理アプリの添付(`source_bundle_attachment`)として永続保存されるのを避けるため
- 代わりに **入力ファイルの sha256 / bytes を Execution Result の `input_files` に記録**する。データを持たずに同一性だけ監査する(export 側の `output_files` と対称)

### 4-4. 入出力ディレクトリと引数の安全性

- ファイルは `io_dir_allowlist` 配下のみ。**orchestrator が絶対パスを組み立て**、runner が正規化後に再検査する(symlink・path traversal・allowlist 外参照を拒否 — Contract §2 の入力検証と同規律)
- `args` の値は **argv 配列の要素として渡す**。シェルを経由しない(`sh -c` を使わない)
- プレースホルダは `{profile}` `{business_key}` `{run_id}` `{input_dir}` と `required_args` に列挙されたキーのみ。**未知のプレースホルダは検証エラー**
- 値の文字種は ASCII 安全文字に制限(Contract §2 の correlation ID と同規律)

### 4-5. 停止と取消

- STOP(`cancel-run`)は**次のノード境界まで効かない**。実行中の cli-kintone は完走を待つ(Phase 1 §7.4 と同じ意味論)
- `timeout_sec` 超過時は SIGTERM → 猶予 → SIGKILL。**SIGKILL に至った場合は結果を確定できないため `UNKNOWN`**(§4-6)

### 4-6. 失敗と `UNKNOWN`

| 事象 | Node status |
| --- | --- |
| exit 0・件数を結果から取得できた | `SUCCESS` |
| exit ≠ 0・cli-kintone が処理前に拒否(引数・認証) | `FAILED` |
| 通信断・タイムアウト・SIGKILL・結果を解釈できない | **`UNKNOWN`** |

`UNKNOWN` は Phase 1 §2.3 のとおり「完走の可能性と部分適用の可能性を排除できない」。後続の依存を満たさず、自動再実行の対象にもならない。復旧は `resolve-node` による人の裁定になる。

**cli-kintone の部分適用は突合が業務固有になる。** Phase 1 §7.3 が「非冪等なら業務固有の補償または手動復旧が完了するまで自動 resume を禁止」とする領域が、この executor の導入で広がる。想定運用者(中小企業の小規模な情シス)への負荷として §8 に明記する。

---

## 5. P2-11(START)との関係

P2-11 の三重ゲート③は「**全ノードが明示的に `idempotent: true`**」であり、判定材料は network 定義である。

command ノードでは `idempotent` が **allowlist にも宣言されている**ため、ポーラーは:

1. network 定義の全ノードが `idempotent: true` であることを確認(従来どおり)
2. **command ノードについては allowlist エントリの `idempotent` も `true` であることを確認**(定義側の宣言だけを信じない)
3. さらに **allowlist エントリの `app_start: true`** を要求する(ゲート②を command 粒度でも効かせる)

3 を入れる理由は、「network を app_start 開放する」判断と「そのネットワークが添付を書き換えるコマンドを含む」判断を分けるため。**添付ファイルを書き換えるノードを、アプリの追加権限者が誰でも起動できる状態にはしない。**

---

## 6. 受入基準(実機E2E)

1. 添付付き CSV の取込ノードが DAG の順序どおりに実行され、後続 SQL ノードが取込結果を参照して完走する(一気通貫)
2. **冪等性**: 同じ Run を resume して同じ取込ノードが再実行されても、レコードと添付が重複しない(`--update-key` による UPSERT)
3. **引数ゲート**: `forbidden_args` を含む定義、`io_dir_allowlist` 外のパス、未知のプレースホルダ、未登録コマンドキー — いずれも **bundle 作成前に検証エラー**で、FlowNet 状態は不変
4. **宣言の一致**: network 定義の `idempotent` と allowlist の `idempotent` が不一致なら検証エラー
5. **Node ロック**: 同一 `lock_key` の command ノードが別 Run から同時起動された場合、片方が競合として検出される
6. **snapshot 整合**: Run 作成後に allowlist エントリまたは cli-kintone のバージョンを変更してから resume すると、**SQL を開始せず fail-closed** で拒否される
7. **監査**: JOB ログアプリに耐久 `EXECUTION_STARTED` が記録され、`--correlation-id` / `--attempt-id` から Run・Invocation・Attempt へ辿れる。Execution Result の `input_files` に sha256 / bytes が載る
8. **secret**: `env_allowlist` 外の環境変数が子プロセスへ渡らない。結果 JSON・監査レコードにトークン様文字列が出ない(実ネットワーク確認)
9. **停止**: STOP 要求は実行中の cli-kintone を中断せず、次ノード境界で `CANCELLED / STOP_REQUESTED` になる
10. **`UNKNOWN`**: `timeout_sec` を意図的に短くして SIGKILL を発生させ、Node が `UNKNOWN` になり後続が着手されず、自動再実行されないこと。`resolve-node` で解決できること
11. **P2-11 連携**: allowlist の `app_start: false` の command を含む network は START が `REJECTED`。`true` にすると起動できる
12. **回帰**: 既存の SQL のみの network、定期 cron、`poll-requests` に影響がない

---

## 7. 作業分割(着手条件を満たした場合)

| # | 作業 | 内容 |
| --- | --- | --- |
| M0 | 仕様確定 | 本 DRAFT のレビュー(Codex + 外部評価)。**ADR §7 改訂案の確定**、Contract への `--expected-command` 追記案の確定(§9) |
| M1 | allowlist とスキーマ | `commands.yaml` のスキーマ、`executor.type: command` の定義スキーマ、`validate` の検証(未登録キー・引数・プレースホルダ・`idempotent` 一致・パス allowlist) |
| M2 | command runner | Contract v1 準拠のラッパー(result-json / correlation / **耐久 EXECUTION_STARTED** / capabilities / graceful cancel / env allowlist / stdout マスク / exit code 写像)。単体 |
| M3 | orchestrator 側 | executor 種別の分岐、`lock_key` の取得、allowlist hash と cli-kintone version の snapshot 保存・resume 時比較、`input_files` の記録 |
| M4 | 実機受入 | スパイク環境で受入1〜12。証跡 |
| M5 | 文書・本番適用 | ADR §7 改訂、Contract 追記、vision §7 Phase 表、runbook・一次対応1ページ(**添付取込ノードが UNKNOWN のときの手順**)、templates/README |

規模: **L**。ADR と Execution Contract の改訂を伴うため、P2 の作業単位より重い。

---

## 8. 留意点・残余リスク

- **冪等性の自動検査は存在しない。** `inspect-job` の非決定要素検査は SQL 専用。command ノードの `idempotent` は allowlist の宣言であり、正しさは登録者(二次対応者)の責務
- **同一アプリを触る SQL ノードとの競合は検出できない**(§4-2)。DAG 設計と運用で担保する
- **部分適用時の補償が業務固有になる。** `UNKNOWN` からの復旧手順を、コマンド登録時に**業務ごとに書かせる**運用にする(登録の前提条件として文書化)
- **cli-kintone のバージョン管理が新しい運用項目になる。** snapshot 整合(§4-3)により、更新すると既存 Run が resume できなくなる。更新は未完了 Run が無い時間帯に行う
- **入出力ディレクトリのディスクと保持期間**が新しい運用項目になる
- allowlist への登録は VPS 上のファイル編集(二次対応者作業)。**登録=そのコマンドの実行を許可するリリース判断**

## 9. 改訂を要する既存文書

| 文書 | 改訂内容 |
| --- | --- |
| **ADR §7 Executor拡張** | 「Phase 1 の executor は `ksql-flow` だけ」を「`ksql-flow` と、運用者が登録した固定コマンドに限る」へ。**任意 shell / Python / HTTP / SFTP / Cloud Run は引き続き実装しない**を維持。§2 の2段判定基準を追記 |
| **ADR §8.1 ロック階層** | 予約セグメント `cliktn`(または汎用の `__cmd__`)の追加と、SQL ノードの論理 job ID 空間と分離する規約 |
| **ADR §6 Snapshot境界** | allowlist エントリの canonical hash と cli-kintone version を Control Plane snapshot に含める |
| **Execution Contract v1 → v1.1** | executor 種別ごとの identity 検証オプション(`--expected-job-id` / `--expected-command`)の一般化。capability に command runner の項目を追加 |
| **vision §7 Phase 表** | 「executor 拡張」の行を追加し、着手条件を記載(現在どの Phase にも置かれていない) |
| **p2-11 §4** | 三重ゲートの判定に command ノードの allowlist 参照を追記(§5) |
| **ops-first-response.md** | command ノードが `UNKNOWN` になったときの一次対応(二次対応者へ連絡・自動再実行しない) |

---

## 10. この仕様を作らずに済ませる道(先に検討すべき)

本仕様は **L 規模で ADR と Contract の改訂を伴う**。着手前に、次で代替できないかを必ず確認する。

- 添付ファイルの取込が**業務処理の順序に組み込む必要があるのか**。「先に添付を取り込んでおく」で足りるなら、**取込アダプタ**(FlowNet の外の cron + cli-kintone + 取込マーカー)で済み、本仕様は不要
- 添付の取り出しが**配信の一部**なら、**配信アダプタ**の中で cli-kintone を呼べば済む(FlowNet の管轄外なので何を使っても自由)
- 順序の表現力だけが動機なら、**マーカーを先頭ノードの `ASSERT` で確認する形**をまず運用し、実測してから判断する(vision §8 原則4)

**着手条件が「2件以上」かつ「アダプタで代替できないと確認できたとき」なのは、この確認を飛ばさないためである。**
