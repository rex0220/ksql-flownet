-- @ksql name: m8_brake_fail
-- @ksql timeout: 120
-- @ksql dialect: 1

ASSERT (SELECT 1) = 0, 'M8 deterministic retry-brake failure';
SELECT COUNT(*) AS unreachable_count FROM LAPP_顧客管理;
