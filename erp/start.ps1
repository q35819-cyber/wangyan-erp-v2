$ErrorActionPreference = 'Stop'

$localDataName = -join ([char[]](0x672C, 0x673A, 0x6570, 0x636E))
$configName = -join ([char[]](0x914D, 0x7F6E))
$projectRoot = Split-Path -Parent $PSScriptRoot
$configuredDataRoot = if ($env:WYERP_LOCAL_DATA_ROOT) {
    $env:WYERP_LOCAL_DATA_ROOT
} else {
    [Environment]::GetEnvironmentVariable('WYERP_LOCAL_DATA_ROOT', 'User')
}
$localData = if ($configuredDataRoot) { [IO.Path]::GetFullPath($configuredDataRoot) } else { Join-Path $projectRoot $localDataName }
# An explicit data root must not silently create a fresh configuration or database.
# A legacy machine may already keep its active .env/keys in 本机数据/配置.
$legacyConfigDir = Join-Path $localData $configName
$externalConfigDir = Join-Path $localData 'secrets'
# A managed beta launcher pins the exact directory used by the pre-existing ERP.
$forcedConfigDir = $env:WYERP_CONFIG_DIR
if ($forcedConfigDir) {
    $configCandidate = [IO.Path]::GetFullPath($forcedConfigDir)
    if ($configCandidate -ine [IO.Path]::GetFullPath($legacyConfigDir) -and
        $configCandidate -ine [IO.Path]::GetFullPath($externalConfigDir)) {
        throw 'ERP config override must use the legacy config or secrets directory inside the verified data root.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $configCandidate 'wyerp.env') -PathType Leaf)) {
        throw 'The selected ERP config directory has no existing wyerp.env; refusing to start.'
    }
    $configDir = $configCandidate
} elseif ($configuredDataRoot) {
    if (Test-Path -LiteralPath (Join-Path $externalConfigDir 'wyerp.env') -PathType Leaf) {
        $configDir = $externalConfigDir
    } elseif (Test-Path -LiteralPath (Join-Path $legacyConfigDir 'wyerp.env') -PathType Leaf) {
        $configDir = $legacyConfigDir
    } else {
        throw 'Explicit ERP data root has no existing wyerp.env in secrets or legacy config directory; refusing to start with empty credentials.'
    }
} else {
    $configDir = $legacyConfigDir
}
$envFile = Join-Path $configDir 'wyerp.env'

$env:ERP_CREDENTIALS_KEY_FILE = Join-Path $configDir 'credentials.key'
$env:ERP_CSRF_SECRET_FILE = Join-Path $configDir 'csrf.key'
if (-not $env:ERP_BACKUP_DIR) {
    $persistedBackupRoot = [Environment]::GetEnvironmentVariable('ERP_BACKUP_DIR', 'User')
    $env:ERP_BACKUP_DIR = if ($persistedBackupRoot) { [IO.Path]::GetFullPath($persistedBackupRoot) } else { Join-Path $localData 'backups' }
}
if (-not $env:ERP_LOGISTICS_TARIFF_DIR) {
    $persistedLogisticsRoot = [Environment]::GetEnvironmentVariable('ERP_LOGISTICS_TARIFF_DIR', 'User')
    $env:ERP_LOGISTICS_TARIFF_DIR = if ($persistedLogisticsRoot) { [IO.Path]::GetFullPath($persistedLogisticsRoot) } else { Join-Path $localData (-join ([char[]](0x7269, 0x6D41, 0x539F, 0x8868))) }
}
if (-not $env:ERP_PRIVATE_OBJECT_DIR) {
    $persistedObjectRoot = [Environment]::GetEnvironmentVariable('ERP_PRIVATE_OBJECT_DIR', 'User')
    $env:ERP_PRIVATE_OBJECT_DIR = if ($persistedObjectRoot) { [IO.Path]::GetFullPath($persistedObjectRoot) } else { Join-Path $localData 'private-objects' }
}
if (-not $env:ERP_PRIVATE_OBJECT_KEY_FILE) {
    $env:ERP_PRIVATE_OBJECT_KEY_FILE = Join-Path $configDir 'private-object.key'
}
if (-not $env:ERP_RUNTIME_STATE_FILE) {
    $runtimeRoot = Join-Path $env:LOCALAPPDATA 'WyerpERP'
    $env:ERP_RUNTIME_STATE_FILE = Join-Path $runtimeRoot 'runtime-supervisor.json'
}

Set-Location $PSScriptRoot
$migrationScript = Join-Path $PSScriptRoot 'db\migrate.js'
$serverScript = if ($env:ERP_CLUSTER_ENABLED -eq '1') {
    Join-Path $PSScriptRoot 'cluster.js'
} else {
    Join-Path $PSScriptRoot 'server.js'
}
$supervisorScript = Join-Path $PSScriptRoot 'auth\runtime-supervisor.js'

& node "--env-file-if-exists=$envFile" $migrationScript '--check'
if ($LASTEXITCODE -ne 0) {
    Write-Error '数据库结构尚未同步到当前代码版本。请先创建并校验数据库备份，再执行 node db/migrate.js；本次不会启动 ERP 服务。'
    exit $LASTEXITCODE
}

& node "--env-file-if-exists=$envFile" $supervisorScript $serverScript
exit $LASTEXITCODE
