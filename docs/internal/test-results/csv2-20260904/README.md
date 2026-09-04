# CSV出力 段階2 実機受入結果(2026-09-04)

- 対象: [csv-io-implementation-plan.md](../../csv-io-implementation-plan.md) §5受入 1・3・14〜17+FlowNet outputs実機分
- 環境: スパイク環境+CSV1取込先fixtureアプリ。engine v3.77.0(npm)・kSQL-Flow v0.9.0(main 0a66c35・隣接dist)・FlowNet `csv/stage2-flownet`
- cli-kintone: PATH上の実バイナリで実取込(受入3)

## 結果(直列実行 06:33〜06:36 JST+9)

| シナリオ | 受入 | 結果 |
| --- | --- | --- |
| csv2-01-export-run | outputs一気通貫: import→transform→export→finalize。Node Attempt要約(output sha256/rows/encoding)・成果物内容一致・監査path非漏出 | 合格 |
| csv2-02-roundtrip | **受入1**: kSQL export→kSQL import(BY NAME)内容一致(UTF-8/SJIS)。**受入17**: finalizeゲートでFAILEDに保った同一Runへ`--rerun-from export_csv`→**同一sha256**で全量置換→SUCCESS | 合格 |
| csv2-03-clikintone | **受入3**: kSQL exportのCSVをcli-kintoneで実取込→内容一致(互換の実証) | 合格 |
| csv2-04-failclosed | **受入15**: 途中文失敗で完成ファイル・一時ファイルなし。**受入16**: SJIS表現不能文字でfail-closed。受入14は単体参照記録 | 合格 |

## 実施中の修正(いずれもE2E側。製品コード修正なし)

1. **受入17のシナリオ設計誤り**: SUCCESS終端Runへの`--rerun-from`を試みて`RERUN_FROM_SUCCESS_RUN`拒否(製品が正)。**finalize_gateノード(マーカーASSERT)をfixtureへ追加**し、「export成功済み・RunはFAILED」状態を作ってからrerun-fromする形へ再設計。成功系シナリオはマーカー事前投入
2. **マーカーキーの64字上限**: 一意制約付き文字列1行の64字上限(既知のkintone制約)に抵触 → 短縮ハッシュ形式へ
3. targetRequestのエラーへkintone errors詳細を追加(診断性)

## 段階2の完了判定に対する残り

- kSQL-Flow **v0.9.0のnpm publish**(ユーザー操作)
- 利用者向け文書化(FlowNet仕様書へのoutputs節等)はリリース文書工程で実施
