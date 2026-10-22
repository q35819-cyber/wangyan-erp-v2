param(
  [string]$OutputDirectory = $(if ($env:ERP_BACKUP_DIR) { $env:ERP_BACKUP_DIR } elseif ([Environment]::GetEnvironmentVariable('ERP_BACKUP_DIR', 'User')) { [Environment]::GetEnvironmentVariable('ERP_BACKUP_DIR', 'User') } else { [IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $PSScriptRoot '..\..') (-join @([char]0x672C, [char]0x673A, [char]0x6570, [char]0x636E))) 'backups')) }),
  [Alias('RetentionDays')]
  [ValidateRange(0, 3650)]
  [int]$RetentionCount = 5,
  [string]$DatabaseUrl = $(if ($env:DATABASE_BACKUP_URL) { $env:DATABASE_BACKUP_URL } else { $env:DATABASE_URL })
)

$ErrorActionPreference = 'Stop'

function Resolve-PostgresTool([string]$Name) {
  $fromPath = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }

  if ($env:PG_BIN) {
    $fromEnvironment = Join-Path $env:PG_BIN "$Name.exe"
    if (Test-Path -LiteralPath $fromEnvironment) { return $fromEnvironment }
  }

  $portable = Join-Path $env:LOCALAPPDATA "Programs\PostgreSQL18\bin\$Name.exe"
  if (Test-Path -LiteralPath $portable) { return $portable }
  throw "PostgreSQL tool not found: $Name. Add PostgreSQL bin to PATH or set PG_BIN."
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $([IO.Path]::GetFileName($Executable))"
  }
}

$pgDump = Resolve-PostgresTool 'pg_dump'
$pgRestore = Resolve-PostgresTool 'pg_restore'
$backupRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$baseName = "wyerp-$timestamp"
$finalPath = Join-Path $backupRoot "$baseName.dump"
$partialPath = "$finalPath.partial"
$hashPath = "$finalPath.sha256"
$manifestPath = "$finalPath.json"
$previousPgDatabase = $env:PGDATABASE

if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }

try {
  $dumpArguments = @('--format=custom', '--compress=9', '--no-owner', '--file', $partialPath)
  if ($DatabaseUrl) {
    # Keep credentials out of the child process command line. libpq accepts a
    # connection URI through PGDATABASE.
    $env:PGDATABASE = $DatabaseUrl
  } else {
    $dumpArguments += @(
      '--host', $(if ($env:PGHOST) { $env:PGHOST } else { '127.0.0.1' }),
      '--port', $(if ($env:PGPORT) { $env:PGPORT } else { '5432' }),
      '--username', $(if ($env:PGBACKUPUSER) { $env:PGBACKUPUSER } elseif ($env:PGUSER) { $env:PGUSER } else { 'wyerp_app' }),
      '--dbname', $(if ($env:PGDATABASE) { $env:PGDATABASE } else { 'wyerp_dev' })
    )
  }

  Invoke-Checked $pgDump $dumpArguments
  & $pgRestore --list $partialPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Backup archive verification failed with exit code $LASTEXITCODE" }
  Move-Item -LiteralPath $partialPath -Destination $finalPath

  $stream = [IO.File]::OpenRead($finalPath)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
  Set-Content -LiteralPath $hashPath -Value "$hash  $([IO.Path]::GetFileName($finalPath))" -Encoding ascii
  $manifest = [ordered]@{
    format = 'postgresql-custom'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    file = [IO.Path]::GetFileName($finalPath)
    bytes = (Get-Item -LiteralPath $finalPath).Length
    sha256 = $hash
    verifiedBy = 'pg_restore --list'
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8

  & (Join-Path $PSScriptRoot 'prune-postgres-backups.ps1') -OutputDirectory $backupRoot -RetentionCount $RetentionCount

  Write-Output $finalPath
} catch {
  if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
  throw
} finally {
  $env:PGDATABASE = $previousPgDatabase
}
