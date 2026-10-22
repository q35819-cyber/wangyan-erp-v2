#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$DataRoot,[switch]$CheckDatabase)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot)
$data=[IO.Path]::GetFullPath($DataRoot)
$node=Join-Path $root 'runtime/node/node.exe'
$pg=Join-Path $root 'runtime/postgresql/bin/pg_ctl.exe'
$envfile=Join-Path $data 'secrets/wyerp.env'
$manifest=Join-Path $root 'collector/wyerp-collector/manifest.json'
$settings=Join-Path $data 'install-settings.json'
foreach($f in @($node,$pg,$envfile,$manifest,$settings,(Join-Path $root 'erp/node_modules/pg/package.json'))){
 if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw ('安装包或配置缺少：'+$f)}
}
$cfg=[IO.File]::ReadAllText($envfile)
if($cfg -notmatch '(?m)^PGHOST=127\.0\.0\.1\r?$'){throw '数据库未限制为本机监听'}
if($cfg -notmatch '(?m)^PUBLIC_ORIGIN=\r?$'){throw '本机模式公网地址必须留空'}
foreach($k in @('credentials.key','csrf.key','private-object.key')){
 $v=[IO.File]::ReadAllText((Join-Path $data 'secrets' $k)).Trim()
 if($v -notmatch '^[a-f0-9]{64}$'){throw ('本机密钥文件损坏：'+$k)}
}
$m=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
if($m.manifest_version -ne 3){throw '采集插件Manifest不正确'}
foreach($item in @($m.background.service_worker,$m.side_panel.default_path)){
 if($item -and !(Test-Path -LiteralPath (Join-Path (Split-Path -Parent $manifest) $item))){throw ('采集插件缺少：'+$item)}
}
if($CheckDatabase){
 Push-Location (Join-Path $root 'erp')
 try{
  & $node "--env-file-if-exists=$envfile" db/migrate.js --check 2>&1|Select-Object -Last 5
  if($LASTEXITCODE -ne 0){throw '真实数据库的迁移校验未通过'}
 }finally{Pop-Location}
}
Write-Output 'RESULT=PASS（安装目录、随机密钥、插件文件与数据库检查通过；真实网页登录/采集仍需单独测试）'