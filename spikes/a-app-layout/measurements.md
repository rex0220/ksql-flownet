# Spike A 測定表

> **位置付け:** 2026-08-29の実機Spike A結果を転記した測定記録である。payloadは秘密を除去した集計値だけを記録する。所要時間はJSONの`durationMs`を小数第3位へ丸めた。

## 測定環境

- 日時: 2026-08-29（JST。結果JSONの`observedAt`はUTC）
- ホスト／OS: `LAPTOP5`／`win32`
- Node.js: `v24.14.0`
- kintone: `<subdomain>.cybozu.com`
- 実行回数: 各シナリオ1回。各結果内で同一データを1app、2appへ順に適用
- app ID: 12件の結果JSONには未収録（layoutのroleだけを収録）。データソース外から補完しない
- request／response bytes: 各結果JSONの`payload.requestBytes`／`payload.responseBytes`。未計測request bodyは全件0

## 修正後の合格実行

| ID   | 測定項目                               | 案   | API呼出数 | request bytes | response bytes | 所要時間 (ms) | 修復API数 | 結果                                                                                                | 出典results                                                      |
| ---- | -------------------------------------- | ---- | --------: | ------------: | -------------: | ------------: | --------: | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A-01 | NEW成功時                              | 1app |        24 |         9,943 |            474 |     8,431.290 |         — | `SUCCESS`、lock解放成功                                                                             | `2026-08-29T12-12-42.573Z-scenario-new-success.json`             |
| A-01 | NEW成功時                              | 2app |        24 |         9,943 |            474 |     6,696.618 |         — | `SUCCESS`、lock解放成功                                                                             | `2026-08-29T12-12-42.573Z-scenario-new-success.json`             |
| A-02 | 中間Node失敗時                         | 1app |        20 |         8,521 |            400 |     5,330.768 |         — | `extract=SUCCESS / aggregate=FAILED / send=BLOCKED`、lock解放成功                                   | `2026-08-29T12-13-00.131Z-scenario-mid-failure.json`             |
| A-02 | 中間Node失敗時                         | 2app |        20 |         8,521 |            400 |     4,978.675 |         — | `extract=SUCCESS / aggregate=FAILED / send=BLOCKED`、lock解放成功                                   | `2026-08-29T12-13-00.131Z-scenario-mid-failure.json`             |
| A-03 | resume時                               | 1app |        35 |        13,331 |            670 |     9,995.259 |         — | `aggregate`、`send`だけ再実行し`SUCCESS`。`extract`の追加Attemptは0                                 | `2026-08-29T12-13-29.895Z-scenario-resume.json`                  |
| A-03 | resume時                               | 2app |        35 |        13,331 |            670 |    10,127.551 |         — | `aggregate`、`send`だけ再実行し`SUCCESS`。`extract`の追加Attemptは0                                 | `2026-08-29T12-13-29.895Z-scenario-resume.json`                  |
| A-04 | Attempt成功後・State更新失敗からの復旧 | 1app |        15 |         6,398 |         17,284 |     5,415.157 |         4 | 不整合1件を検出・1件修復、`failClosed=false`                                                        | `2026-08-29T12-13-44.792Z-scenario-reconciliation.json`          |
| A-04 | Attempt成功後・State更新失敗からの復旧 | 2app |        15 |         6,398 |         11,255 |     3,990.549 |         4 | 不整合1件を検出・1件修復、`failClosed=false`                                                        | `2026-08-29T12-13-44.792Z-scenario-reconciliation.json`          |
| A-05 | Node State revision競合                | 1app |        10 |         4,713 |          4,547 |     2,863.352 |         — | `GAIA_CO02` (409)を検出、再GET 1回後にfail-closed                                                   | `2026-08-29T12-13-55.159Z-scenario-state-revision-conflict.json` |
| A-05 | Node State revision競合                | 2app |        10 |         4,713 |          3,094 |     3,251.896 |         — | `GAIA_CO02` (409)を検出、再GET 1回後にfail-closed                                                   | `2026-08-29T12-13-55.159Z-scenario-state-revision-conflict.json` |
| A-06 | 監査アプリ一時到達不能                 | 1app |         0 |             0 |              0 |         0.260 |         — | 非適用（監査アプリを分離しないためskip）                                                            | `2026-08-29T12-13-59.390Z-scenario-audit-unreachable.json`       |
| A-06 | 監査アプリ一時到達不能                 | 2app |         8 |         4,936 |            173 |     2,073.587 |         — | fetch wrapperによる合成障害注入。監査書込み失敗後、SQL／後続処理を開始せずfail-closed、lock解放成功 | `2026-08-29T12-13-59.390Z-scenario-audit-unreachable.json`       |

A-04とA-05はクエリ系responseを含み、2appでは実行管理レコードの取得時に1appの混在68フィールドを返さない。この実行ではresponse bytesがA-04で17,284から11,255、A-05で4,547から3,094へ減少した。書込み操作列が主体のA-01〜A-05では、API呼出数とrequest bytesは両案で完全に同一だった。「アプリ数が増えるとAPI呼出数も増える」という関係は本測定では成立しない。

## A-12: Network Lock配置時の競合・ACL・回収操作

| 対象          | 1app                                                              | 2app                                                            | 出典results                                                      |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| NEW           | API 24、request 9,943 bytes、response 474 bytes、8,431.290 ms     | API 24、request 9,943 bytes、response 474 bytes、6,696.618 ms   | `2026-08-29T12-12-42.573Z-scenario-new-success.json`             |
| 中間Node失敗  | API 20、request 8,521 bytes、response 400 bytes、5,330.768 ms     | API 20、request 8,521 bytes、response 400 bytes、4,978.675 ms   | `2026-08-29T12-13-00.131Z-scenario-mid-failure.json`             |
| resume        | API 35、request 13,331 bytes、response 670 bytes、9,995.259 ms    | API 35、request 13,331 bytes、response 670 bytes、10,127.551 ms | `2026-08-29T12-13-29.895Z-scenario-resume.json`                  |
| 通常解放      | 必須かつ重複禁止の一意キーをユニークtombstoneへ書き換えて解放成功 | 同左                                                            | 上記3結果                                                        |
| revision競合  | A-05で409を検出し、再GET後にfail-closed                           | 同左                                                            | `2026-08-29T12-13-55.159Z-scenario-state-revision-conflict.json` |
| ACL・回収操作 | 未実測（手動確認待ち）                                            | 未実測（手動確認待ち）                                          | —                                                                |

実測から、lockライフサイクルは「非必須の一意キーフィールド」または「解放済みキーの退避フィールドと`RELEASED` statusを備えたユニークtombstone書き換え」を前提とする必要がある。一意キーフィールドは64文字制約も設計条件に含める。

## 初回実行の発見記録

初回6件は合否判定の根拠値ではなく、修正へつながった発見記録として保持する。JSON上、先頭5件の全体`passed`は`false`である。監査到達不能だけは全体`passed=true`だが、2appのlock解放は`CB_VA01`で失敗している。

| 対応ID     | シナリオ       | 1app: API / request / response / ms | 2app: API / request / response / ms | 発見                                                        | 出典results                                                      |
| ---------- | -------------- | ----------------------------------- | ----------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| A-01、A-12 | NEW            | 24 / 9,892 / 597 / 6,710.869        | 24 / 9,900 / 602 / 5,534.901        | 必須かつ重複禁止フィールドへの空文字UPDATEを`CB_VA01`で拒否 | `2026-08-29T11-53-03.825Z-scenario-new-success.json`             |
| A-02、A-12 | 中間Node失敗   | 20 / 8,485 / 532 / 5,628.478        | 20 / 8,480 / 529 / 5,700.507        | 同上                                                        | `2026-08-29T11-53-21.649Z-scenario-mid-failure.json`             |
| A-03、A-12 | resume         | 35 / 13,295 / 802 / 11,314.730      | 35 / 13,292 / 800 / 8,650.078       | 同上                                                        | `2026-08-29T11-53-49.186Z-scenario-resume.json`                  |
| A-04       | reconciliation | 11 / 5,544 / 367 / 4,117.199        | 11 / 5,544 / 367 / 3,225.975        | dropdownへの`=`クエリを`GAIA_IQ03`で拒否。`in`へ修正        | `2026-08-29T11-54-01.698Z-scenario-reconciliation.json`          |
| A-05       | revision競合   | 9 / 4,461 / 430 / 2,545.042         | 9 / 4,461 / 430 / 2,778.666         | dropdownへの`=`クエリを`GAIA_IQ03`で拒否。`in`へ修正        | `2026-08-29T11-54-11.291Z-scenario-state-revision-conflict.json` |
| A-06       | 監査到達不能   | 0 / 0 / 0 / 0.143（非適用）         | 8 / 4,900 / 304 / 2,442.335         | 障害注入後はfail-closed。ただしlock解放は`CB_VA01`で失敗    | `2026-08-29T11-54-16.020Z-scenario-audit-unreachable.json`       |

## 未実測項目

| ID   | 測定項目                     | 状態                   |
| ---- | ---------------------------- | ---------------------- |
| A-07 | 一覧・検索の使い勝手         | 未実測（手動確認待ち） |
| A-08 | 通知                         | 未実測（手動確認待ち） |
| A-09 | ACL分離の実地確認            | 未実測（手動確認待ち） |
| A-10 | archive・保持期間            | 未実測（手動確認待ち） |
| A-11 | テンプレート配布・移行コスト | 未実測（手動確認待ち） |

## 実測で得た実装制約

- 必須かつ重複禁止の文字列フィールドは空文字UPDATEで解放できない（`CB_VA01`）。修正後はユニークtombstoneへの書き換えで解放した。
- dropdownフィールドはクエリの`=`を受け付けず、`in`を使用する（`GAIA_IQ03`）。
- 2appでは監査アプリ到達不能を合成注入した場合、後続処理を開始せずfail-closedできた。
