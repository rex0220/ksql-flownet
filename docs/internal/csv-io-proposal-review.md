# CSV入出力提案(v2)レビュー(Claude / 2026-09-03)

- 対象: [csv-io-proposal.md](./csv-io-proposal.md) v2(Gemini第1巡+Claude追加3点反映済み)
- 突合先: execution-contract-v1 §2・§6・§9〜§11、job-network-phase1-spec §2.1・§4.4・§7.1、P2-11(三重ゲート・冪等要件)、現行実装(ensure-run/sequential-scheduler/request-poller)

## 総評

**方向性承認。** 段階1(Contract v1.1へ`--import-csv`)→段階2(engineシリアライザ+`--export-csv`)の順序、F-01型の着手前ゲート(C-1/C-2)、「新しい方言を作らずcli-kintone互換を採る」原則、業務データをFlowNetに通さない層分け(§4)は、いずれもアーキテクチャの規律と整合している。G-1の根拠差し替え(resumeがSUCCESSノードを保持する§7.1意味論に基づくスコープ限定)とG-2の手段変更(一律pre-flightではなくマーカーASSERT)は正しい判断である。

以下の6点を反映してから段階1へ進むことを推奨する(**X-1・X-2は要修正**)。

## 指摘

### X-1(要修正): 入力パターンの`{run_id}`プレースホルダは成立しない

§1-3は入力ファイル名パターンのプレースホルダを`{business_key}` `{profile}` `{run_id}`に限定しているが、**入力ファイルは取込アダプタ(FlowNetの外)がRun作成前に配置する**。アダプタは`run_id`を知り得ないため、`{run_id}`を含む入力パターンは「誰も置けないパス」を生む。さらにresume・補正の意味論とも衝突する(同一business_keyのRunは同一入力を指すべきで、run_id依存はそれを壊す)。

→ **入力パターンは`{business_key}`・`{profile}`のみに限定**する。`{run_id}`は出力ファイル名(orchestratorが生成する側)にのみ許可。

### X-2(要修正): 推奨取込パターン(§1-6)が非冪等 — P2-11三重ゲートと矛盾

§4は「importノードも`UPSERT`/上書きで冪等なので三重ゲート③を維持したままSTARTから起動できる」と主張するが、§1-6の推奨パターンは素の`IMPORT INTO … ON ERROR SKIP INTO #err`であり、**重複時の挙動を指定していない**。kintoneバルクAPI(100リクエスト非アトミック)の途中でAttemptがクラッシュした場合、resumeによるimportノード再実行は**行を重複挿入**し得る。冪等宣言(`idempotent: true`)と実挙動が食い違うのは、P2-11がSTART開放の根拠にしている安全宣言を空洞化させる。

→ 推奨パターンへ**冪等化を必須要素として含める**(`ON DUPLICATE`句によるupsert、または重複禁止キーによる自然な重複拒否+`#err`隔離のどちらを型とするかをC-2と同時に確定)。受入へ「**import途中クラッシュ→resumeで行重複なし**」を追加(受入8はファイル改変の拒否のみで、この検証を含まない)。

### X-3(要確定): sha256検証のスコープに`--rerun-from`を明示

§1-4の拒否対象は「resumeで再実行対象になるimportノード」だが、`--rerun-from`(RETRY_BRAKE解除・二次対応)は**SUCCESS済みノードを選択的に再実行**できる。この経路で再実行されるimportノードにも同じ`INPUT_FILE_MUTATED`検証が要る。文言を「再実行されるimportノード(resume・`--rerun-from`とも)」へ。

### X-4(要確定): `input_files`/`output_files`のFlowNet側写像と見積り漏れ

§4は「Execution Resultへ記録」で止まっており、**FlowNetの監査(NODE_ATTEMPT)へ列として写すのか、result JSON保持のみか**が未確定。列を足すなら実行管理・監査アプリのschema変更(テンプレート追補+schema_version)が必要で、§8の見積り「`input_files`記録とsha256検証: 小」に含まれていない。どちらを採るか(推奨: まずresult JSON+監査`error_message`同様の要約のみ、列追加は需要が出てから)を段階1の設計項目に明記する。

### X-5(小): 不在と改変の区別、保持期間切れ後のresume

- ファイル**不在**は`INPUT_FILE_MUTATED`ではなくIMPORT失敗(→3連続でRETRY_BRAKE)として現れる。結果コード上も**MISSINGとMUTATEDを区別**した方が一次対応の判断が速い
- §7の「保持期間はresume可能な期間を下回らない」は、**P2-10(ARCHIVED化)未実装の現状ではresume可能期間が無期限**のため成立しない。運用線引きを明文化する: 「保持期間(例: 30日)を過ぎたRunはresumeせず、補正キーの新Runで取り込み直す」— これはX-1の意味論(同一キー=同一入力)とも整合する

### X-6(小): 入出力ディレクトリの設定箇所が未定義

「入力ディレクトリはallowlist配下のみ」とあるが、そのallowlistを**どこに設定するか**(環境変数/profile/既存poll-requests allowlistの拡張)が未定義。orchestrator環境変数(例: `KSQL_FLOWNET_IO_DIR`)+network定義は相対名のみ、を推奨(SQL・network定義に絶対パスを持たせない既存規律と揃う)。

## 判定

- **段階1**: ゲートC-2の確認+**X-1・X-2の反映**をもって着手可(X-3〜X-6は反映のうえ設計確定に含める)
- **段階2**: 提案どおりゲートC-1+段階1の1万件実測後
- EXEC-01不要・FlowNet本体CSV出力却下・`EXPORT`文不採用・一律pre-flight不採用の各判断は**支持**
