-- @ksql name: m5_shared_read
-- @ksql timeout: 120
-- @ksql dialect: 1

SELECT COUNT(*) AS customer_count FROM LAPP_顧客管理;
ASSERT (SELECT COUNT(*) FROM LAPP_顧客管理) >= 0,
  'M5 diamond customer count must be non-negative';
