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

- [ ] P2-11の本番適用(本番要求アプリへの3欄追補 → プラグイン更新 → VPSコード更新 → allowlist `app_start: true` → 当月補正smoke)
- [ ] 本番適用記録をinternal/test-resultsへ追記
- 判断: リリース作業と並行可だが、テンプレート作成(R3)前に本番のアプリschemaを最終形にしておく

## R1. リポジトリ・フォルダー整理

- [ ] ルートREADME.mdを公開用に書き直す(製品概要・特徴・docs/への導線・ライセンス)
- [ ] `spikes/` の扱いを決める(開発アーカイブとして残置 or `docs/internal/spikes/`へ移動。npm配布物には含めない)
- [ ] `tests/e2e/results/` 等のローカル生成物がgitignoreされていることを確認
- [ ] `package.json` の `files`(npm同梱物)を確認: dist/のみ同梱、plugin/zip・templates・docs/internalを含めるか決める(推奨: CLIパッケージはdist+README+LICENSE。プラグインzipとテンプレートはGitHub Release添付)
- [ ] LICENSEファイル(MIT)を追加
- [ ] 死んだスクリプト・一時ファイルの棚卸し(templates/のconsoleスクリプトは追補用として残置)

## R2. バージョン確定・凍結

- [x] **プラグインversionを1へリセット**(2026-09-04・zip再パック済み)(manifest.json — 開発中はv2で更新を配っていたため、リリース版として1に戻す。前回リリース時と同じ方針)
- [x] `npm run pack:plugin` で最終zipを生成(2026-09-04)(恒久署名鍵 — プラグインIDは既存インストールと同一のまま)
- [x] `package.json` version確定(1.0.0・2026-09-04)。`private: true`はR6まで維持
- [x] 全ゲート確認(2026-09-04): build / typecheck / lint / test 519/519 / build:plugin / E2E 13本全合格(P2-01×6+P2-11×5+m系代表2。証跡: test-results/r2-gate-20260904)
- [x] git tag候補のコミットを固定(2026-09-04・r2-gate記帳コミット=main先端。以後の変更はやり直し)

## R3. アプリテンプレート作成(kintone)

配布方式の正。複数アプリを1ファイルにするには **kintoneシステム管理 → アプリテンプレート** で登録してダウンロードする(アプリ単体のダウンロードは1アプリのみ。ACLはテンプレートに含まれないため手順書で案内する — 確定方針)。

- [ ] テンプレート元とするスペースで、最終schemaのアプリ4種を確認: 実行管理(00_Run状況ビュー+関連レコード3種+プラグイン適用済み)・監査履歴・操作要求(START 3欄込み)・JOBログ(kSQL-Flow側テンプレートとの整合を確認)
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
