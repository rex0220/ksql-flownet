# 初回本番Run 実施記録(2026-08-31)

- 実施: ユーザー承認のうえClaude Codeが代行(導入計画§4チェックリスト項目)
- 環境: profile=prod / 実行管理4261 / 監査4262 / JOBログ4249 / ksql-flownet main `5ea32ba` dist(実施直前に`npm run build`) / ksql-flow **0.7.0**(`C:\Users\rex02\Projects\ksql-flow\dist\cli.js`)
- requested_by: `rex0220-manual-firstrun`(host: Laptop5)

## コマンドと結果

```
run-network flownet/network-monthly-summary.yaml --resume --scheduled-for 2026-08-01T00:00:00+09:00
→ NEW: Run netrun_9b5e94c6-a494-4a64-9bc0-bf30c5441774 finished with aggregate SUCCESS (OK). Exit 0

(同コマンド再実行 — cron経路のNO-OP検証)
→ NO-OP: Run netrun_9b5e94c6-... is already SUCCESS; nothing was executed. Exit 0
```

## 実機検証(読取API)

| 確認箇所 | 結果 |
| --- | --- |
| 4261 NETWORK_RUN | SUCCESS(business key `monthly_deal_summary@2026-08`) |
| 4261 NODE_STATE ×3 | intake_gate / test_data_gate / monthly_deal_summary すべてSUCCESS |
| 4261 残存 | NETWORK_LOCKはLOCKDONE(解放済み)、RUNNINGなし |
| 4262 監査 | RUN_INVOCATION(mode=NEW, result=OK)+NODE_ATTEMPT×3(execution_id・state_revision_before・written_count記録あり) |
| 4249 JOBログ | 3件追記(execution_idが監査NODE_ATTEMPTと一致)、as_of=2026-08-01T00:00+09:00、RUNNING残存0 |
| 4246 業務結果 | `KSQL-FLOW-TEST-C1`: 当月案件件数=1 / 当月売上合計=1000 / 最終集計日時=as-of値(@NOW()の決定性どおり)。written_count=1と整合(8月に案件があるのは同社のみ) |

## 発見事項(切替ブロッカー→解消)

**my-ksql-jobsのnode_modules内`@rex0220/ksql-flow`は0.6.0でM1実行契約(`capabilities`等)未対応**。初回起動は`KSQL_FLOW_EXIT_MISMATCH`でfail-closed停止した(契約プローブが正しく機能)。`KSQL_FLOW_BIN_ARGS`をgit cloneしたksql-flowリポジトリのdist(0.7.0)へ向けて解消。**追記(同日)**: 実施時点で0.7.0は**npm公開済みだった**(dist-tags latest=0.7.0を実測確認 — 「未公開」は当方の旧情報)。したがって恒久策は`npm install @rex0220/ksql-flow@0.7.0`でnode_modules方式へ戻すことで、clone版dist指定は必須ではない。要件の本質は「**ksql-flow 0.7.0以上(M1実行契約対応)を起動すること**」。
