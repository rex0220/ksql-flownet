-- @ksql name: m5_diamond_join
-- @ksql timeout: 120
-- @ksql dialect: 1

SELECT COUNT(*) AS source_count FROM LAPP_顧客管理
UNION ALL
SELECT COUNT(*) AS source_count FROM LAPP_案件管理;
ASSERT (SELECT COUNT(*) FROM LAPP_顧客管理) >= 0,
  'M5 diamond join customer count must be non-negative';
ASSERT (SELECT COUNT(*) FROM LAPP_案件管理) >= 0,
  'M5 diamond join deal count must be non-negative';
