-- @ksql name: m5_midfail_assert
-- @ksql timeout: 120
-- @ksql dialect: 1

ASSERT (SELECT 1) = 0, 'M5 deterministic middle-node failure';
SELECT COUNT(*) AS unreachable_count FROM LAPP_顧客管理;
