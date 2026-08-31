-- @ksql name: m7_rerun_fail
-- @ksql timeout: 120
-- @ksql dialect: 1

ASSERT (SELECT 1) = 0, 'M7 deterministic rerun failure';
SELECT COUNT(*) AS unreachable_count FROM LAPP_顧客管理;
