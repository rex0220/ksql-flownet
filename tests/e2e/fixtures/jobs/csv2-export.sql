-- @ksql name: csv2_export
-- @ksql timeout: 1800
-- @ksql dialect: 1

CREATE TEMP TABLE #report AS
SELECT CONCAT('__CSV2_DEST_PREFIX__', test_value) AS test_key, test_value
FROM LAPP_KSQL_FLOW_TEST_CSV1
WHERE __CSV2_SOURCE_FILTER__
ORDER BY test_key;
__CSV2_AFTER_EXPORT_SELECT__
