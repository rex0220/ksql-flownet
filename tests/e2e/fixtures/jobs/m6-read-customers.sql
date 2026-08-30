-- @ksql name: m6_read_customers
-- @ksql timeout: 120
-- @ksql dialect: 1

SELECT COUNT(*) AS customer_count FROM LAPP_顧客管理;
ASSERT (SELECT COUNT(*) FROM LAPP_顧客管理) >= 0,
  'M6 customer count must be non-negative';
