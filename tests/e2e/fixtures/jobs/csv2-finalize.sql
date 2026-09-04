-- @ksql name: csv2_finalize
-- @ksql timeout: 300
-- @ksql dialect: 1

-- 受入17用のゲート: マーカー行が投入されるまで失敗し、Run全体をFAILEDに保つ。
-- export_csvはSUCCESS済み(成果物あり)の状態で --rerun-from export_csv を検証する。
ASSERT (
  SELECT COUNT(*) FROM LAPP_KSQL_FLOW_TEST_CSV1
  WHERE test_key = '__CSV2_MARKER_KEY__'
) = 1, 'CSV2 finalize marker missing';
