#Requires -Version 5.1
[CmdletBinding()]
param(
 [ValidateSet('Edge','Chrome')][string]$Browser='Edge',
 [string]$PluginDir='',
 [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $PluginDir){
 $source=Join-Path $root 'extensions\wyerp-collector'
 if(Test-Path -LiteralPath (Join-Path $source 'manifest.json')){
  $PluginDir=$source
 } else {
  $choices=@(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
   Where-Object {$_.Name -match '^WyerpCollector-v\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json'))})
  if($choices.Count -ne 1){throw '找不到唯一插件目录。请解压完整版本ZIP，或使用仓库的完整目录'}
  $PluginDir=$choices[0].FullName
 }
}
$folder=[IO.Path]::GetFullPath($PluginDir)
$file=Join-Path $folder 'manifest.json'
if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw '文件夹缺少manifest.json，不是插件目录'}
$manifest=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.manifest_version -ne 3 -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$'){
 throw '插件Manifest版本号无效'
}
$version=[string]$manifest.version
if((Split-Path -Leaf $folder) -match '^WyerpCollector-v(.+)$' -and $Matches[1] -ne $version){
 throw '插件文件夹版本与manifest.json版本不一致，拒绝混用'
}
$refs=[System.Collections.Generic.List[string]]::new()
if($manifest.background.service_worker){$refs.Add([string]$manifest.background.service_worker)}
if($manifest.side_panel.default_path){$refs.Add([string]$manifest.side_panel.default_path)}
foreach($block in @($manifest.content_scripts)){
 foreach($relative in @($block.js)+@($block.css)){if($relative){$refs.Add([string]$relative)}}
}
foreach($block in @($manifest.web_accessible_resources)){
 foreach($relative in @($block.resources)){if($relative -and $relative -notmatch '[*?]'){$refs.Add([string]$relative)}}
}
foreach($relative in @($refs|Select-Object -Unique)){
 if(!(Test-Path -LiteralPath (Join-Path $folder $relative) -PathType Leaf)){throw ('插件缺少：'+$relative)}
}
Write-Output ('PASS 网研ERP采集助手 v'+$version+' 配置与 '+@($refs|Select-Object -Unique).Count+' 个引用文件完整')
Write-Output ('插件目录：'+$folder)
if($CheckOnly){Write-Output 'RESULT=PASS（仅检查，不会操作浏览器）';return}
try{Set-Clipboard -Value $folder -ErrorAction Stop; Write-Output '插件路径已复制，稍后在选择文件夹的窗口中按Ctrl+V即可。'}catch{Write-Warning '无法自动复制路径，请手动选择上面显示的目录。'}
$exe=$null
$roots=@($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),$env:LOCALAPPDATA)|Where-Object{$_}
$commandName=if($Browser -eq 'Edge'){'msedge.exe'}else{'chrome.exe'}
$relative=if($Browser -eq 'Edge'){'Microsoft\Edge\Application\msedge.exe'}else{'Google\Chrome\Application\chrome.exe'}
$candidates=@((Get-Command $commandName -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source -First 1))+
 @($roots|ForEach-Object{Join-Path $_ $relative})
foreach($candidate in $candidates){if($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)){$exe=$candidate;break}}
if(-not $exe){throw ('没有找到'+$Browser+'。请先安装浏览器。')}
$url=if($Browser -eq 'Edge'){'edge://extensions/'}else{'chrome://extensions/'}
Start-Process -FilePath $exe -ArgumentList $url
try{Start-Process -FilePath 'explorer.exe' -ArgumentList ('"'+$folder+'"')|Out-Null}catch{}
Write-Output ('已打开'+$Browser+'插件管理页，请完成三步：')
Write-Output '1. 开启「开发人员模式」。'
Write-Output '2. 点击「加载解压缩的扩展」或「加载已解压的扩展程序」。'
Write-Output '3. 在选择文件夹窗口粘贴路径，确认。安装完成后固定插件图标。'
$addresses=@($manifest.host_permissions|Where-Object{$_ -match '^http://127\.0\.0\.1:[0-9]{4,5}/\*$'})
if($addresses.Count -ne 1){throw '当前插件ERP访问授权异常，请重新执行安装程序自检'}
$erpAddress=[string]$addresses[0].Replace('/*','/')
Write-Output ('登录 '+$erpAddress+' 后手动采集1688/Ozon商品，回采集箱核实成功。')
Write-Output '本工具不会修改浏览器企业策略，也不能绕过浏览器对插件安装的确认。'