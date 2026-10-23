# Load the shared IT-AMS database copy into your local PostgreSQL, using the settings in .env.
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File tools\restore-database.ps1
#   powershell -ExecutionPolicy Bypass -File tools\restore-database.ps1 -DumpFile "C:\path\other-copy.dump"
# Default file: database-dump\it_hams_v3.sql (in the repository). Accepts a plain .sql copy or a .dump (pg_dump -Fc).
# Re-running it replaces your local copy with the file (asks first; -Force skips the question).
param([string]$DumpFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'database-dump\it_hams_v3.sql'), [switch]$Force)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $DumpFile)) { throw "File not found: $DumpFile" }
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envFile)) { throw '.env not found. Copy .env.example to .env and fill in your PostgreSQL user/password first.' }
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } | ForEach-Object { $cfg[$Matches[1]] = $Matches[2].Trim() }

$psqlExe = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $psqlExe) { throw 'psql.exe not found under C:\Program Files\PostgreSQL. Install PostgreSQL 16 or newer first.' }
$psql = $psqlExe.FullName
$pgRestore = Join-Path $psqlExe.DirectoryName 'pg_restore.exe'
$db = $cfg['DB_NAME']
$conn = @('-h', $cfg['DB_HOST'], '-p', $cfg['DB_PORT'], '-U', $cfg['DB_USER'])
$env:PGPASSWORD = $cfg['DB_PASS']
try {
  $exists = & $psql @conn -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'"
  if ($LASTEXITCODE -ne 0) { throw "Could not connect to PostgreSQL as $($cfg['DB_USER']). Check DB_USER / DB_PASS in .env." }
  if ($exists -eq '1') {
    if (-not $Force) {
      $answer = Read-Host "Database '$db' already exists. Replace it with the shared copy? (yes/no)"
      if ($answer -ne 'yes') { 'Cancelled - nothing changed.'; return }
    }
    & $psql @conn -d postgres -c "DROP DATABASE `"$db`" WITH (FORCE)" | Out-Null
  }
  & $psql @conn -d postgres -c "CREATE DATABASE `"$db`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create database $db (DB_USER needs permission to create databases, e.g. postgres)." }

  "Loading $DumpFile into '$db' (about a minute)..."
  if ($DumpFile -like '*.sql') {
    # A copy made with a newer PostgreSQL may start with one or two lines an older version
    # doesn't know ("\restrict", "transaction_timeout"); psql reports them and carries on.
    & $psql @conn -d $db -q -o NUL -f $DumpFile
  } else {
    & $pgRestore @conn -d $db --no-owner --no-privileges $DumpFile
  }
  # Judge success by the data, not by those harmless messages.
  $count = & $psql @conn -d $db -tAc "SELECT COUNT(*) FROM assets"
  if ($LASTEXITCODE -ne 0 -or -not $count -or [int]$count -eq 0) { throw "The load did not complete (no assets found). See the messages above." }
  "Database '$db' restored: $count assets. Next: npm install, then press F5 in VS Code."
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
