-- @ksql name: m6_nonidem_sql_error
-- @ksql timeout: 120
-- @ksql dialect: 1

ASSERT (SELECT 1) = 0, 'M6 deterministic non-idempotent node failure';
SELECT COUNT(*) AS unreachable_count FROM LAPP_顧客管理;
