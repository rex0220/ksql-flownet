# kSQL-FlowNet ドキュメント

## 利用者・運用者向け

| 文書 | 内容 |
| --- | --- |
| [統合仕様書](./specification.md) | 現在の実装の仕様。アーキテクチャ、kintoneアプリ構成、network定義、CLI、操作要求とポーラー(RERUN/STOP/RELEASE/START)、ボードプラグイン、セキュリティ境界、既知の制約 |
| [一次対応1ページ](./ops-first-response.md) | ボードの見方と操作要求の起票手順。状態別の一次対応 |
| [復旧runbook](./runbook-recovery.md) | 障害時の復旧手順。STALE・ロック・UNKNOWNの決着、定義デプロイ時の手順 |
| [CSV入出力の運用](./csv-io-operations.md) | 入力CSVをサーバーへ置く/出力CSVを取り出す構成と手順。パス規約・不変条件・エラー早見 |
| [Execution Contract v1](./execution-contract-v1.md) | kSQL-Flow(実行プレーン)とのCLI境界契約 |

セットアップ・配布物:

- [templates/README.md](../templates/README.md) — kintoneアプリの作成・追補スクリプトとアプリテンプレート配布方針
- [plugin/README.md](../plugin/README.md) — Run状況ボードプラグインの導入・設定・更新手順

## 開発資料([internal/](./internal/))

開発経緯の正本(Phase 1仕様・P2-XX仕様・凍結判断記録)、実装計画、外部レビュー記録、実機受入・ゲート記録(`internal/test-results/`)は [internal/](./internal/) にあります。作業単位のbacklogは [internal/implementation-plan.md](./internal/implementation-plan.md)。

これらは経緯と判断の記録であり、現在の動作仕様は上の[統合仕様書](./specification.md)が正です。
