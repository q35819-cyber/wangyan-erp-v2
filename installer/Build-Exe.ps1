#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$DependenciesPath,
 [Parameter(Mandatory=$true)][string]$PostgresRoot,
 [Parameter(Mandatory=$true)][string]$NodeExecutable,
 [Parameter(Mandatory=$true)][string]$OutputDir
)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$deps=[IO.Path]::GetFullPath($DependenciesPath)
$pg=[IO.Path]::GetFullPath($PostgresRoot)
$node=[IO.Path]::GetFullPath($NodeExecutable)
$dest=[IO.Path]::GetFullPath($OutputDir)
$releaseName='WyerpERP-Community-Setup-v0.1.0-preview8.exe'
$csc=Join-Path $env:windir 'Microsoft.NET\Framework64/v4.0.30319/csc.exe'
if(!(Test-Path -LiteralPath $csc)){throw 'Windows .NET Framework C#编译器不可用'}
& $csc '/nologo' '/target:winexe' ('/out:'+(Join-Path $PSScriptRoot 'WyerpERP-Manager.exe')) ('/win32manifest:'+(Join-Path $PSScriptRoot 'manager.manifest')) '/r:System.Windows.Forms.dll' '/r:System.Drawing.dll' (Join-Path $PSScriptRoot 'WyerpManager.cs')
if($LASTEXITCODE -ne 0){throw '桌面管理器EXE编译失败'}
& $csc '/nologo' '/target:exe' ('/out:'+(Join-Path $PSScriptRoot 'WyerpERP-Service.exe')) '/r:System.ServiceProcess.dll' (Join-Path $PSScriptRoot 'WyerpService.cs')
if($LASTEXITCODE -ne 0){throw '后台服务EXE编译失败'}
$exe=Join-Path $dest $releaseName
if(Test-Path -LiteralPath $exe){throw '已存在同名安装程序，拒绝覆盖现有发布文件'}
foreach($must in @((Join-Path $deps 'pg/package.json'),(Join-Path $deps 'exceljs/package.json'),(Join-Path $deps 'nodemailer/package.json'),(Join-Path $pg 'bin/initdb.exe'),(Join-Path $pg 'bin/pg_ctl.exe'),(Join-Path $pg 'share/postgresql.conf.sample'),$node,(Join-Path $PSScriptRoot 'WyerpERP-Manager.exe'))){
 if(!(Test-Path -LiteralPath $must -PathType Leaf)){throw ('无法打包，必要文件缺失：'+$must)}
}
foreach($ps in @('Initialize.ps1','Run-Server.ps1','Control.ps1')){
 $tokens=$null;$errors=$null
 [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $ps),[ref]$tokens,[ref]$errors)|Out-Null
 if($errors.Count){throw ('安装器脚本有语法错误：'+$ps)}
}
New-Item -ItemType Directory -Force -Path $dest|Out-Null
& $csc '/nologo' '/target:winexe' ('/out:'+(Join-Path $PSScriptRoot 'WyerpERP-Uninstall.exe')) ('/win32manifest:'+(Join-Path $PSScriptRoot 'setup.manifest')) '/r:System.Windows.Forms.dll' '/r:System.Drawing.dll' '/r:System.ServiceProcess.dll' '/r:System.Web.Extensions.dll' (Join-Path $PSScriptRoot 'WyerpUninstall.cs')
if($LASTEXITCODE -ne 0){throw 'Windows安全卸载器编译失败'}
$stage=Join-Path $env:TEMP ('wyerp-build-'+[Guid]::NewGuid().ToString('N'))
$zip=Join-Path $env:TEMP ('wyerp-payload-'+[Guid]::NewGuid().ToString('N')+'.zip')
try {
 New-Item -ItemType Directory -Force -Path $stage|Out-Null
 $appDir=Join-Path $stage 'erp'
 New-Item -ItemType Directory -Path $appDir|Out-Null
 foreach($source in @(Get-ChildItem -LiteralPath (Join-Path $repo 'erp') -Force)){
  if($source.Name -in @('node_modules','.env','本机数据','.git','logs','coverage','.cache')){continue}
  Copy-Item -LiteralPath $source.FullName -Destination (Join-Path $appDir $source.Name) -Recurse -Force
 }
 Copy-Item -LiteralPath $deps -Destination (Join-Path $appDir 'node_modules') -Recurse
 $pgDest=Join-Path $stage 'runtime/postgresql'
 New-Item -ItemType Directory -Path $pgDest -Force|Out-Null
 foreach($sub in @('bin','lib','share')){
  Copy-Item -LiteralPath (Join-Path $pg $sub) -Destination (Join-Path $pgDest $sub) -Recurse
 }
 $nodeDest=Join-Path $stage 'runtime/node'
 New-Item -ItemType Directory -Path $nodeDest -Force|Out-Null
 Copy-Item -LiteralPath $node -Destination (Join-Path $nodeDest 'node.exe')
 $plugin=Join-Path $stage 'collector'
 New-Item -ItemType Directory -Path $plugin -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $repo 'extensions/wyerp-collector') -Destination (Join-Path $plugin 'wyerp-collector') -Recurse
 $launcher=Join-Path $stage 'installer'
 New-Item -ItemType Directory -Path $launcher -Force|Out-Null
 foreach($name in @('Initialize.ps1','Control.ps1','Run-Server.ps1','Test-Installed.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $launcher}
 $helper=Join-Path $stage 'tools'
 New-Item -ItemType Directory -Path $helper -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $repo 'tools/Install-Collector.ps1') -Destination $helper
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'WyerpERP-Manager.exe') -Destination $stage
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'WyerpERP-Service.exe') -Destination $stage
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'WyerpERP-Uninstall.exe') -Destination $stage
 foreach($f in @('LICENSE','THIRD_PARTY_NOTICES.md','README.md','AGENTS.md')){Copy-Item (Join-Path $repo $f) -Destination $stage}
 $docs=Join-Path $stage 'docs'
 Copy-Item -LiteralPath (Join-Path $repo 'docs') -Destination $docs -Recurse
 # Windows自带PowerShell5.1将没有BOM的UTF-8 .ps1按本机ANSI代码页解释，
 # 含中文的单引号字符串会被错误解析。只修构建暂存目录，不修改业务源码。
 $psCount=0
 foreach($ps1 in @(Get-ChildItem -LiteralPath $stage -Recurse -File -Filter '*.ps1')){
  $text=[IO.File]::ReadAllText($ps1.FullName,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($ps1.FullName,$text,[Text.UTF8Encoding]::new($true))
  $psCount++
 }
 Write-Output ('STAGED_POWERSHELL_UTF8_BOM_FILES='+$psCount) $forbidden=@(Get-ChildItem -LiteralPath $stage -File -Recurse -Force|Where-Object{$_.FullName -match '(?i)\\(?:\.git|本机数据|secrets|backups|contracts|\.cache)\\|\\(?:wyerp\.env|initial-admin-password\.txt)$|\.pfx$|\.pem$'})
 if($forbidden.Count){throw '检测到禁止打包的私有配置或敏感文件'}
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 [IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
 $csc='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 & $csc '/nologo' '/target:winexe' ('/out:'+$exe) ('/win32manifest:'+(Join-Path $PSScriptRoot 'setup.manifest')) '/r:System.Windows.Forms.dll' '/r:System.Drawing.dll' '/r:System.IO.Compression.dll' '/r:System.IO.Compression.FileSystem.dll' ('/resource:'+$zip+',WyerpPayload.zip') (Join-Path $PSScriptRoot 'WyerpSetup.cs') 2>&1|Select-Object -Last 22
 if($LASTEXITCODE -ne 0){throw 'EXE安装包编译失败'}
 if(!(Test-Path -LiteralPath $exe)){throw '未生成EXE安装包'}
 $hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
 [IO.File]::WriteAllText((Join-Path $dest ($releaseName+'.sha256')),($hash+'  '+$releaseName)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 Write-Output ('BUILT_SETUP_EXE='+$exe)
 Write-Output ('SETUP_SIZE_MB='+[math]::Round((Get-Item $exe).Length/1MB,2))
 Write-Output ('BUNDLED_FILES='+@(Get-ChildItem -LiteralPath $stage -Recurse -File).Count)
 Write-Output ('SETUP_SHA256='+$hash)
}finally{
 if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}
 if(Test-Path -LiteralPath $zip){Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue}
}
