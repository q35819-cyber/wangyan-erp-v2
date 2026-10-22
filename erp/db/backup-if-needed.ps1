param([switch]$Force)
$ErrorActionPreference = 'Stop'
$localName = -join @([char]0x672C, [char]0x673A, [char]0x6570, [char]0x636E)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$persistedBackupDir = [Environment]::GetEnvironmentVariable('ERP_BACKUP_DIR', 'User')
$backupDir = if ($env:ERP_BACKUP_DIR) { $env:ERP_BACKUP_DIR } elseif ($persistedBackupDir) { $persistedBackupDir } else { Join-Path (Join-Path $projectRoot $localName) 'backups' }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$logDir = Join-Path $backupDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("daily-backup-{0}.log" -f (Get-Date).ToString('yyyy-MM'))
$replicaDir = if ($env:ERP_BACKUP_REPLICA_DIR) { [IO.Path]::GetFullPath($env:ERP_BACKUP_REPLICA_DIR) } else { '' }
$replicaClass = if ($env:ERP_BACKUP_REPLICA_CLASS) { [string]$env:ERP_BACKUP_REPLICA_CLASS } else { '' }
$productionMode = [string]$env:NODE_ENV -eq 'production'
if ($productionMode -and [string]::IsNullOrWhiteSpace($replicaDir)) { throw 'Production daily backup requires ERP_BACKUP_REPLICA_DIR.' }
if ($productionMode -and [string]::IsNullOrWhiteSpace($replicaClass)) { throw 'Production daily backup requires ERP_BACKUP_REPLICA_CLASS.' }
if (-not [string]::IsNullOrWhiteSpace($replicaClass) -and $replicaClass -notin @('remote-machine','remote-account','offline-media')) { throw 'ERP_BACKUP_REPLICA_CLASS must be remote-machine, remote-account or offline-media.' }

function Write-BackupLog([string]$Level, [string]$Message) {
  $singleLine = ($Message -replace '[\r\n]+', ' ').Trim()
  $entry = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK'), $Level, $singleLine
  Add-Content -LiteralPath $logPath -Value $entry -Encoding UTF8
}

function Write-BackupOutput([object[]]$OutputLines) {
  foreach ($outputLine in $OutputLines) {
    Write-Output $outputLine
    if ($outputLine -is [string] -and $outputLine -match '^Deleted old complete backup: (.+)$') {
      Write-BackupLog 'INFO' ("PRUNE backup={0}" -f $Matches[1])
    }
  }
}

function Sync-BackupReplica {
  if ([string]::IsNullOrWhiteSpace($replicaDir)) { return }
  if ([string]::IsNullOrWhiteSpace($replicaClass)) { throw 'ERP_BACKUP_REPLICA_CLASS is required when ERP_BACKUP_REPLICA_DIR is configured.' }
  $evidencePath = Join-Path $logDir 'latest-replica-evidence.json'
  $replicaOutput = @(& (Join-Path $PSScriptRoot 'sync-backup-replica.ps1') -SourceDirectory $backupDir -ReplicaDirectory $replicaDir -StorageClass $replicaClass -EvidenceFile $evidencePath)
  if ($LASTEXITCODE -ne 0) { throw "Backup replica sync returned exit code $LASTEXITCODE." }
  foreach ($line in $replicaOutput) { Write-Output $line }
  Write-BackupLog 'INFO' ("REPLICA storageClass={0} directory={1}" -f $replicaClass, $replicaDir)
}

Write-BackupLog 'INFO' ("START force={0} backupDir={1}" -f $Force.IsPresent, $backupDir)
$barrierScript = Join-Path $PSScriptRoot 'client-order-backup-barrier.js'
$backupGenerationId = $null
try {
  $retentionOutput = @(& (Join-Path $PSScriptRoot 'prune-postgres-backups.ps1') -OutputDirectory $backupDir -RetentionCount 5)
  Write-BackupOutput $retentionOutput
}
catch {
  Write-BackupLog 'ERROR' $_.Exception.Message
  Write-Error -ErrorRecord $_ -ErrorAction Continue
  exit 1
}

$today = (Get-Date).Date
$validToday = Get-ChildItem -LiteralPath $backupDir -Filter 'wyerp-*.dump' -File -ErrorAction SilentlyContinue | Where-Object {
  $_.LastWriteTime.Date -eq $today -and (Test-Path -LiteralPath ($_.FullName + '.sha256')) -and (Test-Path -LiteralPath ($_.FullName + '.json'))
} | Sort-Object Name -Descending | Select-Object -First 1
$manifestedCount = 0
$barrierAvailable = $false
$dailyCycle = $null
try {
  $barrierStatus = (& node $barrierScript status | ConvertFrom-Json)
  if ($LASTEXITCODE -eq 0) {
    $barrierAvailable = $true
    $dailyCycle = $barrierStatus.dailyCycle
    $manifestedRow = $barrierStatus.states | Where-Object { $_.state -eq 'manifested' } | Select-Object -First 1
    if ($manifestedRow) { $manifestedCount = [int]$manifestedRow.count }
  }
} catch { Write-BackupLog 'WARN' ("ORDER_SYNC BARRIER_STATUS_FAILED reason={0}" -f $_.Exception.Message) }
if ($validToday -and -not $Force -and $manifestedCount -eq 0 -and (-not $dailyCycle -or $dailyCycle.status -eq 'backed_up')) {
  try {
    Sync-BackupReplica
    $message = "Today's backup already exists: $($validToday.FullName)"
    Write-BackupLog 'INFO' ("SKIP backup={0}" -f $validToday.Name)
    Write-Output $message
    exit 0
  } catch {
    Write-BackupLog 'ERROR' $_.Exception.Message
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
  }
}
$lockPath = Join-Path $backupDir '.daily-backup.lock'
$lock = $null
$exitCode = 0
try {
  $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  if ($barrierAvailable) {
    while ($dailyCycle -and $dailyCycle.should_wait) {
      $waitUntil = [DateTimeOffset]::Parse([string]$dailyCycle.cutoff_at).ToUniversalTime()
      Write-BackupLog 'INFO' ("ORDER_SYNC WAIT cycle={0} ready={1}/{2} cutoffUtc={3}" -f $dailyCycle.cycle_id, $dailyCycle.snapshot_ready_count, $dailyCycle.participant_count, $waitUntil.ToString('o'))
      $remainingSeconds = [Math]::Max(1, [Math]::Ceiling(($waitUntil - [DateTimeOffset]::UtcNow).TotalSeconds))
      Start-Sleep -Seconds ([Math]::Min(30, $remainingSeconds))
      $barrierStatus = (& node $barrierScript status | ConvertFrom-Json)
      if ($LASTEXITCODE -ne 0) { throw 'Unable to refresh the client order daily cycle.' }
      $dailyCycle = $barrierStatus.dailyCycle
    }
    $barrierStart = (& node $barrierScript begin | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0 -or -not $barrierStart.generationId) { throw 'Unable to create the server backup generation.' }
    $backupGenerationId = [long]$barrierStart.generationId
    Write-BackupLog 'INFO' ("ORDER_SYNC BARRIER_BEGIN generation={0} incompleteSync={1}" -f $backupGenerationId, $barrierStart.incompleteSyncCount)
  } else {
    Write-BackupLog 'WARN' 'ORDER_SYNC BARRIER_UNAVAILABLE backup continues without releasing client manifests'
  }
  $backupOutput = @(& (Join-Path $PSScriptRoot 'backup-postgres.ps1') -OutputDirectory $backupDir)
  if ($LASTEXITCODE -ne 0) {
    throw "Backup command returned exit code $LASTEXITCODE."
  }
  Write-BackupOutput $backupOutput
  $createdBackup = $backupOutput | Where-Object { $_ -is [string] -and $_ -match '\.dump$' } | Select-Object -Last 1
  $createdName = if ($createdBackup) { [IO.Path]::GetFileName($createdBackup) } else { '(output unavailable)' }
  if (-not $createdBackup) { throw 'Backup output did not contain the dump path.' }
  $hashLine = (Get-Content -LiteralPath ($createdBackup + '.sha256') -Raw -Encoding ascii).Trim()
  if ($hashLine -notmatch '^([a-f0-9]{64})\s') { throw 'Backup SHA-256 evidence is invalid.' }
  Sync-BackupReplica
  if ($backupGenerationId) {
    $barrierComplete = (& node $barrierScript complete $backupGenerationId $createdName $Matches[1] | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to complete the server backup generation.' }
    Write-BackupLog 'INFO' ("ORDER_SYNC BARRIER_COMPLETE generation={0} releasedRuns={1}" -f $backupGenerationId, $barrierComplete.releasedRuns)
  }
  Write-BackupLog 'INFO' ("SUCCESS backup={0}" -f $createdName)
}
catch {
  $exitCode = 1
  if ($backupGenerationId) { & node $barrierScript fail $backupGenerationId 'backup_failed' | Out-Null }
  Write-BackupLog 'ERROR' $_.Exception.Message
  Write-Error -ErrorRecord $_ -ErrorAction Continue
}
finally {
  if ($lock) { $lock.Dispose() }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $exitCode
