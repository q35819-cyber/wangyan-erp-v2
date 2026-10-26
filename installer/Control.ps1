#Requires -Version 5.1
[CmdletBinding()]
param(
 [ValidateSet('Start','Stop','Restart','Open','Plugin','PluginCheck','Status')][string]$Action='Status',
 [string]$InstallRoot='',
 [string]$DataRoot=''
)
$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($InstallRoot)){
 $InstallRoot=Split-Path -Parent $PSScriptRoot
}
$root=[IO.Path]::GetFullPath($InstallRoot)
# The desktop manager invokes Control.ps1 without -DataRoot. Resolve its own
# install, instead of assuming isolated installs use global ProgramData.
if([string]::IsNullOrWhiteSpace($DataRoot)){
 $instanceFile=Join-Path $root 'installer/instance-location.json'
 if(Test-Path -LiteralPath $instanceFile -PathType Leaf){
  $instance=Get-Content -LiteralPath $instanceFile -Raw -Encoding UTF8|ConvertFrom-Json
  if([string]::IsNullOrWhiteSpace([string]$instance.DataRoot) -or
     ![IO.Path]::IsPathRooted([string]$instance.DataRoot) -or
     [IO.Path]::GetFullPath([string]$instance.InstallRoot).TrimEnd('\') -ine $root.TrimEnd('\')){
   throw '实例目录记录不合法，拒绝启动其他ERP实例'
  }
  $DataRoot=[string]$instance.DataRoot
 }else{
  # Backward compatibility for installs before the instance location marker.
  $DataRoot=Join-Path $env:ProgramData 'WyerpERP-Community'
 }
}
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
function Clear-StaleQAOnStart {
 # Explicitly limited to disposable isolated GUI-QA installations. Normal
 # single-machine installs and all unrelated Windows services are untouched.
 if($root -notmatch '[\\/]gui-installer-qa\d+-\d{8}[\\/]program$'){return}
 $cleaner=Join-Path $root 'installer/Cleanup-StaleQA-Services.ps1'
 if(!(Test-Path -LiteralPath $cleaner -PathType Leaf)){return}
 try {
  $result=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $cleaner -KeepInstallRoot $root -IncludeLegacyQA -Apply 2>&1)
  foreach($line in $result){
   if([string]$line -match '^(QA_CLEANUP|FAILED )'){Write-Output ([string]$line)}
  }
  if($LASTEXITCODE -ne 0){Write-Warning '旧测试服务自动清理未全部完成；不影响当前ERP启动'}
 }catch{Write-Warning ('旧测试服务检测失败：'+$_.Exception.Message)}
}
function Start-Own {
 Clear-StaleQAOnStart
 $pg=Get-Service -Name $pgName -ErrorAction Stop
 $app=Get-Service -Name $appName -ErrorAction Stop
 if($pg.StartType -ne 'Manual' -or $app.StartType -ne 'Manual'){throw '专属服务必须为手动启动'}
 $alreadyRunning=($app.Status -eq 'Running')
 if($alreadyRunning -and (Health)){Write-Output 'PASS ERP已就绪，无需重复启动';return}
 if(!$alreadyRunning){
  if(@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -eq $appPort}).Count){throw 'ERP端口已被其他程序占用，拒绝关闭其他软件'}
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
  # 单机重启仅等待ERP端口释放。
  $ports=@($appPort)
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
  & (Join-Path $root 'tools/Install-Collector.ps1') -PluginDir (Join-Path $root 'collector/wyerp-collector') -ErpUrl ('http://127.0.0.1:'+$appPort)
  if(!$?){throw '浏览器插件引导未完成'}
 }
 'PluginCheck' {
  & (Join-Path $root 'tools/Install-Collector.ps1') -PluginDir (Join-Path $root 'collector/wyerp-collector') -CheckOnly
  if(!$?){throw '采集插件文件校验失败'}
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
