# Spike A D-08判断案

> **位置付け:** FDR正本へ反映する前の判断候補である。未実測の手動確認項目を保証として扱わない。

## D-08: アプリ構成

- 判断候補: **2アプリ案（実行管理＋監査履歴）を採用**
- 判断日: 2026-08-29
- 判断者: ユーザー承認待ち
- 採用案のアプリ境界:
  - 実行管理アプリ: Network Run、Node State、Bundle、Network Lock、現在状態
  - 監査履歴アプリ: Run Invocation、Node Attempt、Attempt Resolution、運用監査イベント、長期保持履歴
  - 既存kSQL-Flow JOBログapp 4249はkSQL-Flow所有のままとし、FlowNetの新規2アプリへ統合しない
- Network Lockの配置: 実行管理アプリ
- 根拠となる測定行ID: A-01〜A-06、A-12。限定条件はA-07〜A-11およびA-12の手動項目

## 判断根拠

1. A-01〜A-05ではAPI呼出数とrequest bytesが両案で完全に同一だった。NEWは24回／9,943 bytes、中間失敗は20回／8,521 bytes、resumeは35回／13,331 bytes、reconciliationは15回／6,398 bytes、revision競合は10回／4,713 bytesである。FDRの注意書きどおり、「アプリ数が増えるとAPI呼出数も増える」は採用・不採用の根拠にならない。
2. クエリ系response bytesは2appが小さい。A-04は1app 17,284 bytesに対して2app 11,255 bytes、A-05は1app 4,547 bytesに対して2app 3,094 bytesだった。2appの実行管理側には、1appにある異なるrecord typeの混在68フィールド返却がない。
3. A-04のreconciliationは両案とも不整合1件を検出し、追加API 4回で1件を修復した。A-05のrevision競合も両案とも409を検出し、再GET後にfail-closedした。reconciliationとrevision防御は同等に成立する。
4. 監査の長期保持、実行管理とのACL分離、監査履歴へのアクセス権分離は2appの構造的利点である。A-06では監査アプリ到達不能の合成障害注入時にSQL／後続処理を開始せずfail-closedした。

## アプリ設計v2への要求事項

- lockライフサイクルは、次のどちらかを採用する。
  - 一意キーフィールドを非必須にし、revision付き単一UPDATEで解放する。
  - 必須キーを維持する場合、現在のキーを退避フィールドへ保存し、一意キーをユニークtombstoneへ書き換え、`RELEASED` statusと解放時刻を同じrevision付きUPDATEで確定する。
- record type別ビューを維持し、実行管理・監査それぞれの主要レコードを混在一覧だけに依存させない。
- 一意キーフィールドの64文字制約を前提にcanonical keyとtombstone形式を設計する。
- dropdownフィールドをクエリするrepository層は`=`を生成せず、`in`（否定は`not in`）を使用する。

## 判断の限定条件

次は未実測（手動確認待ち）であり、2app案の運用適合性を保証するものではない。

- A-07: record type別一覧・検索の使い勝手
- A-08: 通知
- A-09: ACL分離の実地確認
- A-10: archive運用と保持期間
- A-11: テンプレート配布・移行コスト
- A-12: Network LockのACLと回収操作

これらで重大な運用障害または許容できない配布・移行コストが確認された場合は、D-08の採用条件またはアプリ設計v2を再評価する。

## FDR反映候補

- D-08: ユーザー承認後に`PROPOSED`から`DECIDED`へ変更し、2アプリ案採用を記録する。
- D-09: 開始・終了・reconciliation・revision競合・監査到達不能の実測進捗を追記する。ただし残りの全障害点注入が未完了のため`PROPOSED`を維持する。
- D-29: 一意キークリアUPDATE方式を、`CB_VA01`実測に基づき非必須キーまたはユニークtombstone書き換え方式へ補正する。renewable lease等の既存契約と`PROPOSED`状態は維持する。
