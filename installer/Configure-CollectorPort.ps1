#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PluginDir,
 [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$AppPort
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PluginDir)
$manifest=Join-Path $root 'manifest.json'
if(!(Test-Path -LiteralPath $manifest -PathType Leaf)){throw '未找到当前安装实例的浏览器插件清单'}
$m=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
if($m.manifest_version -ne 3){throw '仅允许修改Manifest V3开源采集插件'}
$extensions=@('.js','.json','.html','.md')
$files=@(Get-ChildItem -LiteralPath $root -File -Recurse|Where-Object{$extensions -contains $_.Extension.ToLowerInvariant()})
if(!$files.Count){throw '没有可配置的采集插件资源'}
$old=':8765'
$new=':'+$AppPort
$changed=0
foreach($file in $files){
 $text=[IO.File]::ReadAllText($file.FullName,[Text.UTF8Encoding]::new($false))
 $replaced=$text.Replace("url.port === '8765'","url.port === '"+$AppPort+"'").Replace('http://127.0.0.1:8765','http://127.0.0.1'+$new).Replace('http://localhost:8765','http://localhost'+$new)
 if($text -cne $replaced){
  [IO.File]::WriteAllText($file.FullName,$replaced,[Text.UTF8Encoding]::new($false))
  $changed++
 }
}
$runtimeManifest=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
$expected=@(('http://127.0.0.1'+$new+'/*'),('http://localhost'+$new+'/*'))
foreach($origin in $expected){if($runtimeManifest.host_permissions -notcontains $origin){throw '插件缺少本实例的本地监听端口授权'}}
foreach($file in $files){
 $text=[IO.File]::ReadAllText($file.FullName,[Text.UTF8Encoding]::new($false))
 if($text.Contains('http://127.0.0.1:8765') -or $text.Contains('http://localhost:8765')){
  if($AppPort -ne 8765){throw '打包插件存在没有正确映射的8765地址'}
 }
}
Write-Output ('PASS 采集插件地址与ERP本机端口一致 PORT='+$AppPort+' CHANGED_FILES='+$changed)