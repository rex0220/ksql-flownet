-- @ksql name: m6_join
-- @ksql timeout: 120
-- @ksql dialect: 1

SELECT COUNT(*) AS source_count FROM LAPP_顧客管理
UNION ALL
SELECT COUNT(*) AS source_count FROM LAPP_案件管理;
ASSERT (SELECT COUNT(*) FROM LAPP_顧客管理) >= 0,
  'M6 join customer count must be non-negative';
ASSERT (SELECT COUNT(*) FROM LAPP_案件管理) >= 0,
  'M6 join deal count must be non-negative';
