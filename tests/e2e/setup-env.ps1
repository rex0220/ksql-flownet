# E2E環境変数セットアップ(dot-source用)。トークン値は表示しない。
foreach ($f in @("$PSScriptRoot\..\..\.env", 'C:\Users\rex02\Projects\my-ksql-jobs\.env')) {
  foreach ($line in (Get-Content $f)) {
    if ($line -match '^([A-Z][A-Z0-9_]*)=(.+)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
  }
}
foreach ($n in 'KSQL_SPIKE_TOKEN_EXEC','KSQL_SPIKE_TOKEN_AUDIT','KSQL_E2E_TOKEN_LOGS','KSQL_E2E_TOKEN_LOGS_RO','KSQL_E2E_TOKEN_REQUESTS','KSQL_E2E_TOKEN_REQUESTS_RO','KSQL_CSV1_TARGET_API_TOKEN') {
  Set-Item -Path "env:$n" -Value ([Environment]::GetEnvironmentVariable($n,'User'))
}
$env:KSQL_E2E_REQUEST_APP_ID = [Environment]::GetEnvironmentVariable('KSQL_E2E_REQUEST_APP_ID','User')
$env:KSQL_CSV1_TARGET_APP_ID = [Environment]::GetEnvironmentVariable('KSQL_CSV1_TARGET_APP_ID','User')
$env:KSQL_FLOWNET_PROFILE = 'e2e'
$env:KSQL_FLOW_BIN = 'node.exe'
$env:KSQL_FLOW_BIN_ARGS = '["C:\\Users\\rex02\\Projects\\ksql-flow\\dist\\cli.js"]'
