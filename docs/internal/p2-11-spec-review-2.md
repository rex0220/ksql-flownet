# P2-11 仕様レビュー 第2回(Claude / 2026-09-02)

- 対象: [p2-11-adhoc-start-spec.md](./p2-11-adhoc-start-spec.md) **DRAFT v3**
- 前回: [p2-11-spec-review.md](./p2-11-spec-review.md)(第3巡 B×2 / C×5 / D×3 / E×6)
- 突合先: [job-network-phase1-spec.md](./job-network-phase1-spec.md) §2.1 / §4.3 / §7.2 / §9、[p2-09-board-request-spec.md](./p2-09-board-request-spec.md) §1但し書き、[p2-01-app-rerun-spec.md](./p2-01-app-rerun-spec.md) G-03/G-04/G-07
- 総評: **前回指摘16点はすべて正しく消化されている。** 特にB-2(b)の「修正採用」(`app_start`は採る/冪等条件は棚卸し根拠で当面維持)は、代案を鵜呑みにせず現環境の事実で判断しており妥当。三重ゲート・不変条件I-01〜03・受理判定matrixの追加で、仕様としての実装可能性は大きく上がった。
- **ただし、v3で受理範囲を広げた結果として新たに露出した問題が2件(N-1, N-2)ある。どちらも§1の主目的「締めのやり直し・補正Run」の成否に直結する**ため、M0で決着が必要。

---

## 0. 前回指摘の消化状況

| # | 指摘 | v3での対応 | 判定 |
| --- | --- | --- | --- |
| B-1 | 起動コマンド契約未定義 | §2に`--resume`明示禁止・キー引数込み契約・`blocked_run_ids`のM2計上・outcome写像 | **可**(N-3の補強を推奨) |
| B-2(a) | correction経路の自己矛盾 | §3キー規則を`scheduled_period`+`business_key`許容へ。受入2(b)・matrix行追加 | **可**(N-1/N-2が新たに露出) |
| B-2(b) | 非冪等一律拒否+`app_start`代案 | `app_start`採用、冪等条件は§7棚卸し(実network1本・全ノード冪等)を根拠に維持 | **可**(N-5の但し書きを推奨) |
| C-1 | 根拠誤り(`--approved-by`) | §4で「外部副作用の発火権限とレビューの問題」へ書き換え | **可** |
| C-2 | `RUN_ID_NOT_ALLOWED`欠落 | §4表・matrixへ追加 | **可** |
| C-3 | 受入3のB-1依存 | 受入3/4を確定内容で書き直し。受入4に「resumeされないこと」の直接検証を追加 | **可** |
| C-4 | START重複ガードの流用不可・表示位置 | 新規実装と明記、等値GET条件を具体化、ヘッダーへ「処理待ちのSTART要求 N件」 | **可** |
| C-5 | 候補とallowlistの非対称 | 2群化+「参考候補(過去実績)」ラベル+欠落注記+自由入力主体 | **可**(N-7は軽微) |
| D-1〜3 | 改訂点漏れ | M0の改訂リストへ明記 | **可** |
| E-1〜6 | profile前提・STALE文言・LOCK_CONFLICT・max_active_runs・DONE規律・用語 | §2/§4/§6受入8/§8へ反映 | **可**(E-4はN-2で不足が判明) |

---

## 1. Blocking(M0で決着が必要)

### N-1. correction START の `as_of` が「起動時刻」になる — 8月分の補正が9月のsnapshotで走る

Phase 1 §9(2026-08-31明確化):

> NEW時の`as_of`は、**`--scheduled-for`指定時はその値をRunへ固定し、未指定時はフィールドをnullとして実行時に`created_at`(Run作成時刻、不変)を用いる**。以降のresume・rerunはこの固定値だけを使用する。

v3 §3のキー規則は `scheduled_period` に対し「`scheduled_for` **または** `business_key` の**どちらか一方**。両方入力はREJECTED」としている。したがって **correction経路(`business_key` = `…@2026-08-correction-1` のみ指定)では `--scheduled-for` が渡らず、`as_of` = 起動時刻(2026-09-xx)** になる。

- business key は `2026-08` を名乗るのに、Run の as-of は 9月。
- 元の8月Runは `--scheduled-for 2026-08-01T00:00:00+09:00` で起動され `as_of = 2026-08-01` に固定されている。**同じ「8月分」を名乗る2本のRunが、異なる as-of で異なる結果を出す。**
- しかも v3 §3 のキー規則は、**この不整合を避ける唯一の組合せ(`business_key` + `scheduled_for` 同時指定)を明示的にREJECTEDにしている。**

これは fail-closed で弾けない種類の欠陥です(入力は正当、Runは正常完走、**結果だけが静かに間違う**)。§1の主目的そのものの経路なので、M0で決着が必要。

決着の選択肢:

1. **`scheduled_period` の correction では `business_key` + `scheduled_for` の同時指定を必須にする**(キー規則を「両方入力はREJECTED」から「`scheduled_period`+`business_key`のときは`scheduled_for`も必須」へ)。意味論的に最も素直。CLI が両フラグ同時指定を受けるかの確認が要る(→ N-2と同じ確認作業)。
2. `monthly_deal_summary` の SQL が as-of ではなく business key / SQLパラメータで期間を決めているなら影響なし。**その場合も「as-of非依存であること」を仕様へ根拠として書く**(将来のnetworkで踏む)。
3. correction は as_of=起動時刻で正しい、という業務判断ならそれを明記する(「補正は最新断面で再集計する」)。ただし元Runとの差分の説明責任が運用に残る。

いずれにせよ **`monthly_deal_summary` の3ノードSQLが as-of をどう使っているかの確認**がM0の前提作業になります。

### N-2. `max_active_runs`(既定1)の判定行が受理範囲表・matrixに無く、しかも「失敗した締めのやり直し」を塞ぐ

§4は E-4 として `max_active_runs` を「実効的な歯止め」と紹介するだけで、**到達時の判定行がありません**(§4表にも§6 matrixにも無い)。Phase 1 §9:

> Networkロック取得後、一致Runが0件でも、**別business keyの未完了Run数が`max_active_runs`に達していれば新規作成せず**、阻害する`run_id`を表示してExit 1とする。

§4.3の active 定義は「`resume_allowed = true` かつ status が `SUCCESS` 以外」。`ARCHIVED` と `resume_allowed = false` は除外されるが、**P2-09 §1但し書きのとおり、その両方を書く経路は現行実装に存在しない**(ARCHIVEDはP2-10、resume_allowed=falseはP2-03残余)。

結果として、既定 `max_active_runs: 1` のもとでは:

| シナリオ | 結果 |
| --- | --- |
| 8月締めが **SUCCESS** → 補正キーでSTART | active 0本 → **通る**(§7が主目的として挙げている経路) |
| 8月締めが **FAILED のまま** → 補正キーでSTART | active 1本 → **`MAX_ACTIVE_RUNS` で拒否される** |
| 8月締めが FAILED のまま → 9月分の臨時START | 同上 → **拒否** |

つまり **「定義を直して別キーでやり直す」(Phase 1 §2.1 が想定する correction の本来の動機)は、元Runが未完了である限り実行できません。** §1の操作モデル表は「失敗・中断した既存Runの再開 → RERUN」と整理しているので設計上は RERUN で拾う建付けであり、これ自体は矛盾ではありませんが、

- **拒否理由コードと案内文言が未定義**。同一キー未完了の行は「RERUNを使用してください」だが、**別キーの `MAX_ACTIVE_RUNS` で同じ案内を出すと誤誘導**になる(RERUNの対象は別のRun)。
- 開放networkが1本・`max_active_runs` 既定1の現環境では、**これは例外ではなく頻出経路**。未完了Runが1本でも残っていれば、あらゆるSTARTがここで止まる。

対応:

1. §4表と§6 matrixへ **`REJECTED / MAX_ACTIVE_RUNS`** 行を追加(阻害 run_id 表示付き。CLIがExit 1で run_id を出すので、B-1の `blocked_run_ids` と同じ受け皿に載る)。
2. 専用文言を定義(例:「別の未完了Run #\<id\> があるため新規実行を開始できません。先にそのRunを完了・停止してください」)。**RERUN案内へ流さない。**
3. §1または§8へ、**P2-10(CLOSE要求→ARCHIVED)への依存**を但し書きとして明記する(P2-09 §1が同じ問題に1節を割いている)。P2-10完了までは「未完了Runを閉じる手段がない=STARTが詰まる状態を人が解消できない」ため、`max_active_runs` を業務判断で2へ上げるかの検討も含める。

---

## 2. 要修正

### N-3. B-1のJSON契約に、CLI改修が不要なフォールバックを併記する

§2は「現行実装はエラー経路のrun_idが`--resume-run`引数由来のためNEW経路ではnullになる**見込み**」として、`blocked_run_ids` の追加をM2へ計上しています。方向は妥当ですが、

- **「見込み」で受入3をブロックしている**。CLIの当該経路が run_id を持てるか(ensure-run が重複禁止INSERTの段階で既存 run_id を知り得るか)は M0 の5分のコード確認で確定できる話で、M2まで持ち越す理由が薄い。
- 万一 CLI 側で run_id を出せない構造だった場合の代替が書かれていない。**ポーラーは network_id と定義パスを知っているので `status <定義パス> --json` で既存Runを引ける**(P2-01 G-03の全network検索とは違い、network が特定済みなので安価)。これをフォールバックとして明記しておけば、M2がCLI改修に依存しなくなる。

→ M0の作業へ「重複案内経路のJSON出力を実コードで確認」を入れ、§2へフォールバックを1行。

### N-4. `--business-key` が `scheduled_period` の network で実際に受理されるか未確認

B-2(a)の採用は Phase 1 §2.1/§9 の記述を根拠にしていますが、**§9の記述は「どの場面でどのフラグを使うか」の運用規則**であって、`business_key_policy.type = scheduled_period` の network に `--business-key` を渡したとき CLI/検証が通す保証にはなっていません(§4.2の必須検証にも `plan`/`run-network` の引数排他の記述はありません)。

受入2(b)は**主目的の経路**なので、B-1と同じく **M0でのコード確認事項**に格上げすべきです。N-1の選択肢1(`business_key` + `scheduled_for` 同時指定)を採る場合は、**同時指定が通るか**も同じ確認に含まれます。実装で弾かれる場合、B-2(a)の採用自体が成立しません。

### N-5. 非冪等拒否(ゲート③)が実機で検証できない

§7の棚卸しどおり、実在networkは1本・全ノード `idempotent: true` です。したがって §6 受入4 の「非冪等(未指定含む)→ REJECTED」は、**スパイク環境に非冪等ノードを持つテスト用network定義を用意しない限り実機で再現できません**。

P2-09 は同型の問題を受入13で「**(単体のみで担保 — 実機再現不能)**」と明示する形で処理しました。ここも同じ扱いにするか、M3の前提として「スパイク環境へ非冪等テストnetworkを1本追加」を作業へ計上するか、どちらかを明記してください。現状の受入4は M3 で実施不能な項目を含んでいます。

### N-6. `app_start: false` が RERUN の対象解決(G-03)を壊さないことを明記する

allowlist は P2-01 G-03 の **RERUN対象解決(run_id → allowlist内の全networkへ`status --json`検索)** でも使われます。`app_start` を同じファイルへ足すとき、**`app_start: false` のエントリを検索対象から除外すると既存のRERUN/STOP/RELEASEが壊れます**(実装で踏みやすい罠)。

→ §2またはM1へ「`app_start` はSTARTの受理判定にのみ用い、G-03の解決対象の絞り込みには用いない」を明記。M2単体へ「`app_start: false` のnetworkのRunに対するRERUNが従来どおり受理される」を1行追加。

### N-7. ゲート③の判定対象と、実際に走る bundle の版がずれうる

ポーラーは working tree の network定義を読んで③(全ノード冪等)を判定し、その後 `run-network` が起動時に **その時点の** working tree から bundle を作ります。判定と起動の間に定義がデプロイで差し替わると、**非冪等ノードを含む定義が③をすり抜けて起動されうる**(ウィンドウは秒〜分)。

fail-closed を掲げる仕様としては、少なくとも運用注記が要ります:「**定義のデプロイ中はポーラーを停止する / allowlist編集とデプロイの順序を固定する**」。厳密にやるなら CLI 側に `--require-all-idempotent` 相当を持たせるのが筋ですが、本体無改修方針と衝突するので、当面は注記+`app_start` の付与手順(§8)へ組み込むのが現実的です。

---

## 3. 軽微

- **N-8. 候補①のラベル**: 「起動実績あり(過去のSTART DONE実績)」の `DONE` には **`NOOP_ALREADY_SUCCESS`(=起動していない)** が含まれます。ラベルは「START要求実績」等が正確。
- **N-9. 文書状態の遷移条件**: P2-01/P2-09 は `REVIEWED`。本書は `DRAFT v3` のままで、**何をもって REVIEWED とするか**(M0の改訂リスト反映+N-1/N-2/N-4の確認完了、等)が書かれていません。§7 M0へ完了条件として1行。
- **N-10. §4「起動したがNetworkロック競合」の語**: Phase 1 §4.3 のとおり **Networkロック取得はRun作成より前**なので、正確には「起動した」ではなく「ロック取得に失敗した(Run/Invocation未作成)」。G-07の`REJECTED`分類と整合していること自体は正しいので、語の修正のみ。

---

## 4. M0での決着順序(更新版)

1. **コード確認3点を先に片付ける**(いずれも短時間で確定する)
   - `run-network --business-key` が `scheduled_period` の network で受理されるか(N-4)
   - `--business-key` + `--scheduled-for` の同時指定が受理されるか(N-1の選択肢1)
   - 重複案内経路の `--json` に既存 run_id が載るか(N-3)
2. **`monthly_deal_summary` の3ノードSQLが as-of をどう使っているか**を確認し、**N-1を決着**(1〜3のどれを採るか)
3. **N-2を決着** — `MAX_ACTIVE_RUNS` の判定行・専用文言を追加し、P2-10依存の但し書きを§1へ。`max_active_runs` を1のまま運用するかを業務判断として記録
4. N-5(実機検証可否の明示)、N-6・N-7(allowlist運用の注記)、N-8〜N-10を反映
5. 受入§6とmatrixを、上記確定内容へ再度そろえる(M0チェック項目「仕様条件追加=受入同時追加」の適用)

N-1・N-2はどちらも「**fail-closedのゲートでは捕まらない**」種類の問題です(前者は正当な入力が静かに誤った結果を出す、後者は正当な入力が頻繁に詰まる)。v3で受理範囲を正しく広げたからこそ露出した論点なので、v3の改訂方向自体は妥当だと考えています。
