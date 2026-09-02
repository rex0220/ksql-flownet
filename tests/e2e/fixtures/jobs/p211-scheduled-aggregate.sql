-- @ksql name: p211_scheduled_aggregate
-- @ksql timeout: 120
-- @ksql dialect: 1

-- E2Eが実行直前に読取APIで独立算出した期待値を埋める。業務アプリは更新しない。
ASSERT (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
) = __P211_EXPECTED_COUNT__, 'P2-11 target-period deal count mismatch';

ASSERT (
  SELECT SUM(売上) FROM LAPP_案件管理
  WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
) = __P211_EXPECTED_SALES__, 'P2-11 target-period sales total mismatch';

SELECT COUNT(*) AS target_period_count,
       SUM(売上) AS target_period_sales
FROM LAPP_案件管理
WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START();
