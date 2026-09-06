# Spike B: 実行バンドル

## 位置付け

本ディレクトリはFDR D-12のbundle保持・archive・復元判断を閉じるための準備物であり、実測結果ではない。

## 検証環境と前提

- kintone: `https://<subdomain>.cybozu.com`（timezone: `Asia/Tokyo`）
- profile: `my-ksql-jobs/ksql.config.json`の`prod`
- 認証環境変数: `KSQL_TOKEN_LOGS`。bundle内SQLが案件・顧客appを検査する場合のみ`KSQL_TOKEN_DEALS`、`KSQL_TOKEN_CUSTOMERS`
- 新規のNetwork Run保存先アプリと、候補archive先をユーザーが作成・許可済みであること
- 添付の追加・取得・差替え・削除を分離して確認できる主体

秘密、`.env`、token値、顧客データをbundleまたは測定記録へ含めない。

## 再実行可能な手順

1. 実施環境、version、新規app ID、archive先、権限主体を記録する。
2. 秘密を含まない決定的データから小・中・上限候補（暫定10MiBを含む）のZIPを生成し、元byte数とSHA-256を記録する。
3. 各サイズをupload/downloadし、API回数、payload byte数、所要時間、取得後SHA-256を記録する。
4. 1 byte破損、添付差替え、削除をそれぞれ試し、hash不一致と権限拒否を確認する。
5. archiveへ移送後、元のRunとの対応を保ったまま復元し、hashとresume可否を確認する。
6. 添付取得不能・archive取得不能・hash不一致を注入し、作業ツリーへfallbackせずfail-closedになることを確認する。
7. 容量分布、resume可能期間、監査保持、削除承認、定期復元試験の候補をまとめる。
8. `decision-template.md`へ測定行IDを根拠として記入する。

## 中止条件

- bundleまたはログに秘密情報・顧客データが含まれる。
- `resume_allowed = true`の検証済みbundleを回復不能にする操作が必要になる。
- hash、Run、添付、archive objectの対応を一意に追跡できない。
- 権限境界を確認できないまま差替え・削除操作へ進む。

## スクリプトによる実行

前提として、`tests/e2e/env.e2e.example`を基に`.env`を用意し、作成済みの2アプリ案の実行管理Spikeアプリを`KSQL_SPIKE_APP_EXEC`へ、同アプリでレコード閲覧・追加・編集・削除を許可したtokenを`KSQL_SPIKE_TOKEN_EXEC`へ設定する。スクリプトは`KSQL_SPIKE_APP_EXEC`以外を対象にせず、既存アプリ4246、4247、4249を拒否する。Node.js 22以上で、リポジトリルートから次を実行する。

```bash
node --env-file=.env spikes/b-bundle/scripts/bundle-roundtrip.mjs
node --env-file=.env spikes/b-bundle/scripts/bundle-roundtrip.mjs --size-mb 20
node --env-file=.env spikes/b-bundle/scripts/bundle-corruption.mjs
```

`bundle-roundtrip.mjs`はstore-only（無圧縮）のZIPを自己検証してから、小（4KiB）、中（1MiB）、上限候補（既定10MiB、`--size-mb`で変更）の順にupload、Network Runへの添付、download、SHA-256照合を行う。指定値は候補であり、kintoneの公式上限を表さない。作成した測定用Network Runは照合後に削除する。`bundle-corruption.mjs`は正常download後の1 byteをローカルで改ざんし、レコードの`source_bundle_sha256`との不一致をfail-closedとして検知する。

結果は実行ごとに`spikes/b-bundle/results/<timestamp>-<script>.json`へ保存される。JSONの`measurementIds`と各サイズの`measurementIds`を`measurements.md`の同じIDへ転記し、環境、日時、回数、API呼出数、ZIP byte数、各所要時間、hash照合結果、残余リスクを埋める。tokenやAuthorizationを含むキーと実際のtoken値は保存前に除去され、混入を検知した場合は結果保存を中止する。

### 権限・archive・復元の手動確認

添付差替え（B-07）、添付削除と承認（B-08）、archiveからの復元（B-09）、保持・外部保管・定期復元（B-11〜B-14）は、権限主体とarchive先が環境ごとに異なるため手動で確認する。

1. 検証専用Run、期待SHA-256、添付fileKey、実施主体、承認者を記録する。
2. 閲覧のみ主体と更新主体を分け、添付差替え・削除が期待した主体だけに許可または拒否されることを確認する。
3. `resume_allowed = true`の元bundleを失わない状態でarchiveへ複製し、object version、SHA-256、取得先を記録する。
4. archiveから別の検証用Runへ復元し、download後SHA-256とresumeに必要なZIP読取りを確認する。
5. 復元確認前には元添付を削除しない。取得不能またはhash不一致なら作業ツリーへfallbackせずfail-closedとする。
6. 結果と承認証跡を対応する測定行へ転記する。
