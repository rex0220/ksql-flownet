-- @ksql name: m6_assert_fail
-- @ksql timeout: 120
-- @ksql dialect: 1

ASSERT (SELECT 1) = 0, 'M6 deterministic middle-node failure';
SELECT COUNT(*) AS unreachable_count FROM LAPP_顧客管理;
