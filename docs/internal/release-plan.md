# リリース準備 作業手順

- 作成: 2026-09-03 / 状態: **DRAFT**
- 目的: kSQL-FlowNetの初回一般公開(アプリテンプレート+プラグイン+npm+導入記事)までの作業を、依存順に列挙する
- 前提方針(確定済み): 配布はkintoneアプリテンプレートを正とする(ACLは手順書で案内)。npmは検証完了まで`private: true`、公開時にMIT+publishConfig。プラグイン署名鍵は恒久固定(`~/.ksql-flownet/flownet-activity-plugin.ppk`)

## 全体の順序と依存

```
R0 本番適用(P2-11) ─┐
R1 リポジトリ整理 ──┼→ R2 バージョン確定 → R3 アプリテンプレート作成 → R4 導入手順書
                    │                                    ↓
                    │                        R5 クリーンインストール検証
                    │                                    ↓
                    └──────────────→ R6 npm公開 → R7 Qiita記事 → R8 リリースタグ
```

UI・仕様の変更はR2以降凍結する(発生したらR2からやり直し)。

## R0. 本番適用の完了(前提)

- [x] P2-11の本番適用(2026-09-04: 3欄追補 → プラグインv1更新 → VPSをbc25b3fへ更新 → allowlist `app_start: true` → 当月補正smoke合格。発見2件=ポーラーcronのenv不足修正・E2E側誤起票清掃)
- [x] 本番適用記録をinternal/test-resultsへ追記([r0-p2-11-production-20260904](./test-results/r0-p2-11-production-20260904/README.md))
- 判断: リリース作業と並行可だが、テンプレート作成(R3)前に本番のアプリschemaを最終形にしておく

## R1. リポジトリ・フォルダー整理

- [x] ルートREADME.mdを公開用に書き直す(2026-09-04: README.ja.mdと同構成の英語版へ刷新。製品概要・kintone+VPS要件・docs/templates/pluginへの導線・ライセンス)
- [x] `spikes/` の扱い決定(2026-09-04): **開発アーカイブとして残置**。docs/internalから参照されておりnpmには`files` whitelistで元々含まれない — 移動の利得なし
- [x] `tests/e2e/results/` 等のローカル生成物のgitignore確認(2026-09-04: e2e/integration results・plugin/dist・plugin/zip・.ksql・*.ppk・.env系すべて除外済み)
- [x] `package.json` の `files`確認(2026-09-04): `dist`+`schemas`(schemasはdistから実行時参照のため必須)+npm自動同梱のREADME/LICENSE。プラグインzip(gitignore済み・未追跡)とテンプレートはGitHub Release添付の方針どおり
- [x] LICENSEファイル(MIT)を追加(2026-09-04: 名義は(c) 2026 rex0220 — kSQL-Flowと同一名義、ユーザー指定)
- [x] 死んだスクリプト・一時ファイルの棚卸し(2026-09-04: ルート直下に該当なし。templates/のconsoleスクリプトは追補用として残置)

## R1.5. P2-16 操作要求ライフサイクル v2 の同梱(2026-09-05 決定)

v1.0.0 に [P2-16](./p2-16-request-lifecycle-v2-spec.md)(FROZEN v1)を同梱する。理由: 後回しにするとテンプレート・導入手順書・記事・R2〜R8 のリリース作業一式を v1.1.0 で二重に行うことになり、実装工数を上回る。R3 以降は未着手のため凍結やり直しの損失は E2E 再実行と本番再デプロイのみ。

- [x] (2026-09-05 完了) M0: `templates/add-request-lifecycle-v2.console.js`(CLOSE/CANCELLED 選択肢・`cancel_requested`・一覧・フィールド権限)、fault-hook の対象指定+barrier、E2E decoder/terminal 集合の `CANCELLED` 対応。E2E 要求アプリへ追補適用(ユーザー)+「作成者」フィールド権限の実機確認(U-4)
- [x] (2026-09-05 完了) M1〜M2: 契約層・ポーラー・`archive-run`(Codex 実装 → Claude レビュー → 単体)
- [x] (2026-09-05 完了・test-results/p2-16-m3-20260905) M3: 実機 E2E(受入 M3 印)+P2-01/P2-11 回帰
- [x] (2026-09-05 完了・test-results/p2-16-m4-20260905) M4: ボード(取消・解除・クローズ・PUT)→ ユーザー受入
- [x] (2026-09-05 完了) M5: 文書改訂(統合仕様書・P2-01・一次対応・runbook・templates/README)
- [x] (2026-09-05 完了・test-results/p2-16-production-20260905) 本番適用(VPS 92bad60 → 本番要求アプリ追補 → プラグインv1 → claim前取消smoke合格)
- [x] **R2 をやり直す**(2026-09-05 実施・test-results/r2-gate-20260905。2026-09-04 の合格記録は P2-16 前の状態として保持)

## R2. バージョン確定・凍結(P2-16 同梱後にやり直し)

- [x] **プラグインversionを1へリセット**(2026-09-04、P2-16同梱後に再実施 2026-09-05・zip再パック済み)(manifest.json — 開発中はv2で更新を配っていたため、リリース版として1に戻す。前回リリース時と同じ方針)
- [x] `npm run pack:plugin` で最終zipを生成(2026-09-04、再実施 2026-09-05)(恒久署名鍵 — プラグインIDは既存インストールと同一のまま)
- [x] `package.json` version確定(1.0.0・2026-09-04)。`private: true`はR6まで維持
- [x] 全ゲート確認(2026-09-04 → P2-16同梱後にやり直し 2026-09-05): build / typecheck / lint / format / test 575/575 / build:plugin / E2E 18本全合格(P2-01×6+P2-11×5+m系代表2+P2-16×5。証跡: test-results/r2-gate-20260905)
- [x] git tag候補のコミットを固定(2026-09-05 やり直し後: r2-gate-20260905 記帳コミット=main先端。当初bc25b3f→R1完了→P2-16同梱で更新)。以後のコード変更はR2やり直し

## R3. アプリテンプレート作成(kintone)

配布方式の正。複数アプリを1ファイルにするには **kintoneシステム管理 → アプリテンプレート** で登録してダウンロードする(アプリ単体のダウンロードは1アプリのみ。ACLはテンプレートに含まれないため手順書で案内する — 確定方針)。

- [ ] テンプレート元とするスペースで、最終schemaのアプリ4種を確認: 実行管理(00_Run状況ビュー+関連レコード3種+プラグイン適用済み)・監査履歴・操作要求(START 3欄込み)・JOBログ(kSQL-Flow側テンプレートとの整合を確認)
- [ ] 各アプリにアイコンを設定(`templates/icons/` の PNG 4種。アイコンはテンプレートに含まれる)
- [ ] テストデータ・E2E残渣が含まれないことを確認(テンプレートはレコードを含まないが、一覧・通知等の設定残りに注意)
- [ ] システム管理→アプリテンプレートへ登録し、テンプレートファイル(.zip)をダウンロード
- [ ] 別スペースへ試験インポートし、関連レコードの参照先が張り替わること・プラグインのゼロコンフィグ自動検出が効くことを確認
- [ ] テンプレートファイルの配布場所を決める(GitHub Release添付を推奨)

## R4. 導入手順書の作成

新規ユーザーが0から本番運用に到達する1本の手順書 `docs/installation.md` を作成する(既存の断片: templates/README・plugin/README・specification §2 を導線として束ねる)。

- [ ] 章立て: ①前提(kintone・サーバー要件 — specification §2参照) ②アプリテンプレートのインポート ③APIトークン発行と権限(削除不要) ④操作要求アプリのACL推奨設定 ⑤プラグインzipの読み込みとアプリへの追加・設定(START許可CSV含む) ⑥サーバー構築(Node 22+、npm install、環境変数、allowlist、cron 2本) ⑦`validate`・`poll-requests --check`・初回smoke ⑧日常運用への引き継ぎ(一次対応1ページ・復旧runbook)
- [ ] docs/README.md索引へ追加
- [ ] スクリーンショットの要否を決める(Qiita記事側に載せるなら手順書はテキストでよい)

## R5. クリーンインストール検証

- [ ] 検証用スペースでR4手順書**だけ**を見て通しでセットアップ(テンプレートインポート→プラグイン→サーバー→smoke)
- [ ] 手順の抜け・分かりにくさを手順書へ反映(検証者が引っかかった箇所は全て文書バグとして扱う)
- [ ] 検証記録をinternal/test-resultsへ残す

## R6. npm公開(@rex0220/ksql-flownet)

確定方針: 検証完了(R5)までprivate、公開時にMIT+publishConfig。

- [ ] `private: true` を削除、`"license": "MIT"`、`"publishConfig": {"access": "public"}` を設定
- [ ] `files`・`bin`・README(npm表示用)最終確認
- [ ] `npm publish`(publishはask運用 — 実行前にユーザー確認)
- [ ] インストール確認: 素の環境で `npm i -g @rex0220/ksql-flownet` → `ksql-flownet --help`

## R7. Qiita記事作成

- [ ] 構成案: 課題(kintoneでの定期バッチ運用) → kSQL-Flow/FlowNetの役割分担 → アーキテクチャ図 → 導入手順ダイジェスト(テンプレート+プラグイン+VPS) → ボードでの運用イメージ(スクリーンショット: Run状況・新規実行ダイアログ・設定) → 制約と設計判断(fail-closed・機械専用アプリ・三重ゲート) → リンク(GitHub/npm/導入手順書)
- [ ] 下書きを `docs/internal/qiita-draft.md` に作成 → ユーザーレビュー → 投稿はユーザーが実施
- [ ] 記事内の画面はテストデータで撮り直す(実業務値・実アプリIDを写さない)

## R8. リリース確定

- [ ] git tag(v1.0.0)+GitHub Release作成(添付: プラグインzip・アプリテンプレートzip・導入手順書へのリンク)
- [ ] docs/internal/implementation-plan.md のbacklogへ「リリース済み」と残タスク(P2-10/P2-12/P2-13等)の線引きを記録

## 役割分担

| 作業 | 主担当 |
| --- | --- |
| kintone操作(テンプレート登録・試験インポート・プラグイン読込・ACL) | ユーザー |
| 文書作成(導入手順書・記事下書き)・リポジトリ整理・検証立会い | Claude(起案はCodex併用) |
| VPS操作・E2E・ゲート確認・npm publish実行 | Claude(publishはユーザー確認後) |
| Qiita投稿・最終判断 | ユーザー |
