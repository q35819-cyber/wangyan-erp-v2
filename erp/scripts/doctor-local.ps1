#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$DataRoot,
 [switch]$CheckDatabase
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$erpDir=Join-Path $projectRoot 'erp'
$root=[IO.Path]::GetFullPath($DataRoot)
$errors=[System.Collections.Generic.List[string]]::new()
function Check([bool]$ok,[string]$label,[string]$fix){
 if($ok){Write-Output ('PASS '+$label)}else{
  Write-Output ('FAIL '+$label+'。处理：'+$fix)
  $errors.Add($label)
 }
}
$node=Get-Command node.exe -ErrorAction SilentlyContinue
$npm=Get-Command npm.cmd -ErrorAction SilentlyContinue
Check ([bool]$node) 'Node.js已安装' '安装Node.js 24兼容版，重新打开PowerShell'
Check ([bool]$npm) 'npm已安装' '重新安装带npm的Node.js'
if($node){
 $rawVersion=(& $node.Source --version).Trim()
 $parsed=$rawVersion.TrimStart('v') -split '\.'
 $good=([int]$parsed[0] -gt 22) -or ([int]$parsed[0] -eq 22 -and [int]$parsed[1] -ge 9)
 Check $good ("Node版本 $rawVersion 支持--env-file-if-exists") '需要Node.js 22.9+，建议24'
}
$secrets=Join-Path $root 'secrets'
$file=Join-Path $secrets 'wyerp.env'
Check (Test-Path -LiteralPath $file -PathType Leaf) '独立环境文件存在' '先执行erp/scripts/setup-local.ps1，禁止覆盖既有数据'
if(Test-Path -LiteralPath $file -PathType Leaf){
 $content=[IO.File]::ReadAllText($file)
 $m=[regex]::Match($content,'(?m)^PGDATABASE=([^\r\n]+)\r?$')
 $db=if($m.Success){$m.Groups[1].Value.Trim()}else{''}
 Check ([bool]($db -cmatch '^wyerp_community_[a-z0-9_]+$')) '数据库名属于全新社区隔离命名空间' '请仅连接新建的wyerp_community_*数据库，不要连接真实业务库'
 $hosts=[regex]::Matches($content,'(?m)^PGHOST=([^\r\n]+)\r?$')
 Check ($hosts.Count -eq 1 -and $hosts[0].Groups[1].Value.Trim() -in @('127.0.0.1','localhost','::1')) '数据库仅允许本机回环' '不要直接复用远程或原开发者PostgreSQL'
 $mail=[regex]::Matches($content,'(?m)^SMTP_(USER|PASS|FROM)=(.*)$')
 $filled = @($mail|Where-Object{$_.Groups[2].Value.Trim() -ne ''})
 Check ($mail.Count -eq 3 -and ($filled.Count -eq 0 -or $filled.Count -eq 3)) 'SMTP未预置私人邮箱，或已完整填写本人配置' '请完整配置自己的SMTP_USER、SMTP_PASS、SMTP_FROM，或全部留空'
}
foreach($key in @('credentials.key','csrf.key','private-object.key')){
 $path=Join-Path $secrets $key
 $value=if(Test-Path -LiteralPath $path -PathType Leaf){[IO.File]::ReadAllText($path).Trim()}else{''}
 Check ([bool]($value -match '^[a-f0-9]{64}$')) ("私有密钥文件 $key 合规") '必须由本机setup-local.ps1新建，不允许复制原作者的密钥'
}
$pgLibrary=Join-Path $erpDir 'node_modules/pg/package.json'
Check (Test-Path -LiteralPath $pgLibrary -PathType Leaf) 'ERP npm依赖已安装' '在erp目录执行npm ci'
$manifest=Join-Path $projectRoot 'extensions/wyerp-collector/manifest.json'
if(Test-Path -LiteralPath $manifest){
 try{
  $ext=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
  $folder=Split-Path -Parent $manifest
  $needed=@($ext.background.service_worker,$ext.side_panel.default_path)
  foreach($item in $ext.content_scripts){
   $needed+=@($item.js)
   $needed+=@($item.css)
  }
  $missing=@($needed|Where-Object{$_ -and !(Test-Path -LiteralPath (Join-Path $folder $_) -PathType Leaf)})
  Check ($ext.manifest_version -eq 3 -and $missing.Count -eq 0) '浏览器插件Manifest V3及依赖文件完整' '重新下载开源仓库并使用extensions/wyerp-collector目录加载'
 }catch{Check $false '浏览器插件manifest有效' '检查JSON格式'}
}else{Check $false '浏览器插件已包含' '确认从完整仓库下载extensions/wyerp-collector'}
if($CheckDatabase){
 if(-not $node -or !(Test-Path -LiteralPath $file) -or !(Test-Path -LiteralPath $pgLibrary)){
  Check $false '数据库迁移检查' '先安装Node、npm依赖并创建独立本机配置'
 }elseif($errors.Count -gt 0){
  Check $false '数据库迁移检查' '先修复上述环境/密钥错误'
 }else{
  Push-Location $erpDir
  try{
   $result=@(& $node.Source "--env-file-if-exists=$file" 'db/migrate.js' '--check' 2>&1)
   if($LASTEXITCODE -eq 0){Check $true 'PostgreSQL数据库全部迁移已执行' ''}
   else{
    $safeTail=@($result|Where-Object{$_ -match 'pending|summary:|ECONNREFUSED|permission|password authentication|does not exist'}|Select-Object -Last 3)
    Check $false 'PostgreSQL数据库全部迁移已执行' ('请先确认新建的数据库与PG角色，然后执行db/migrate.js。提示：'+($safeTail -join ' | '))
   }
  }finally{Pop-Location}
 }
}
if($errors.Count){
 Write-Output ('RESULT=FAIL 项目数：'+$errors.Count)
 exit 2
}
Write-Output 'RESULT=PASS（配置静态检查通过；不代表已测试真实商品采集或公网安全）'