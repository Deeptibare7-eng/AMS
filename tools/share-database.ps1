# Refresh the shared database copy (database-dump\it_hams_v3.sql) from your local database, using .env.
# Teammates load it with tools\restore-database.ps1. Afterwards commit and push the file.
# The file contains company data (employees, devices): keep the repository private.
# Usage (from the project folder):  powershell -ExecutionPolicy Bypass -File tools\share-database.ps1
param([string]$OutFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'database-dump\it_hams_v3.sql'))

$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } | ForEach-Object { $cfg[$Matches[1]] = $Matches[2].Trim() }

$pgDump = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $pgDump) { throw 'pg_dump.exe not found under C:\Program Files\PostgreSQL. Is PostgreSQL installed?' }

New-Item -ItemType Directory -Force (Split-Path $OutFile -Parent) | Out-Null
$env:PGPASSWORD = $cfg['DB_PASS']
# Plain SQL so PostgreSQL 16+ can load it. Login sessions and reset tokens are left out.
& $pgDump.FullName -h $cfg['DB_HOST'] -p $cfg['DB_PORT'] -U $cfg['DB_USER'] -d $cfg['DB_NAME'] --no-owner --no-privileges `
  --exclude-table-data=sessions --exclude-table-data=password_reset_tokens -f $OutFile
Remove-Item Env:PGPASSWORD
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
"Database copy written to: $OutFile ({0:N1} MB)" -f ((Get-Item $OutFile).Length / 1MB)
'Next: git add database-dump/it_hams_v3.sql ; git commit -m "Refresh shared database copy" ; git push'
