param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [ValidateRange(0, 3650)]
  [int]$RetentionCount = 5,
  [string]$MigrationWorkDirectory = ''
)

$ErrorActionPreference = 'Stop'
$scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($scriptPath)) { throw 'Cannot resolve backup retention script path.' }
$scriptDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($scriptPath))
$projectRoot = [IO.Path]::GetFullPath((Join-Path $scriptDirectory '..\..'))
$localDataDirectoryName = -join @([char]0x672C, [char]0x673A, [char]0x6570, [char]0x636E)
$projectMigrationWorkDirectory = [IO.Path]::GetFullPath((Join-Path (Join-Path $projectRoot $localDataDirectoryName) 'migration-p2'))
$configuredMigrationWorkDirectory = if (-not [string]::IsNullOrWhiteSpace($MigrationWorkDirectory)) {
  $MigrationWorkDirectory
} elseif ($env:ERP_MIGRATION_WORK_DIR) {
  $env:ERP_MIGRATION_WORK_DIR
} else {
  ''
}
$normalizedBackupRoot = [IO.Path]::GetFullPath($OutputDirectory)
if ($normalizedBackupRoot -eq [IO.Path]::GetPathRoot($normalizedBackupRoot)) {
  throw "Refusing to manage backups at a filesystem root: $normalizedBackupRoot"
}
$backupRoot = $normalizedBackupRoot.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))

function Get-ProtectedBackupNames([string]$MigrationRoot) {
  $protected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  if ([string]::IsNullOrWhiteSpace($MigrationRoot)) { return $protected }

  $resolvedMigrationRoot = [IO.Path]::GetFullPath($MigrationRoot)
  if (-not (Test-Path -LiteralPath $resolvedMigrationRoot -PathType Container)) { return $protected }

  $manifestFiles = @(
    Get-ChildItem -LiteralPath $resolvedMigrationRoot -Directory -Filter 'archive-*' |
      ForEach-Object { Join-Path $_.FullName 'backup-manifest.json' } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  )

  foreach ($manifestPath in $manifestFiles) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop
      if ($manifest.readOnly -ne $true) { continue }

      $runGuid = [Guid]::Empty
      if (-not [Guid]::TryParse([string]$manifest.runId, [ref]$runGuid)) {
        throw 'runId is not a UUID'
      }

      $expiresAt = [DateTimeOffset]::MinValue
      if (-not [DateTimeOffset]::TryParse([string]$manifest.expiresAt, [ref]$expiresAt)) {
        throw 'expiresAt is invalid'
      }
      if ($expiresAt -lt [DateTimeOffset]::UtcNow) { continue }

      foreach ($entry in @($manifest.files)) {
        if ([string]$entry.root -ne 'database') { continue }
        $relativePath = [string]$entry.relativePath
        $name = [IO.Path]::GetFileName($relativePath)
        if ($name -ne $relativePath -or $name -notmatch '^wyerp-\d{8}T\d{6}Z\.dump$') {
          throw "database backup path is not a canonical backup filename: $relativePath"
        }
        [void]$protected.Add($name)
      }
    } catch {
      throw "Cannot safely evaluate migration backup protection manifest '$manifestPath': $($_.Exception.Message)"
    }
  }

  return $protected
}

if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) {
  throw "Backup directory not found: $backupRoot"
}

if ($RetentionCount -eq 0) {
  Write-Output 'Backup retention disabled; no files deleted.'
  return
}

$completeBackups = @(
  Get-ChildItem -LiteralPath $backupRoot -Filter 'wyerp-*.dump' -File |
    Where-Object { $_.Name -match '^wyerp-\d{8}T\d{6}Z\.dump$' } |
    ForEach-Object {
      $hashPath = $_.FullName + '.sha256'
      $manifestPath = $_.FullName + '.json'
      if ((Test-Path -LiteralPath $hashPath -PathType Leaf) -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        [pscustomobject]@{
          Name = $_.Name
          DumpPath = $_.FullName
          HashPath = $hashPath
          ManifestPath = $manifestPath
        }
      }
    } |
    Sort-Object Name -Descending
)

$protectionRoots = @($projectMigrationWorkDirectory)
if (-not [string]::IsNullOrWhiteSpace($configuredMigrationWorkDirectory)) {
  $configuredRoot = [IO.Path]::GetFullPath($configuredMigrationWorkDirectory)
  if ($protectionRoots -notcontains $configuredRoot) { $protectionRoots += $configuredRoot }
}
$protectedBackupNames = @(
  foreach ($root in $protectionRoots) { Get-ProtectedBackupNames $root }
) | Sort-Object -Unique
$protectedExisting = @($completeBackups | Where-Object { $protectedBackupNames -contains $_.Name })
$unprotectedBackups = @($completeBackups | Where-Object { $protectedBackupNames -notcontains $_.Name })

if ($unprotectedBackups.Count -le $RetentionCount) {
  Write-Output ("Retention check: {0} ordinary complete backup(s), {1} migration-protected backup(s); no ordinary deletion because the count does not exceed {2}." -f $unprotectedBackups.Count, $protectedExisting.Count, $RetentionCount)
  return
}

$expiredBackups = @($unprotectedBackups | Select-Object -Skip $RetentionCount)
foreach ($backup in $expiredBackups) {
  if ($protectedBackupNames -contains $backup.Name) {
    throw "Refusing to delete migration-protected backup: $($backup.Name)"
  }
  foreach ($path in @($backup.ManifestPath, $backup.HashPath, $backup.DumpPath)) {
    $resolvedPath = [IO.Path]::GetFullPath($path)
    if ([IO.Path]::GetDirectoryName($resolvedPath) -ne $backupRoot) {
      throw "Refusing to delete a backup file outside the configured directory: $resolvedPath"
    }
    Remove-Item -LiteralPath $resolvedPath -Force
  }
  Write-Output ("Deleted old complete backup: {0}" -f $backup.Name)
}

Write-Output ("Retention complete: kept the newest {0} ordinary complete backup(s) plus {1} migration-protected backup(s); deleted {2}." -f $RetentionCount, $protectedExisting.Count, $expiredBackups.Count)
