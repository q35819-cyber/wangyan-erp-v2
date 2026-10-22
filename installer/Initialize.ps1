#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$InstallRoot,
 [Parameter(Mandatory=$true)][string]$DataRoot,
 [string]$ServiceName='WyerpCommunityPG',
 [int]$AppPort=0,
 [int]$PgPort=0
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot)
$data=[IO.Path]::GetFullPath($DataRoot)
if($data.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw '业务数据必须位于软件安装目录之外'}
if(Test-Path -LiteralPath $data){throw '检测到已有数据目录，首次初始化拒绝覆盖。请使用现有管理器启动或核查旧数据'}
if($ServiceName -notmatch '^WyerpCommunityPG[A-Za-z0-9]*$'){throw '数据库服务名称不符合独立实例要求'}
if(Get-Service -Name $ServiceName -ErrorAction SilentlyContinue){throw '已有同名数据库服务，拒绝接管'}
$node=Join-Path $root 'runtime/node/node.exe'
$pgbin=Join-Path $root 'runtime/postgresql/bin'
$app=Join-Path $root 'erp'
foreach($required in @($node,(Join-Path $pgbin 'initdb.exe'),(Join-Path $pgbin 'pg_ctl.exe'),(Join-Path $pgbin 'psql.exe'),(Join-Path $app 'db/migrate.js'),(Join-Path $app 'scripts/setup-local.ps1'))){
 if(!(Test-Path -LiteralPath $required -PathType Leaf)){throw ('安装包缺少依赖文件：'+$required)}
}
function Test-FreePort([int]$number) {
 $client=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$number)
 try { $client.Start(); return $true }
 catch { return $false }
 finally { $client.Stop() }
}
function Choose-Port([int]$requested,[int]$start,[int]$last){
 if($requested){
  if($requested -lt 1024 -or $requested -gt 65535 -or !(Test-FreePort $requested)){throw ('端口不可用：'+$requested)}
  return $requested
 }
 for($i=$start;$i -le $last;$i++){if(Test-FreePort $i){return $i}}
 throw ('没有空闲端口：'+$start+'-'+$last)
}
if($AppPort -and $PgPort -and $AppPort -eq $PgPort){throw 'ERP端口和PG端口不能重复'}
$AppPort=Choose-Port $AppPort 8765 8799
$PgPort=Choose-Port $PgPort 55441 55499
if($AppPort -eq $PgPort){throw '端口选择冲突'}
$clusterBase=0
for($base=28765;$base -le 28980;$base+=5){
 $check=@($base,($base+1),($base+2),($base+3),($base+4))
 if($check -contains $AppPort -or $check -contains $PgPort){continue}
 if(@($check|Where-Object{(-not (Test-FreePort $_))}).Count -eq 0){$clusterBase=$base;break}
}
if($clusterBase -eq 0){throw '没有可用的独立集群端口区间'}
Write-Output ('检查通过：ERP端口 '+$AppPort+'；数据库端口 '+$PgPort)
$appPw=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
$migPw=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
$superPw=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
$env:WYERP_SETUP_APP_PASSWORD=$appPw
$env:WYERP_SETUP_MIGRATION_PASSWORD=$migPw
$tempSql=$null
$serviceCreated=$false
try{
 & (Join-Path $app 'scripts/setup-local.ps1') -DataRoot $data -PgHostName '127.0.0.1' -PgPort $PgPort -PgDatabase 'wyerp_community_local' -PasswordFromEnvironment
 if($LASTEXITCODE -ne 0){throw '私有数据目录初始化失败'}
 $envfile=Join-Path $data 'secrets/wyerp.env'
 $envText=[IO.File]::ReadAllText($envfile)
 if(!$envText.Contains('ERP_PORT=8765')){throw '未找到默认ERP端口，拒绝静默覆盖配置'}
 $envText=$envText.Replace('ERP_PORT=8765','ERP_PORT='+$AppPort)
$envText+=[Environment]::NewLine+'ERP_CLUSTER_BASE_PORT='+$clusterBase+[Environment]::NewLine
 if($envText -notmatch '(?m)^PUBLIC_ORIGIN=\r?$'){throw '本机PUBLIC_ORIGIN配置必须留空'}
 [IO.File]::WriteAllText($envfile,$envText,[Text.UTF8Encoding]::new($false))
 & (Join-Path $root 'installer/Configure-CollectorPort.ps1') -PluginDir (Join-Path $root 'collector/wyerp-collector') -AppPort $AppPort
 if($LASTEXITCODE -ne 0){throw '采集插件端口配置失败，拒绝继续安装'}
 foreach($sub in @('run','logs','runtime')){New-Item -ItemType Directory -Path (Join-Path $data $sub) -Force|Out-Null}
 $pgdata=Join-Path $data 'runtime/postgresql'
 $superfile=Join-Path $data 'secrets/pg-superuser.pass'
 [IO.File]::WriteAllText($superfile,$superPw+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 & (Join-Path $pgbin 'initdb.exe') -D $pgdata -U postgres --encoding=UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=trust "--pwfile=$superfile" 2>&1|Select-Object -Last 9
 if($LASTEXITCODE -ne 0){throw '新PostgreSQL集群初始化失败'}
 $cfg=Join-Path $pgdata 'postgresql.conf'
 [IO.File]::AppendAllText($cfg,[Environment]::NewLine+"listen_addresses = '127.0.0.1'"+[Environment]::NewLine+"port = $PgPort"+[Environment]::NewLine+"max_connections = 20"+[Environment]::NewLine+"shared_buffers = 64MB"+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 & (Join-Path $pgbin 'pg_ctl.exe') register -N $ServiceName -D $pgdata -S demand -o ('-h 127.0.0.1 -p '+$PgPort) 2>&1|Select-Object -Last 5
 if($LASTEXITCODE -ne 0){throw '测试专属数据库服务注册失败'}
 $serviceCreated=$true
 Start-Service -Name $ServiceName -ErrorAction Stop
 $tempSql=Join-Path $data 'secrets/role-setup-once.sql'
 $sql=@(
 "CREATE ROLE wyerp_community_migrator LOGIN PASSWORD '$migPw';",
 "CREATE ROLE wyerp_community_app LOGIN PASSWORD '$appPw';",
 'CREATE ROLE wyerp_app NOLOGIN;',
 'CREATE ROLE wyerp_migrator NOLOGIN;',
 'GRANT wyerp_app TO wyerp_community_app;',
 'GRANT wyerp_migrator TO wyerp_community_migrator;',
 'CREATE DATABASE wyerp_community_local OWNER wyerp_community_migrator;',
 'GRANT CONNECT ON DATABASE wyerp_community_local TO wyerp_community_app;',
 '\connect wyerp_community_local',
 'GRANT USAGE ON SCHEMA public TO wyerp_community_app;',
 'ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_community_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wyerp_community_app;',
 'ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_community_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO wyerp_community_app;'
 )
 [IO.File]::WriteAllLines($tempSql,$sql,[Text.UTF8Encoding]::new($false))
 $env:PGPASSWORD=$superPw
 & (Join-Path $pgbin 'psql.exe') -X -q -h 127.0.0.1 -p $PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -f $tempSql 2>&1|Select-Object -Last 10
 if($LASTEXITCODE -ne 0){throw '创建隔离数据库和角色失败'}
 Remove-Item -LiteralPath $tempSql -Force
 $tempSql=$null
 Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
 Push-Location $app
 try{
  & $node "--env-file-if-exists=$envfile" db/migrate.js 2>&1|Select-Object -Last 8
  if($LASTEXITCODE -ne 0){throw '数据库迁移失败'}
  & $node "--env-file-if-exists=$envfile" db/migrate.js --check 2>&1|Select-Object -Last 5
  if($LASTEXITCODE -ne 0){throw '数据库迁移后校验失败'}
 }finally{Pop-Location}
 $env:PATH=(Join-Path $root 'runtime/node')+';'+$env:PATH
 & (Join-Path $app 'scripts/bootstrap-admin.ps1') -DataRoot $data
 if($LASTEXITCODE -ne 0){throw '唯一管理员创建失败'}
 $appServiceName=$ServiceName.Replace('WyerpCommunityPG','WyerpCommunityERP')
 if(Get-Service -Name $appServiceName -ErrorAction SilentlyContinue){throw '已有同名ERP服务，拒绝接管'}
 $svcExe=Join-Path $root 'WyerpERP-Service.exe'
 if(!(Test-Path -LiteralPath $svcExe -PathType Leaf)){throw '安装包缺少ERP Windows服务程序'}
 $command='"'+$svcExe+'" --install-root "'+$root+'" --data-root "'+$data+'" --service-name "'+$appServiceName+'"'
 & sc.exe create $appServiceName 'binPath=' $command 'start=' 'demand' 'DisplayName=' 'Wyerp ERP Local Backend' 2>&1|Select-Object -Last 5
 if($LASTEXITCODE -ne 0){throw '注册独立ERP服务失败'}
 $settings=[ordered]@{AppPort=$AppPort;PgPort=$PgPort;ClusterBasePort=$clusterBase;ServiceName=$ServiceName;AppServiceName=$appServiceName;InstallRoot=$root;DbName='wyerp_community_local';CreatedAt=(Get-Date).ToString('o')}
 [IO.File]::WriteAllText((Join-Path $data 'install-settings.json'),($settings|ConvertTo-Json -Depth 4)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 & (Join-Path $root 'installer/Test-Installed.ps1') -InstallRoot $root -DataRoot $data -CheckDatabase 2>&1|Select-Object -Last 6
 if($LASTEXITCODE -ne 0){throw '安装后健康检查失败'}
 Write-Output 'PASS 首次数据库、67项迁移、管理员及软件配置完成'
}finally{
 $appPw=$null;$migPw=$null;$superPw=$null
 foreach($name in @('PGPASSWORD','WYERP_SETUP_APP_PASSWORD','WYERP_SETUP_MIGRATION_PASSWORD')){Remove-Item ('Env:\'+$name) -ErrorAction SilentlyContinue}
 if($tempSql -and (Test-Path -LiteralPath $tempSql)){Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue}
 if($serviceCreated -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status -eq 'Running'){
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
 }
}
