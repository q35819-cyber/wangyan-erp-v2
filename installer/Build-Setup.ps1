#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PayloadZip,
 [Parameter(Mandatory=$true)][string]$OutputExe
)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'WyerpSetup.cs'
$manifest=Join-Path $PSScriptRoot 'WyerpSetup.manifest'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
foreach($path in @($PayloadZip,$source,$manifest,$compiler)){
 if(!(Test-Path -LiteralPath $path -PathType Leaf)){throw ('构建文件不存在：'+$path)}
}
$payload=[IO.Path]::GetFullPath($PayloadZip)
$output=[IO.Path]::GetFullPath($OutputExe)
if($payload -eq $output){throw '构建输出不能覆盖输入数据'}
if(Test-Path -LiteralPath $output){throw '输出文件已存在，拒绝覆盖已有安装包'}
$destination=Split-Path -Parent $output
if(!(Test-Path -LiteralPath $destination)){New-Item -ItemType Directory -Path $destination -Force | Out-Null}
$compilerArgs=@('/nologo','/target:winexe','/platform:x64',('/out:'+$output),
 ('/win32manifest:'+$manifest),
 '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',
 '/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',
 ('/resource:'+$payload+',WyerpPayload.zip'),$source)
& $compiler @compilerArgs
if($LASTEXITCODE -ne 0){throw '安装器编译失败'}
Get-FileHash -Algorithm SHA256 -LiteralPath $output | Format-List Path,Hash
