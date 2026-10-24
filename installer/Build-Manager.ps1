#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$here=Split-Path -Parent $MyInvocation.MyCommand.Path
$csc=Join-Path $env:windir 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
if(!(Test-Path -LiteralPath $csc)){throw '缺少.NET Framework C#编译器'}
$source=Join-Path $here 'WyerpERP-Manager.cs'
$pluginGuide=Join-Path $here 'WyerpPluginGuide.cs'
if(!(Test-Path -LiteralPath $pluginGuide)){throw '缺少浏览器插件安装指引源码'}
$manifest=Join-Path $here 'WyerpERP-Manager.manifest'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /utf8output /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll ("/win32manifest:" + $manifest) ("/out:" + [IO.Path]::GetFullPath($OutputPath)) $source $pluginGuide
if($LASTEXITCODE -ne 0){throw '管理器C#编译失败'}
Write-Output ("PASS manager compiled: "+[IO.Path]::GetFullPath($OutputPath))