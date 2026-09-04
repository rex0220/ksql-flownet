-- @ksql name: csv2_transform
-- @ksql timeout: 1800
-- @ksql dialect: 1

CREATE TEMP TABLE #transformed AS
SELECT CONCAT('__CSV2_DEST_PREFIX__', test_value) AS test_key, test_value
FROM LAPP_KSQL_FLOW_TEST_CSV1
WHERE __CSV2_SOURCE_FILTER__;
ASSERT (SELECT COUNT(*) FROM #transformed) = __CSV2_EXPECTED_ROWS__,
  'CSV2 transform source row count mismatch';
