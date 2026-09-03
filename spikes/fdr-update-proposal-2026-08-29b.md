# FDR更新提案書（2026-08-29 第2弾）

反映状態: REFLECTED(2026-08-29)

> **これは正本ではない。ユーザー承認後の別ラウンドで`docs/internal/phase1-freeze-decision-record.md`へ反映する。** 本提案では`docs/`を変更しない。

## 共通の実測条件

- 実施日: 2026-08-29（JST）
- 環境: `LAPTOP5`／`win32`／Node.js `v24.14.0`／`devenxyfi.cybozu.com`
- app ID: 対象12件の結果JSONには未収録。layoutのroleは記録されているが、データソース外からIDを補完しない
- 実行コマンド:

```powershell
node --env-file=.env spikes/a-app-layout/scripts/scenario-new-success.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-mid-failure.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-resume.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-reconciliation.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-state-revision-conflict.mjs
node --env-file=.env spikes/a-app-layout/scripts/scenario-audit-unreachable.mjs
```

修正後の合格実行は`spikes/a-app-layout/results/2026-08-29T12-12-42.573Z-scenario-new-success.json`から`2026-08-29T12-13-59.390Z-scenario-audit-unreachable.json`までの6件である。初回の発見記録6件は同ディレクトリの11-53〜11-54の結果を参照する。

## 1. D-08: 2アプリ案の採用

- 提案状態: `PROPOSED` → `DECIDED`
- 判断案: FlowNetの永続化を「実行管理アプリ＋監査履歴アプリ」の2アプリ構成とする。既存kSQL-Flow JOBログapp 4249は数に含めず、所有境界も変更しない。
- Superseded: **なし**。既存の第一候補と比較要件に、実測結果と決定案を追記する。

### シナリオ別実測値

| シナリオ（測定行）     | 1app: API / request / response / ms | 2app: API / request / response / ms              | 結果                                                     |
| ---------------------- | ----------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| NEW成功（A-01）        | 24 / 9,943 / 474 / 8,431.290        | 24 / 9,943 / 474 / 6,696.618                     | 両案合格                                                 |
| 中間Node失敗（A-02）   | 20 / 8,521 / 400 / 5,330.768        | 20 / 8,521 / 400 / 4,978.675                     | 両案合格                                                 |
| resume（A-03）         | 35 / 13,331 / 670 / 9,995.259       | 35 / 13,331 / 670 / 10,127.551                   | 両案合格                                                 |
| reconciliation（A-04） | 15 / 6,398 / 17,284 / 5,415.157     | 15 / 6,398 / 11,255 / 3,990.549                  | 両案とも1件検出・1件修復、追加API 4、fail-closedなし     |
| revision競合（A-05）   | 10 / 4,713 / 4,547 / 2,863.352      | 10 / 4,713 / 3,094 / 3,251.896                   | 両案とも409検出・再GET 1回・fail-closed                  |
| 監査到達不能（A-06）   | 非適用、API 0                       | API 8 / request 4,936 / response 173 / 2,073.587 | 2appは合成障害注入後にSQL／後続処理を開始せずfail-closed |

### 決定根拠

- A-01〜A-05のAPI呼出数とrequest bytesは両案で完全に同一であり、「アプリ数が増えるとAPIも増える」は成立しなかった。FDRの現行注意書きと整合する。
- クエリ系response bytesは2appが小さい。1appの異なるrecord typeで混在する68フィールドを、2appの実行管理クエリは返さない。
- reconciliationとrevision競合防御は両案で同等に成立した。
- 監査履歴の長期保持、ACL分離、アクセス権分離は2appの構造的利点である。

### 残余の手動確認と凍結ゲート

ACL分離の実地確認、通知、一覧・検索の使い勝手、archive運用と保持期間、テンプレート配布・移行コスト、Network LockのACL・回収操作は未実測（手動確認待ち）である。特にFDRへの要約では、少なくともACL実地、通知、archive運用、テンプレート配布を残余項目として列挙する。

D-08を`DECIDED`として記録する案を提示するが、凍結ゲート「D-08: 1アプリ／2アプリのスパイク結果から構成を決定」のチェックを完了扱いにするかは、上記限定条件を踏まえたユーザー判断に委ねる。

## 2. D-09: 二重書込みプロトコルの実測進捗

- 提案状態: `PROPOSED`を維持
- Superseded: **なし**。既存プロトコルへ実測進捗と未完了範囲を追記する。

### 追記案

2026-08-29のSpike Aで、NEWの開始から終了、意図した中間Node失敗、失敗後のresume、Attempt terminal更新後かつNode State更新前の障害からのreconciliation、Node Stateのrevision競合、2appの監査アプリ到達不能を実測した。reconciliationは両案とも不整合1件を検出し、追加API 4回で1件を修復した。revision競合は両案とも`GAIA_CO02` (409)を検出し、再GET後にfail-closedした。監査到達不能はfetch wrapperによる合成障害注入でありkintone実挙動の観測ではないが、2appは監査書込み失敗後にSQL／後続処理を開始しなかった。

Attempt INSERT成功応答消失など、D-09が要求する全障害点の注入は未完了である。残りはM3実装時の試験で完了させるため、D-09と対応する凍結ゲートは`PROPOSED`／未チェックを維持する。

## 3. D-29: 通常lock解放方式の実測補正

- 提案状態: `PROPOSED`を維持
- Superseded: **なし**。2026-08-29の前回追記を置換せず、実測による補正を追加する。

### 追記案

前回追記した「一意キークリアUPDATE方式」をSpike Aで実測した結果、必須かつ重複禁止の文字列フィールドを空文字へ更新する解放は`CB_VA01`で拒否された。したがって通常解放は、次のいずれかをアプリ設計の前提とする。

1. lockの一意キーフィールドを非必須として、終端・解放情報とキーのクリアをrevision付き単一UPDATEで確定する。
2. 必須キーを維持する場合は、現在キーを退避フィールドへ保存し、一意キーフィールドを衝突しないユニークtombstoneへ書き換え、`RELEASED` statusと解放時刻をrevision付き単一UPDATEで確定する。

修正後のSpike Aでは2のtombstone方式でNEW、中間失敗、resume、reconciliation、revision競合、監査到達不能の各対象lockを解放できた。この追記は前回方針の撤回・置換ではなく、「クリア」が成立するschema条件を実測で精緻化する補正である。D-29のrenewable lease、heartbeat、drain、旧owner停止確認、強制回収契約は変更せず、残りの障害注入が未完了のため`PROPOSED`を維持する。

## 4. FN-04／FN-05向け実装ノート

- 付記先: FDRのD-08／D-09節
- Superseded: **なし**。実測で判明したrepository・schema制約を追記する。

### 追記案

- FN-04のrepository層はフィールド型ごとのクエリ演算子制約を吸収する。dropdownは`=`でなく`in`を使用し、否定は`not in`を使用する。Spike Aでは`=`が`GAIA_IQ03`で拒否された。
- canonicalな一意キーと解放tombstoneは、kintoneの一意キーフィールドの64文字制約内に収める。長い入力は規定のdigest形式へ正規化する。
- FN-05を含むlock更新実装は、必須かつ重複禁止キーへの空文字UPDATEに依存しない。非必須キー設計または「退避フィールド＋ユニークtombstone＋`RELEASED` status」のrevision付き単一UPDATEを使用する。

## Superseded一覧

今回の提案にSupersededはない。D-08は既存第一候補を実測で決定する追記、D-09は進捗追記、D-29は前回追記の実測補正、FN-04／FN-05は実装制約の付記である。
