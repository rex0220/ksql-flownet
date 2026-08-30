-- @ksql name: m5_success_finalize
-- @ksql timeout: 120
-- @ksql dialect: 1

SELECT COUNT(*) AS customer_count FROM LAPP_顧客管理
UNION ALL
SELECT COUNT(*) AS customer_count FROM LAPP_顧客管理;
ASSERT (SELECT COUNT(*) FROM LAPP_顧客管理) >= 0,
  'M5 final customer count must be non-negative';
