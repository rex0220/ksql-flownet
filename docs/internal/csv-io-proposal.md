# CSV 入出力サポート 推奨案(v2)

- 作成: 2026-09-02 / 改訂: 同日 — **外部レビュー第1巡(Gemini 4点)を採用**(G-1 は根拠差替+スコープ限定、G-2 は手段変更のうえ採用)。**Claude 追加3点**を反映(§9)
- 状態: **提案。段階1 は着手前ゲート C-2 の確認をもって着手可**
- 前提: 対象規模の目安 **1万件**、汎用製品として配布する
- 関連: [csv-output-evaluation.md](./csv-output-evaluation.md)、[data-io-and-executor-summary.md](./data-io-and-executor-summary.md)、[exec-01-command-executor-spec.md](./exec-01-command-executor-spec.md)、[data-provision-design-note.md](./data-provision-design-note.md)
- 突合先: `execution-contract-v1.md` §2・§6・§9・§10・§11、`architecture-separation-adr.md` §6、`job-network-phase1-spec.md` §2.1・§2.4・§4.2・§7.1、kSQL 言語リファレンス §1・§22、レシピ R1・R2・R7・R8・R11・R12

---

## 0. 推奨の要約

| # | 内容 | 規模 | 着手条件 |
| --- | --- | --- | --- |
| **段階1** | **Execution Contract v1.1 に `--import-csv` を追加**。engine 無改修、flow は引数を素通し | **小** | **ゲート C-2 の確認後、着手可** |
| **段階2** | **engine に CSV シリアライザ + 各面へ `--export-csv`**。スコープ限定で中規模に抑える | **中** | **ゲート C-1 の確認 + 段階1 の 1万件実測後** |
| — | EXEC-01(cli-kintone のコマンド登録) | L | **1万件では不要**。根拠は添付ファイルのみ |
| — | FlowNet 本体への CSV 出力 | — | 却下(業務データが FlowNet を通る) |
| — | `EXPORT` 文の追加 | — | 不採用(SQL がパスを持つのは IMPORT の off-by-default と逆行) |

### 0-1. 着手前ゲート(M0 コード確認)

P2-11 の凍結ゲート F-01 と同じ形で、**仕様が依存する事実を先に確定させる**。

| ID | 確認事項 | どちらの段階の前提か | 分岐 |
| --- | --- | --- | --- |
| **C-2** | **`ENCODING` 句が SQL 側で指定できるか**(位置と構文。現在どの文書にも記載がない) | **段階1** | SQL で指定できるなら Contract 追加は `--import-csv` のみで足りる。**面のオプションでしか指定できないなら `--import-encoding` も Contract へ必要** |
| **C-1** | **結果セットが元の識別子の綴りを保持しているか**(§1「バッククォートで囲んでも結果列名の大文字・小文字は保持されない」は parse/plan 時の正規化を示唆) | **段階2** | 保持していない場合、(a) AST へメタデータ追加 (b) **シリアライザが `getFields` からヘッダを解決** の2案をコスト比較。影響は **ASCII フィールドコードのアプリに限定**(日本語コードは対象外) |

C-2 は**文書の穴であると同時に Contract の設計判断**である。日本語 CSV では Shift_JIS が常態なので、段階1 の設計を確定できない。

---

## 1. 段階1 — `--import-csv` を Execution Contract へ(推奨・先行)

### 1-1. なぜ最初にこれか

- **engine は IMPORT を実装済み。** flow は名前とパスを受けて engine へ渡すだけで、値表現の決定が1つも発生しない
- **kSQL IMPORT の検証・変換が DAG の中で使える** — `CAST`、`ON DUPLICATE`、`ON ERROR SKIP INTO #err`、`CHECK WHEN`、`VALIDATE ONLY`。取込アダプタ(FlowNet の外)では、これらの結果を Run の監査に載せられない
- 1万件はメモリ的に余裕(1行20フィールド×30文字で生6MB、オブジェクト化しても30〜60MB程度)。ボトルネックは kintone 側のバルク API 100リクエスト分の時間

### 1-2. 追加するもの

```bash
ksql-flow run -f monthly.sql --profile p --as-of t \
  --result-json - --correlation-id <run-id> --attempt-id <attempt-id> \
  --import-csv sales=/var/lib/ksql-flownet/io/in/sales_2026-08.csv
```

- Contract §2 の呼出形式へ `--import-csv <name>=<path>` / `--import-json <name>=<path>` を追加(**off-by-default の性質はそのまま**)
- capability(§9)へ `"importCsv": true`。Network ロック取得前に確認し、無ければ何も実行せず検証エラー
- **C-2 の結果次第で `--import-encoding` を追加**
- **パスは orchestrator が組み立てる。** SQL は入力先を知らない
- 入力ディレクトリは **allowlist 配下のみ**。symlink・path traversal・allowlist 外参照を拒否(Contract §2 の既存規律と同じ)

### 1-3. 入力ファイルの命名と配置(**新規 — Claude 追加2**)

出力はノード id と `business_key` から決定的に生成できるが、**入力のファイル名は外部から来る**。したがって:

```yaml
nodes:
  - id: import_sales
    sql: jobs/import_sales.sql
    inputs:
      sales: "sales_{business_key}.csv"     # 入力ディレクトリからの相対
```

- **パターンを network 定義に持たせる**。定義は bundle に入るので、**resume 時も同じファイルを指す**(決定性が確保される)
- プレースホルダは `{business_key}` `{profile}` `{run_id}` に限定。未知のプレースホルダは検証エラー
- orchestrator が `<入力ディレクトリ>/<解決したファイル名>` を絶対パス化して `--import-csv` へ渡す

**取込アダプタ側の規律(重要 — 2つの推奨が衝突する箇所)**

取込アダプタに「処理済みファイルを `processed/` へ移動」を推奨していたが、**移動すると Run の resume で import ノードが読むべきファイルを見失う**。修正する:

> 取込アダプタは**ファイルを移動しない**。`business_key` から決まる決定的なパスへ置き、**保持期間が切れるまでそこに残す**。二重取込の防止は移動ではなく **sha256 の重複禁止 INSERT** が担う。

保持期間は運用パラメータとして明示する(§7)。

### 1-4. bundle と監査、resume 時の sha256(**G-1 採用・根拠差替+スコープ限定**)

- **入力データファイルは bundle に入れない。** bundle は `source_bundle_attachment` として実行管理アプリに添付保存されるため、業務データの永続保存先を増やさない
- 代わりに Execution Result へ **`input_files: [{name, sha256, bytes, rows}]`** を記録。名前は §10 どおり秘密情報を含まない相対表示名へ正規化
- **FlowNet はレコードを1件も持たないまま、何を取り込んだかの同一性を監査できる**

**resume 時の sha256 不一致は拒否する。** ただしスコープを限定する:

> **resume で再実行対象になる import ノード**について、記録済み sha256 と現在のファイルが一致しなければ **`REJECTED / INPUT_FILE_MUTATED`**(fail-closed)。**成功済みノードは再実行されないため対象外**(再読み込みしないので、`input_files` の記録と実際の結果は整合したまま)。

根拠は Phase 1 §2.1 — 同じ `business_key` の Run が別の入力データを表すことになるため。**入力を変えて実行し直すなら、補正キーによる新しい Run が正しい経路**である。

> **注**: レビューで示された「前半ノードと後半ノードが異なるデータを読む」という理由づけは、resume が `SUCCESS` ノードを保持する意味論(§7.1)と噛み合わない。同じ CSV を複数ノードが読む構成でなければ発生しない。上記の business key 意味論が正しい根拠。

### 1-5. ファイル到着の扱い(**G-2 採用・手段を変更**)

**「ファイルがまだ無い」の検出は、先頭ノードの `ASSERT` が取込マーカーを確認する形で担保する。** 失敗理由が「file not found」ではなく「**取込が完了していない**」という業務的に意味のある形でボードに出るため。

- **Contract / orchestrator に一律のファイル存在 pre-flight は入れない。** DAG の状態に依存しない検査になり、上流が失敗して到達しないノードの入力まで要求してしまう
- ノード実行直前の存在確認までに留める
- 「ファイルがいつ届くか」はノードの責務にしない。取込アダプタ(FlowNet の外の cron)が扱う。Phase 1 §4.4 の責務境界を動かさない

> **`RETRY_BRAKE` について**: ファイル不着が3回連続すれば `RETRY_BRAKE`(同じ failure kind が末尾から3回以上連続)で止まる。これは**設計どおりの動作**(人の手が要る状態で機械的な再試行を止める)。ただし解除が `--rerun-from`(CLI 専権・二次対応者)である点は運用負荷なので、留意点として文書化する(§7)。

### 1-6. 不良行の推奨パターン(**新規 — Claude 追加3**)

利用者が各自でパターンを発明しないよう、仕様に例示する。

```sql
IMPORT INTO APP100 (顧客コード, 金額) FROM CSV sales BY NAME
ON ERROR SKIP INTO #err;
ASSERT (SELECT COUNT(*) FROM #err) = 0;    -- または許容件数
```

`VALIDATE ONLY` を別ノードにすると**同じファイルを2回読む**ことになる。`ON ERROR SKIP INTO #err` + `ASSERT` の件数ゲート(R2 の型)なら**1パスで検証と隔離が済み**、`#err` の件数が Run の監査に載る。差分0件を正常とするか異常とするかは運用で選ぶ(R1 の設計原則4と同じ)。

---

## 2. 段階2 — export をスコープ限定で(中規模に抑える)

export の難所は量ではなく **engine にシリアライザが無い**こと。1万件なら量は問題にならないので、**値表現の決定を最小化してコストを中に抑える**。

### 2-1. スコープを限定する

| 項目 | 採否 |
| --- | --- |
| フラットな SELECT 結果の CSV / TSV 出力 | **対象** |
| サブテーブル | **仮想テーブル経由**(`APP100$明細` を SELECT)で行として出す。cli-kintone の `*` 形式は**再現しない** |
| 添付ファイル | **対象外**(IMPORT と同じ。cli-kintone を使う) |
| ストリーミング出力 | **対象外**。全件メモリのまま、上限超過は fail-closed |
| `EXPORT` 文の追加 | **不採用**。面のオプションで受ける |

`*` 形式を捨てるのが効く。R12 の CSV サブテーブル round-trip は cli-kintone の領分として残し、**kSQL は「SELECT した結果を表として出す」だけ**に徹する。

### 2-2. 値表現 — 発明せず cli-kintone 互換を採る

| 項目 | 方針 |
| --- | --- |
| **列名(ヘッダ)** | フィールドコードをそのまま出す。**ゲート C-1 の結果次第**で、(a) 出力時に元の綴りを保持する例外を作るか、(b) **`getFields` からヘッダを解決**(フィールドに1:1で対応する列はフィールドコード、計算列は結果列名)。**(b) なら engine の識別子正規化に触れずに済む** |
| **複数値フィールド** | **セル内 LF**(R12 の cli-kintone 互換) |
| **空セル / NULL** | 空文字 |
| **数値** | **生値をそのまま出す。**算術を通った列は IEEE 754 の誤差が出ることを**文書で警告**し、新しい丸め方針は作らない(§22 の既存性質どおり) |
| **日時** | kintone の保持形式(ISO / UTC)をそのまま。timezone 指定はオプション |
| **文字コード** | UTF-8 既定 / Shift_JIS は R8 の変換資産。**出力できない文字は fail-closed**(黙って落とさない) |

**新しい方言を作らないことが最優先。** 4項目は cli-kintone 互換をそのまま採用し、実質決めるのは「ヘッダの解き方(C-1)」と「数値の方針(=何もしない)」の2つ。

### 2-3. 出力対象の指定 — 名前付きシンク

```sql
CREATE TEMP TABLE #export AS SELECT …;   -- 出力対象を SQL 側に明示
UPDATE … SET 状態 = '処理済' WHERE …;      -- 末尾は完了処理でよい
```
```bash
--export-csv export=/var/lib/ksql-flownet/io/out/deal_2026-08.csv
```

- `CREATE TEMP TABLE ... AS SELECT` は §22 のとおり既存構文。新概念を作らない
- **単文 SELECT のジョブに限り名前を省略可**。**複文で名前なしは実行前にエラー**。「最後の SELECT」を黙って選ばない
- 「最後の SELECT」を採らない理由: 末尾に確認用 SELECT を1文足しただけで出力が別物になり、R1 の型(末尾は完了 UPDATE)や R11 の型(末尾は `SELECT * FROM #err`)と衝突する

### 2-4. 書き出しのタイミングと冪等性

- **全文が成功してから書く。** 一時ファイルへ書いて完了後に rename。バッチは非アトミック fail-fast なので、途中失敗でファイルが残ると配信側が未完成データを拾う
- ①同一パスへ全量上書き ②一時ファイル+rename ③as-of が Run に固定 — この3条件で **CSV 出力は冪等**

---

## 3. 面ごとのインターフェース

**共有すべきは「名前で結ぶ意味論」。** SQL は CLI で書いて試し、flow が本番で回すため、**同じ SQL ファイルが CLI でも flow でも同じものを出す**ことが不変条件。

| 面 | ソース供給(IMPORT) | シンク供給(EXPORT) |
| --- | --- | --- |
| CLI | `--import-csv <name>=<path>` | `--export-csv <name>=<path>`(`-` で stdout 可) |
| ksql-flow | 同上 | 同上。**stdout 不可**(Contract §6「`--result-json -` では stdout へ JSON 以外を出力しない」と衝突) |
| MCP | inline `importSources` | inline `exportSinks`(text / base64) |
| プラグイン | ヘッダの「ファイルを選択」 | 結果グリッドからのダウンロード |

- **層分け**: engine がシリアライズ(IMPORT の逆写像と同じ場所)、面がシンクを供給する。**方言を面ごとに実装しない**
- オプション名は `--import-csv` と対にして **`--export-csv`**
- エンコーディングは面のオプション(`--export-encoding sjis`)。EXPORT 文を作らないため SQL からは指定できない — この非対称は仕様に明記(import 側は C-2 の結果次第で対称にできる)

---

## 4. FlowNet 側の扱い

- import / export とも、orchestrator は**パスを subprocess 引数として渡すだけ**。データは FlowNet を通らず、Contract §10「stdout JSON に顧客レコードの内容を含めない」が保たれる
- Execution Result へ `input_files` / `output_files`(`{name, sha256, bytes, rows, encoding}`)を記録
- 入出力ディレクトリは allowlist。**出力**ファイル名は `business_key` と node id から決定的に生成、**入力**ファイル名は network 定義のパターンから解決(§1-3)
- **配信は依然としてマーカー方式**。export ノードが書いた直後に後続が失敗すれば未完成ファイルが残るため、「配信してよい」の宣言は最終ノードの publish マーカーが担う
- export ノードも import ノードも `UPSERT` / 上書きで冪等なので、**P2-11 の三重ゲート③(全ノード冪等)を維持**したまま START から起動できる

---

## 5. 受入基準

### 5-1. 中核 — round-trip 3方向

方言問題は、これが通れば実質的に解決する。

1. **kSQL export → kSQL import** — 出したものを `BY NAME` で読み戻し、内容が一致する(C-1 の解決策が効いていることの検証)
2. **cli-kintone export → kSQL import** — 既存の R12 の経路が回帰していない
3. **kSQL export → cli-kintone import** — 出したものが公式 CLI で読める(互換の証明)

### 5-2. 段階1

4. 1万件 import の**実メモリと所要時間の実測**(推奨スペックとして文書化)
5. **Shift_JIS の CSV を取り込める**(C-2 で確定した指定方法で)
6. `maxRecords` 超過が **fail-closed**(サイレント切り捨てなし)
7. **サブテーブルを含む import で、既存レコードが `maxRecords` を超えると fail-closed**(R12 の走査上限 — 汎用配布で必ず踏む)
8. **`REJECTED / INPUT_FILE_MUTATED`** — 入力ファイルを差し替えてから resume すると拒否される。**成功済み import ノードのファイルを差し替えても resume は通る**(スコープ限定の検証)
9. **取込アダプタとの結合** — Run 失敗後の resume で、アダプタが置いたファイルが**元の場所に残っており読める**こと(移動しない規律の回帰)
10. 取込マーカーが無い状態で Run を起動すると、**先頭ノードの `ASSERT` で停止**し、import ノードの Attempt が作られない
11. `ON ERROR SKIP INTO #err` + `ASSERT` の件数ゲートが動作し、`#err` の件数が Run の監査に載る
12. allowlist 外パス・symlink・traversal の拒否
13. FlowNet: `input_files` の記録、結果 JSON と監査レコードに業務データが出ないこと(実ネットワーク確認)

### 5-3. 段階2

14. 複文で名前なし `--export-csv` が実行前エラー
15. 全文成功前にファイルが存在しないこと(一時ファイル + rename)
16. Shift_JIS で出力できない文字が fail-closed
17. `output_files` の記録。同じ Run を再実行して**同一 sha256 が再生成される**(冪等性の実測)

---

## 6. やらないこと(明示)

- `EXPORT` 文の追加 — SQL がパスを持つのは IMPORT の off-by-default と逆行
- FlowNet 本体への CSV 出力 — 業務データが Execution Result と監査アプリを通る
- cli-kintone のコマンド登録(EXEC-01) — **1万件では根拠が立たない**。添付ファイルが必要になったときに再検討
- サブテーブル `*` 形式の再現・添付ファイル — cli-kintone の領分として残す
- ストリーミング出力 — 数万件級を狙うときに別途判断
- ファイル到着待ちのノード化 — 取込アダプタの責務
- **一律のファイル存在 pre-flight** — マーカーの `ASSERT` が正(§1-5)

---

## 7. 汎用配布のために決めておくこと

**上限の扱い。** `--max-records` を明示させ、超過は既存規律どおり fail-closed。利用者が3万件を投げてくるので、**そのとき何が起きるかが予測可能**であることが重要。

**超過時の案内。** 「期間で分割してください」または「cli-kintone を使ってください」。案内のない fail-closed は不親切。

**分割取込パターンの提供。** CSV を期間で分けて `business_key` を分け、複数 Run にする。FlowNet の業務キー設計にそのまま乗る標準の逃げ道。

**入力ファイルの保持期間。** 取込アダプタが移動しない方針(§1-3)にしたため、**保持期間の設定が必須**になる。resume が可能な期間を下回らないこと。

**`RETRY_BRAKE` の解除経路。** ファイル不着が3回続くとブレーキが作動し、解除は `--rerun-from`(CLI 専権)。一次対応1ページへ「取込が来ていない場合の手順」として書く。

**推奨スペックの文書化。** 1万件の実メモリと所要時間を実測して出す(受入4)。サブテーブル有無での差も。

---

## 8. 作業見積り

| 段階 | 作業 | 規模 |
| --- | --- | --- |
| **M0** | **ゲート C-2 の確認**(`ENCODING` 句の位置と構文)。分岐に応じて `--import-encoding` の要否を確定 | 極小 |
| 段階1 | Contract v1.1(`--import-csv` / capability `importCsv` / 必要なら `--import-encoding`)、flow の配線、orchestrator のパス解決と allowlist、`input_files` 記録と sha256 検証、contract test | **小** |
| — | 取込アダプタ側の規律修正(移動しない・保持期間) | 極小 |
| **M0'** | **ゲート C-1 の確認**(識別子の綴り保持。(a)/(b) のコスト比較) | 極小 |
| 段階2-a | engine の CSV シリアライザ(値表現6項目)、ヘッダ解決(C-1 の結論に従う) | **中** |
| 段階2-b | 各面への `--export-csv` / `exportSinks` / ダウンロード、名前付きシンクの解決、単文/複文の判定 | **小〜中** |
| 段階2-c | Contract v1.1(`--export-csv` / capability `resultCsv`)、`output_files` 記録 | **小** |
| 共通 | round-trip 3方向の受入、1万件実測、文書 | 中 |

**文書作業(段階1と同時)**: 言語リファレンスへ **IMPORT の独立節**を新設する(現在 §1〜26 のどれにも無く、文法の正本は R11 / R12 の実例のみ)。`ENCODING` 句、句の順序、`CHECK WHEN` の完全形を記載。段階2 で EXPORT を同じ節へ追記する。

---

## 9. レビュー対応記録

**第1巡(2026-09-02 Gemini 4点)**

| # | 指摘 | 採否・判断 |
| --- | --- | --- |
| G-1 | resume 時の入力 sha256 不一致は拒否すべき | **採用・根拠差替+スコープ限定**(§1-4)。理由づけを「前半/後半ノードの不整合」から **Phase 1 §2.1 の business key 意味論**へ差し替え(resume は `SUCCESS` ノードを保持するため、提示された不整合は同じ CSV を複数ノードが読む構成でしか起きない)。拒否対象を**再実行される import ノードに限定** |
| G-2 | ファイル不在は Network ロック取得前の pre-flight で fail-fast に | **目的採用・手段変更**(§1-5)。「ロックを握ったまま落ちる」はノード失敗時に Invocation が正常終端しロックを解放するため発生しない。一律 pre-flight は DAG 状態に依存しない検査になり過剰。**マーカーの `ASSERT`** が正で、失敗理由も業務的に意味のある形で出る。`RETRY_BRAKE` は設計どおりの動作として扱い、解除経路を留意点へ |
| G-3 | ヘッダ保持は parse ツリー側の改修かもしれず M0 調査へ | **採用**(ゲート C-1)。**`getFields` からヘッダを解決する第2案**を併記(engine の識別子正規化に触れずに済む)。影響が **ASCII フィールドコードに限定**される点も明記 |
| G-4 | doc gap(IMPORT の独立節)を段階1と同時に解消 | **採用・格上げ**。文書作業であると同時に **Contract の設計判断**(ゲート C-2)。SQL で `ENCODING` を指定できなければ `--import-encoding` が必要になる |

**Claude 追加(同巡)**

| # | 内容 | 反映先 |
| --- | --- | --- |
| 追-1 | 取込アダプタの `processed/` 移動と resume が衝突する(2つの推奨の組合せで壊れる) | §1-3(移動しない・保持期間で管理)、§7、受入9 |
| 追-2 | 入力ファイル名の決め方が未定義。**network 定義にパターンを持たせて bundle に入れる** | §1-3、§4 |
| 追-3 | 不良行の推奨パターンを例示(`ON ERROR SKIP INTO #err` + `ASSERT` の件数ゲート。`VALIDATE ONLY` を別ノードにすると同じファイルを2回読む) | §1-6、受入11 |
