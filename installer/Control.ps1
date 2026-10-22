#Requires -Version 5.1
[CmdletBinding()]
param(
 [ValidateSet('Start','Stop','Restart','Open','Plugin','Status')][string]$Action='Status',
 [string]$InstallRoot=(Split-Path -Parent $PSScriptRoot),
 [string]$DataRoot=(Join-Path $env:ProgramData 'WyerpERP-Community')
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot)
$data=[IO.Path]::GetFullPath($DataRoot)
$settingsFile=Join-Path $data 'install-settings.json'
if(!(Test-Path -LiteralPath $settingsFile -PathType Leaf)){throw '本实例未完成初始化，请先运行安装EXE'}
$settings=Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8|ConvertFrom-Json
$pgName=[string]$settings.ServiceName
$appName=[string]$settings.AppServiceName
$appPort=[int]$settings.AppPort
$dbPort=[int]$settings.PgPort
if($pgName -notmatch '^WyerpCommunityPG[A-Za-z0-9]*$' -or $appName -notmatch '^WyerpCommunityERP[A-Za-z0-9]*$'){throw '服务配置不是专属实例'}
if($appPort -lt 1024 -or $dbPort -lt 1024){throw '端口配置非法'}
if([IO.Path]::GetFullPath([string]$settings.InstallRoot).TrimEnd('\') -ine $root.TrimEnd('\')){throw '安装目录与实例记录不一致，不接管其他软件'}
function Health(){
 try{
  $r=Invoke-WebRequest -Uri ('http://127.0.0.1:'+$appPort+'/health/ready') -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
  return ($r.StatusCode -eq 200)
 }catch{return $false}
}
function Start-Own {
 $pg=Get-Service -Name $pgName -ErrorAction Stop
 $app=Get-Service -Name $appName -ErrorAction Stop
 if($pg.StartType -ne 'Manual' -or $app.StartType -ne 'Manual'){throw '专属服务必须为手动启动'}
 $alreadyRunning=($app.Status -eq 'Running')
 if($alreadyRunning -and (Health)){Write-Output 'PASS ERP已就绪，无需重复启动';return}
 if(!$alreadyRunning){
  if(@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -eq $appPort}).Count){throw 'ERP端口已被其他程序占用，拒绝关闭其他软件'}
  $basePort=[int]$settings.ClusterBasePort
  if($basePort -lt 1024 -or $basePort -gt 65530){throw '内部集群端口配置无效'}
  $internalPorts=@($basePort,($basePort+1),($basePort+2))
  $occupied=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -in $internalPorts})
  if($occupied.Count){
   $details=($occupied|ForEach-Object{[string]$_.LocalPort+'(PID '+[string]$_.OwningProcess+')'}) -join ', '
   throw ('ERP内部集群端口已被其他实例占用：'+$details+'。请先从其管理器正常关闭；本程序不会结束其他软件进程')
  }
  if($pg.Status -ne 'Running'){Start-Service -Name $pgName -ErrorAction Stop}
  $dbSockets=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -eq $dbPort -and $_.LocalAddress -in @('127.0.0.1','::1')})
  if(!$dbSockets.Count){throw '专用数据库端口未准备好'}
  Start-Service -Name $appName -ErrorAction Stop
 }
 $healthy=$false
 for($i=0;$i -lt 110;$i++){
  Start-Sleep -Milliseconds 550
  if(Health){$healthy=$true;break}
  if((Get-Service -Name $appName).Status -ne 'Running'){break}
 }
 if(!$healthy){throw ('ERP健康检查失败，查看：'+(Join-Path $data 'logs/erp-service.log'))}
 Write-Output ('PASS ERP已启动：http://127.0.0.1:'+$appPort)
}
function Stop-Own {
 $app=Get-Service -Name $appName -ErrorAction Stop
 if($app.Status -eq 'Running'){Stop-Service -Name $appName -ErrorAction Stop}
 $pg=Get-Service -Name $pgName -ErrorAction Stop
 if($pg.Status -eq 'Running'){Stop-Service -Name $pgName -ErrorAction Stop}
 Write-Output 'PASS 已停止本ERP和本机专属PostgreSQL，用户数据及密钥保留'
}
function Restart-Own {
 $app=Get-Service -Name $appName -ErrorAction Stop
 if($app.Status -eq 'Running'){
  Stop-Service -Name $appName -ErrorAction Stop
  $basePort=[int]$settings.ClusterBasePort
  if($basePort -lt 1024 -or $basePort -gt 65530){throw '内部集群端口配置无效'}
  $ports=@($appPort,$basePort,($basePort+1),($basePort+2))
  $clear=$false
  for($i=0;$i -lt 80;$i++){
   $occupied=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -in $ports})
   if(!$occupied.Count){$clear=$true;break}
   Start-Sleep -Milliseconds 250
  }
  if(!$clear){throw '旧ERP后台端口仍被占用，拒绝重复启动。请查看本实例服务日志'}
 }
 # PostgreSQL正在工作时不重启它，以减少不必要的数据库停启。
 Start-Own
}
switch($Action){
 'Start' {Start-Own}
 'Stop' {Stop-Own}
 'Restart' {Restart-Own}
 'Open' {Start-Own;Start-Process ('http://127.0.0.1:'+$appPort)}
 'Plugin' {
  & (Join-Path $root 'tools/Install-Collector.ps1') -PluginDir (Join-Path $root 'collector/wyerp-collector')
  if(!$?){throw '浏览器插件引导未完成'}
 }
 'Status' {
  $pg=Get-Service -Name $pgName -ErrorAction Stop
  $app=Get-Service -Name $appName -ErrorAction Stop
  Write-Output ('ERP_RUNNING='+[bool]($app.Status -eq 'Running' -and (Health)))
  Write-Output ('ERP_SERVICE='+$app.Status)
  Write-Output ('PG_SERVICE='+$pg.Status)
  Write-Output ('ERP_URL=http://127.0.0.1:'+$appPort)
 }
}
