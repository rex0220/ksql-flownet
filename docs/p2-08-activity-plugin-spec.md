# P2-08: 案A v1 導出プラグイン 仕様書

- 文書状態: **DRAFT**(Phase 2作業単位。読み取り専用の画面拡張であり凍結仕様の変更なし — FDR再審議不要。本仕様の受入合格が**npm公開のゲート**)
- 起案日: 2026-09-01
- 正本参照: [job-network-phase1-spec.md](./job-network-phase1-spec.md) §7.4(activity導出の正本定義)、共有test vector `tests/fixtures/status-activity/vectors.json`(15ケース)、[討論記録](./kintone-ops-roadmap-discussion.md) §9.3(1)(導出式の単一正本・vector共有)・§10.3、[implementation-plan.md](./implementation-plan.md) P2-08行、[提案書](./kintone-ops-roadmap-proposal.md) §6.2(案A)

## 1. 目的と非目的

**目的**: 一次対応者が実行管理アプリの**画面だけで**「実行中(LIVE)か・未開始(IDLE)か・中断の疑い(INTERRUPTED)か・意図停止(STOPPED)か」を判別できるようにする。現状この判別は`status --json`(CLI)でしかできず、案A v0(標準一覧)ではNODE_STATEの止まり方しか見えない — 「02_未完了Runが残っているが実行中なのか放置なのか」の判断が画面で完結しない。

**非目的**: 書込みを伴う操作(リラン・停止はP2-01の操作要求アプリが担当)。resolve等の復旧操作。モバイル対応。kSQL-Flow側の画面。通知。

## 2. 表示仕様

### 2.1 Run状況ボード(カスタマイズビュー)

実行管理アプリへカスタマイズビュー「00_Run状況」を1枚追加し、プラグインが描画する:

- **未終端のNETWORK_RUN**(status ∉ SUCCESS/FAILED/CANCELLED/UNKNOWN)を1行1Runで表示: `business_key / run_id / status / activityバッジ / started_at / 根拠`
- activityバッジ4値と表示色・一次対応の意味(ops-first-response.mdの文言と一致させる):
  | activity | 意味 | 一次対応 |
  | --- | --- | --- |
  | `LIVE`(緑) | lock ownerが当該Runに属しlease生存 — 実行中 | 待つ(触らない) |
  | `IDLE`(灰) | `started_at`なし — 未開始 | 定期起動を待つ |
  | `STOPPED`(黄) | CANCEL_REQUESTがREQUESTED/ACCEPTED — 意図停止(hold) | 止めた本人に確認。解除はRELEASE要求 |
  | `INTERRUPTED`(赤) | 上記いずれでもない — **中断の疑い** | **二次対応者へ連絡**(Run IDを添えて) |
- **終端Runは表示しない**(activityは未終端のみ — §7.4の凍結契約。終端の確認は既存一覧で行う)
- 根拠列: LIVEはlockのowner_invocation_id/lease_expires_at、STOPPEDはCANCEL_REQUESTのレコード参照、を短く表示
- ボード末尾に**判定時刻**(導出に使ったブラウザ時刻)と再読込ボタンを表示

### 2.2 レコード詳細画面

NETWORK_RUNレコードの詳細画面(`app.record.detail.show`)ヘッダスペースへ、同じ導出のactivityバッジ+根拠を表示する。終端Runには「終端(activityなし)」と表示する。

## 3. 導出の単一実装(ドリフト排除)

- 導出関数は**製品と同一ソース**(`src/orchestration/status.ts`の`deriveRunActivity` — 依存なしの純関数、`KINTONE_DATETIME_TRUNCATION_MS`=60秒の保守判定込み)を、esbuildでプラグインへバンドルする。**実装を2つ作らない**。
- 討論§9.3(1)は「プラグインはCLI出力を使えず実装が2つになる」前提でvector共有を課したが、本方式は同一ソース化で条件をさらに強化する。**共有vector(15ケース)は引き続き受入の正本**であり、プラグインのバンドル済み導出モジュールをNodeテストで同vectorに通すことを受入条件とする(バンドル工程の破損検知)。
- 導出入力の組み立て(kintoneレコード→ActivityInput)はプラグイン側の実装となるため、入力組み立て自体の単体テスト(レコードfixture→入力)を別途持つ。

## 4. データ取得と権限

すべて**読取のみ**(kintone.api GET。書込みAPIは一切呼ばない):

| 入力 | 取得元 | 備考 |
| --- | --- | --- |
| NETWORK_RUN(未終端) | 実行管理アプリ(自アプリ — `kintone.app.getId()`) | `record_type in ("NETWORK_RUN") and status not in (終端4値)` |
| NETWORK_LOCK | 実行管理アプリ | network_id単位 |
| CANCEL_REQUEST | 実行管理アプリ | `CANCEL:<run_id>`、REQUESTED/ACCEPTED判定 |
| RUN_INVOCATION(invocation ids) | **監査履歴アプリ**(プラグイン設定で指定) | lock ownerの当該Run帰属判定に必要 |

- 実行者の権限で読む(APIトークン不使用)。一次対応者に必要な権限: 実行管理・監査履歴の**閲覧**(ops-first-response.mdの「閲覧は自由」と整合)
- API呼数の目安: ボード1回の描画で未終端Run数に応じ3〜5 GET(500件上限のページング付き)。自動リロードはしない(手動再読込のみ — ポーリングで負荷を作らない)

## 5. プラグイン構成・配布

- リポジトリ内`plugin/`ディレクトリ: `manifest.json`(desktop.jsのみ、mobile無し)+設定画面(`config.html/js` — 監査履歴アプリIDの1項目だけ)+esbuildバンドル
- ビルド成果物(zip)は`@kintone/plugin-packer`で生成。**署名秘密鍵(ppk)はリポジトリへコミットしない**(格納先と再発行手順をREADMEに記載)。生成物zipもコミットしない(リリース時に添付)
- カスタマイズビュー「00_Run状況」の追加はConsoleスクリプト(`templates/add-run-board-view.console.js`)で行う(一覧name必須・index規律は既存テンプレの回帰テスト準拠)
- 適用手順: E2E(スパイク4257/4258)で受入→本番4261/4262へ。プラグインzipのインストール・設定はユーザー作業

## 6. 時刻の扱いとリスク

- `nowMs`は**ブラウザ時刻**。kintoneサーバ時刻の取得APIはないため、クライアント時計が大きくずれているとLIVE/INTERRUPTEDを誤表示し得る(leaseの60秒保守判定を超えるずれ)。ボードに判定時刻を常時表示し、runbookへ「表示が不審なときはCLI `status`を正とする」を明記(**CLIが常に正、画面は補助** — 判断が割れたらCLI)
- 導出はread-onlyのため、誤表示しても状態は壊れない(最悪は「待つべきところで連絡する」誤報側)

## 7. 受入基準

1. **vector合格**: プラグインへバンドルした導出モジュールが共有vector全15ケースに合格(Node単体テスト。CIで製品側と同一vectorを読む)
2. 入力組み立ての単体: レコードfixture→ActivityInput(lock/cancel/invocationの紐付け、終端除外、ページング境界)
3. 実機(スパイク環境): (a)実行中Runが`LIVE`、(b)cancel-run後が`STOPPED`、(c)kill後が`INTERRUPTED`、(d)作成直後(未開始)が`IDLE`、(e)終端Runがボードに出ない — 各ケースでCLI `status --json`のactivityと**画面表示が一致**すること
4. 書込みゼロ: 実機確認中のプラグイン由来リクエストにGET以外がないこと
5. 監査アプリ閲覧権限がないユーザーでのフェイル動作: エラーを明示表示し、誤ったactivityを表示しない(fail-closed)
6. 一次対応1ページ・復旧runbookへボードの読み方(4値の意味と行動)を追記し、既存の文言と矛盾しないこと

## 8. 作業分割(想定)

| # | 作業 | 内容 |
| --- | --- | --- |
| M1 | バンドル基盤+導出単体 | `plugin/`雛形、esbuildで`deriveRunActivity`同梱、vector合格テスト(受入1)、入力組み立て+単体(受入2) |
| M2 | プラグイン本体 | Run状況ボード(カスタマイズビュー描画)、詳細画面バッジ、設定画面(監査アプリID)、fail-closed(受入5) |
| M3 | 実機受入 | スパイク環境でLIVE/STOPPED/INTERRUPTED/IDLE/終端の5ケース+書込みゼロ確認(受入3・4)、証跡 |
| M4 | 文書・本番適用 | 一覧追加テンプレ、一次対応1ページ/runbook追記(受入6)、本番インストール手順。完了をもって**npm公開ゲート解除** |

実装はCodex、レビュー・実機受入はClaude Code(確立済み分担)。
