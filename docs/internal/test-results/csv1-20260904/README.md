# CSV取込 段階1 実機受入結果(2026-09-04)

- 対象: [csv-io-implementation-plan.md](../../csv-io-implementation-plan.md) §5受入のFlowNet担当分+1万件gate(§8完了条件)
- 環境: スパイク環境+専用CSV1取込先fixtureアプリ(`templates/create-csv1-target-app.console.js`で作成・test_key unique)。`KSQL_FLOWNET_IO_DIR=ローカルIOルート`
- 構成: engine v3.76.0(npm)・kSQL-Flow v0.8.0(npm)・FlowNet `csv/stage1-flownet`ブランチ(第1: d124994 / 第2: cac5039 / E2E: 4303c73)

## 結果(直列実行 00:26〜00:31 JST+9)

| シナリオ | 検証内容 | 結果 |
| --- | --- | --- |
| csv1-03-rejections | INPUT_FILE_MISSING / root外symlinkのINPUT_PATH_REJECTED / `importCsv:false` capabilityの**ロック取得前**拒否・状態不変 | 合格 |
| csv1-01-import-run | UTF-8一気通貫SUCCESS、Attemptのbaseline+rows/encoding要約、対象アプリのセル一致、監査への絶対path・セル値非漏出 | 合格 |
| csv1-02-mutated-resume | 250行の第2書込chunkをHTTP 400で決定的に失敗→同一CSVのresumeが全key各1件へ**収束(行重複なし)**。別Runで差替え後resumeを`INPUT_FILE_MUTATED`でInvocation作成前拒否 | 合格 |
| csv1-04-10k-measure | 1万行×UTF-8/SJISの実測(下表) | 合格 |

## 1万件実測(推奨スペックの根拠)

2列・10,000 data rows・470,021 bytes。子プロセスメモリは10ms間隔サンプリングのpeak。

| encoding | 所要(壁時計) | 子プロセスpeak RSS | heapUsed peak |
| --- | ---: | ---: | ---: |
| UTF-8 | 65.4秒 | 130MB | 43MB |
| SJIS | 63.5秒 | 122MB | — |

計画の見立てどおり、メモリは余裕(見積り30〜60MB圏)で、所要時間はkintoneバルクAPI(100リクエスト分)が支配的。

## 実施中の修正(いずれもハーネス側)

1. `KSQL_FLOWNET_IO_DIR`の事前設定が前提だったため、`setup-env.ps1`へE2E用IOルート既定値を追加
2. 未起動Attemptの`execution_started_at`は共有decoderが空文字を返す(kintoneの空DATETIME表現)ため、シナリオの`null`厳密比較を未設定判定へ緩和

## 段階1の完了判定に対する残り

- 受入1・3・14〜17(round-trip 3方向・export系)は**段階2**の受入
- 文書: 推奨スペック(本実測)の利用者向け文書化・IMPORT運用ガイドはリリース文書工程で実施
