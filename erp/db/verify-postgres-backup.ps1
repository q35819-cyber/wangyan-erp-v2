param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile
)

$ErrorActionPreference = 'Stop'

function Resolve-PostgresRestore {
  $fromPath = Get-Command 'pg_restore.exe' -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  if ($env:PG_BIN) {
    $candidate = Join-Path $env:PG_BIN 'pg_restore.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $portable = Join-Path $env:LOCALAPPDATA 'Programs\PostgreSQL18\bin\pg_restore.exe'
  if (Test-Path -LiteralPath $portable) { return $portable }
  throw 'pg_restore not found. Add PostgreSQL bin to PATH or set PG_BIN.'
}

$resolvedBackup = (Resolve-Path -LiteralPath $BackupFile).Path
$expectedHashFile = "$resolvedBackup.sha256"
if (-not (Test-Path -LiteralPath $expectedHashFile)) {
  throw "Checksum file not found: $expectedHashFile"
}

$expectedHash = ((Get-Content -LiteralPath $expectedHashFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$stream = [System.IO.File]::OpenRead($resolvedBackup)
try {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $actualHash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha256.Dispose() }
}
finally { $stream.Dispose() }
if ($expectedHash -ne $actualHash) { throw 'Backup checksum mismatch.' }

$pgRestore = Resolve-PostgresRestore
& $pgRestore --list $resolvedBackup | Out-Null
if ($LASTEXITCODE -ne 0) { throw "pg_restore verification failed with exit code $LASTEXITCODE" }

Write-Output "Backup verified: $resolvedBackup"
Write-Output "SHA256: $actualHash"
