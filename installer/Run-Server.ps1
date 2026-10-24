#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$DataRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot)
$data=[IO.Path]::GetFullPath($DataRoot)
$cfg=Join-Path $data 'secrets/wyerp.env'
$app=Join-Path $root 'erp'
$runtime=Join-Path $root 'runtime/node'
if(!(Test-Path -LiteralPath $cfg)){throw '缺少专属ERP环境配置'}
$env:PATH=$runtime+';'+$env:PATH
$env:WYERP_LOCAL_DATA_ROOT=$data
$env:ERP_RUNTIME_STATE_FILE=Join-Path $data 'run/runtime-supervisor.json'
$env:ERP_BACKUP_DIR=Join-Path $data 'backups'
$env:ERP_PRIVATE_OBJECT_DIR=Join-Path $data 'private-objects'
$env:ERP_LOGISTICS_TARIFF_DIR=Join-Path $data 'logistics'
# Desktop edition uses one ERP process rather than SaaS cluster nodes.
$env:ERP_CLUSTER_ENABLED='0'
$env:WYERP_STANDALONE_MODE='1'
$env:ERP_HOST='127.0.0.1'
$log=Join-Path $data 'logs/erp-service.log'
& (Join-Path $app 'start.ps1') *>> $log
exit $LASTEXITCODE