-- @ksql name: csv2_import
-- @ksql timeout: 1800
-- @ksql dialect: 1

IMPORT INTO LAPP_KSQL_FLOW_TEST_CSV1 (test_key, test_value)
FROM CSV source ENCODING __CSV2_IMPORT_ENCODING__
ON DUPLICATE (test_key)
ON ERROR SKIP INTO #err;
ASSERT (SELECT COUNT(*) FROM #err) = 0,
  'CSV2 import rejected one or more rows';
