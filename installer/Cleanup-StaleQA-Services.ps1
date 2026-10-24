#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$KeepInstallRoot,
 [switch]$Apply,
 [switch]$IncludeLegacyQA
)
$ErrorActionPreference='Stop'
# Only test installations inside the dedicated QA directory may run this cleanup.
$keep=[IO.Path]::GetFullPath($KeepInstallRoot).TrimEnd('\')
$instance=Split-Path -Parent $keep
$base=Split-Path -Parent $instance
$dirName=Split-Path -Leaf $instance
$qaMatch=[regex]::Match($dirName,'^gui-installer-qa(?<id>\d+)-\d{8}$',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
if(!$qaMatch.Success -or (Split-Path -Leaf $keep) -ine 'program' -or
  (Split-Path -Leaf $base) -notmatch '^WyerpIsolatedDeployQA-\d{8}$'){
 throw '非隔离QA实例，禁止自动清理任何Windows服务'
}
$keepId=[int]$qaMatch.Groups['id'].Value
$cfgPath=Join-Path $instance 'data\install-settings.json'
if(!(Test-Path -LiteralPath $cfgPath -PathType Leaf)){throw '当前QA实例缺少安装配置，拒绝清理'}
$cfg=Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8|ConvertFrom-Json
if([IO.Path]::GetFullPath([string]$cfg.InstallRoot).TrimEnd('\') -ine $keep -or
 [string]$cfg.ServiceName -cne ('WyerpCommunityPGUIQA'+$keepId) -or
 [string]$cfg.AppServiceName -cne ('WyerpCommunityERPUIQA'+$keepId)){
 throw '当前QA安装配置与实例ID不匹配，拒绝清理'
}
$services=@(Get-CimInstance Win32_Service|Where-Object{$_.Name -match '^WyerpCommunity(ERP|PG)UIQA\d+$'})
$guiPaths=@(Get-CimInstance Win32_Process -Filter "Name = 'WyerpERP-Manager.exe'" -ErrorAction SilentlyContinue|ForEach-Object{$_.ExecutablePath})
$actions=[System.Collections.Generic.List[object]]::new()
foreach($service in $services){
 $m=[regex]::Match($service.Name,'^WyerpCommunity(?<role>ERP|PG)UIQA(?<number>\d+)$')
 if(!$m.Success){continue}
 $number=[int]$m.Groups['number'].Value
 if($number -ge $keepId){continue}
 $dirs=@(Get-ChildItem -LiteralPath $base -Directory -Filter ('gui-installer-qa'+$number+'-*') -ErrorAction SilentlyContinue)
 if($dirs.Count -ne 1){continue}
 $oldRoot=[IO.Path]::GetFullPath($dirs[0].FullName)
 $oldInstall=Join-Path $oldRoot 'program'
 $exe=if($m.Groups['role'].Value -eq 'ERP'){
  Join-Path $oldInstall 'WyerpERP-Service.exe'
 }else{
  Join-Path $oldInstall 'runtime\postgresql\bin\pg_ctl.exe'
 }
 $raw=[string]$service.PathName
 # Win32_Service.PathName can be quoted; exact embedded executable and QA root required.
 $exeQuoted='"'+$exe+'"'
 $prefixOk=($raw.StartsWith($exeQuoted+' ',[StringComparison]::OrdinalIgnoreCase) -or
  $raw.StartsWith($exe+' ',[StringComparison]::OrdinalIgnoreCase))
 if(!$prefixOk){continue}
 if($raw.IndexOf($oldRoot,[StringComparison]::OrdinalIgnoreCase) -lt 0){continue}
 $oldConfigPath=Join-Path $oldRoot 'data\install-settings.json'
 if(Test-Path -LiteralPath $oldConfigPath -PathType Leaf){
  try {
   $old=Get-Content $oldConfigPath -Raw -Encoding UTF8|ConvertFrom-Json
   if([IO.Path]::GetFullPath([string]$old.InstallRoot).TrimEnd('\') -ine $oldInstall -or
     $service.Name -cnotin @([string]$old.ServiceName,[string]$old.AppServiceName)){continue}
  }catch{continue}
 }elseif($service.State -ne 'Stopped'){
  # An orphan without a verifiable config may be removed only when already stopped.
  continue
 }
 if(@($guiPaths|Where-Object{$_ -and $_.StartsWith($oldInstall+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){continue}
 $actions.Add([pscustomobject]@{
  Name=$service.Name; Role=$m.Groups['role'].Value; QA=$number
  State=$service.State; Root=$oldRoot; Status='ELIGIBLE'
 })
}
# Carefully handle old QA3/QA4 naming, only when the caller opts in.
if($IncludeLegacyQA){
 $legacy=@{
  'WyerpCommunityPGQA3'='exe-preview2-qa\runtime\postgresql\bin\pg_ctl.exe'
  'WyerpCommunityERPQA3'='exe-preview2-qa\WyerpERP-Service.exe'
  'WyerpCommunityPGQA4'='preview8-e2e-qa4-program\runtime\postgresql\bin\pg_ctl.exe'
  'WyerpCommunityERPQA4'='preview8-e2e-qa4-program\WyerpERP-Service.exe'
 }
 foreach($name in $legacy.Keys){
  $service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'") -ErrorAction SilentlyContinue
  if(!$service -or $service.State -ne 'Stopped'){continue}
  $exe=Join-Path $base $legacy[$name]
  if(!(([string]$service.PathName).StartsWith('"'+$exe+'" ',[StringComparison]::OrdinalIgnoreCase) -or
        ([string]$service.PathName).StartsWith($exe+' ',[StringComparison]::OrdinalIgnoreCase))){continue}
  $actions.Add([pscustomobject]@{Name=$name;Role='LEGACY';QA=0;State=$service.State;Root=$base;Status='ELIGIBLE'})
 }
}
$sorted=@($actions |Sort-Object @{Expression='QA'},@{Expression={if($_.Role -eq 'ERP'){0}else{1}}},Name)
$done=0;$failed=0
foreach($item in $sorted){
 if(!$Apply){
  Write-Output ('ELIGIBLE '+$item.Name+' '+$item.State)
  continue
 }
 try {
  $service=Get-Service -Name $item.Name -ErrorAction Stop
  if($service.Status -ne 'Stopped'){
   Stop-Service -Name $item.Name -ErrorAction Stop
   $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(25))
  }
  $sc=& sc.exe delete $item.Name 2>&1
  if($LASTEXITCODE -ne 0){throw ('SC delete failed: '+($sc -join ' '))}
  $done++
  Write-Output ('REMOVED '+$item.Name)
 }catch{
  $failed++
  Write-Output ('FAILED '+$item.Name+' '+$_.Exception.Message)
 }
}
Write-Output ("QA_CLEANUP keep=QA$keepId scanned=$($services.Count) eligible=$($sorted.Count) removed=$done failed=$failed mode=$(if($Apply){'APPLY'}else{'CHECK'})")
if($failed){exit 2}