#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$InstallRoot,
 [Parameter(Mandatory=$true)][string]$DataRoot
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot)
$data=[IO.Path]::GetFullPath($DataRoot)
if($data.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw '现有数据目录不可位于程序安装目录内'}
$settingsFile=Join-Path $data 'install-settings.json'
$pgdata=Join-Path $data 'runtime/postgresql'
$envfile=Join-Path $data 'secrets/wyerp.env'
$required=@($settingsFile,$envfile,(Join-Path $pgdata 'PG_VERSION'),(Join-Path $data 'secrets/credentials.key'),(Join-Path $root 'WyerpERP-Service.exe'),(Join-Path $root 'runtime/node/node.exe'),(Join-Path $root 'runtime/postgresql/bin/pg_ctl.exe'),(Join-Path $root 'erp/db/migrate.js'))
foreach($f in $required){if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw ('恢复必要文件缺失，未修改用户数据：'+$f)}}
$settings=Get-Content -LiteralPath $settingsFile -Encoding UTF8 -Raw | ConvertFrom-Json
if([IO.Path]::GetFullPath([string]$settings.InstallRoot).TrimEnd('\') -ine $root.TrimEnd('\')){throw '记录的原安装目录与目标目录不一致；拒绝接管其他ERP数据'}
if([string]$settings.DbName -ne 'wyerp_community_local'){throw '数据库标识不匹配'}
$service=[string]$settings.ServiceName
$appService=[string]$settings.AppServiceName
if($service -notmatch '^WyerpCommunityPG[A-Za-z0-9]*$' -or $appService -ne $service.Replace('WyerpCommunityPG','WyerpCommunityERP')){throw '本实例Windows服务标识不一致'}
if([int]$settings.AppPort -lt 1024 -or [int]$settings.AppPort -gt 65535 -or [int]$settings.PgPort -lt 1024 -or [int]$settings.PgPort -gt 65535){throw '历史端口无效'}
if((Get-Content -LiteralPath (Join-Path $pgdata 'PG_VERSION') -Encoding ASCII -Raw).Trim() -ne '17'){throw '不是支持的PostgreSQL17，拒绝自动恢复'}
if(Get-Service $service -ErrorAction SilentlyContinue){throw '原PostgreSQL服务仍存在，不属于卸载后恢复；拒绝重复注册'}
if(Get-Service $appService -ErrorAction SilentlyContinue){throw '原ERP服务仍存在，拒绝接管'}
$portList=@([int]$settings.AppPort,[int]$settings.PgPort)
if($settings.ClusterBasePort){
 $portList+=@(0..4|ForEach-Object{[int]$settings.ClusterBasePort+$_})
}
foreach($port in $portList){
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,[int]$port)
 try{$listener.Start()}catch{throw ('原端口被其他进程占用，不修改历史数据或抢占端口：'+$port)}finally{$listener.Stop()}
}
$originalEnv=[IO.File]::ReadAllText($envfile,[Text.UTF8Encoding]::new($false))
if($originalEnv -notmatch '(?m)^PGHOST=127\.0\.0\.1\r?$' -or $originalEnv -notmatch ('(?m)^PGPORT='+[int]$settings.PgPort+'\r?$')){throw '历史数据库配置与元数据不一致'}
if($originalEnv -notmatch ('(?m)^ERP_PORT='+[int]$settings.AppPort+'\r?$')){throw '历史ERP端口与元数据不一致'}
$pgConfig=Join-Path $pgdata 'postgresql.conf'
if((Get-Content -LiteralPath $pgConfig -Encoding UTF8 -Raw) -notmatch ('(?m)^\s*port\s*=\s*'+[int]$settings.PgPort+'\s*$')){throw '现有PG配置端口与元数据不一致'}
& (Join-Path $root 'installer/Configure-CollectorPort.ps1') -PluginDir (Join-Path $root 'collector/wyerp-collector') -AppPort ([int]$settings.AppPort)
if(!$?){throw '现有实例浏览器插件端口匹配失败'}
$pgCtl=Join-Path $root 'runtime/postgresql/bin/pg_ctl.exe'
$pgCreated=$false
$appCreated=$false
$started=$false
try {
 & $pgCtl register -N $service -D $pgdata -S demand -o ('-h 127.0.0.1 -p '+[int]$settings.PgPort) 2>&1 |Select-Object -Last 5
 if($LASTEXITCODE -ne 0){throw '无法重新注册原实例PostgreSQL服务'}
 $pgCreated=$true
 $appExe=Join-Path $root 'WyerpERP-Service.exe'
 $cmd='"'+$appExe+'" --install-root "'+$root+'" --data-root "'+$data+'" --service-name "'+$appService+'"'
 & sc.exe create $appService 'binPath=' $cmd 'start=' 'demand' 'DisplayName=' 'Wyerp ERP Local Backend' 2>&1|Select-Object -Last 5
 if($LASTEXITCODE -ne 0){throw '无法重新注册原实例ERP管理服务'}
 $appCreated=$true
 Start-Service -Name $service -ErrorAction Stop
 $started=$true
 & (Join-Path $root 'installer/Test-Installed.ps1') -InstallRoot $root -DataRoot $data -CheckDatabase 2>&1|Select-Object -Last 8
 if(!$?){throw '恢复后真实数据库自检失败，不允许跳过'}
 Stop-Service -Name $service -ErrorAction Stop
 $started=$false
 Write-Output ('PASS 恢复原数据：没有重置管理员、密钥、端口和PostgreSQL用户数据库；保留原集群实例 '+$service)
}catch{
 if($started){Stop-Service -Name $service -ErrorAction SilentlyContinue}
 if($appCreated){& sc.exe delete $appService 2>&1|Out-Null}
 if($pgCreated){& sc.exe delete $service 2>&1|Out-Null}
 throw
}