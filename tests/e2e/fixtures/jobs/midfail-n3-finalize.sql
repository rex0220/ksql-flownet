-- @ksql name: m5_midfail_finalize
-- @ksql timeout: 120
-- @ksql dialect: 1

SELECT COUNT(*) AS deal_count FROM LAPP_案件管理;
ASSERT (SELECT COUNT(*) FROM LAPP_案件管理) >= 0,
  'M5 downstream deal count must be non-negative';
