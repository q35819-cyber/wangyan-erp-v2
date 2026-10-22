#Requires -Version 5.1
[CmdletBinding()]
param([string]$OutputDir='')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$src=Join-Path $root 'extensions\wyerp-collector'
$manifest=Get-Content -LiteralPath (Join-Path $src 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if([int]$manifest.manifest_version -ne 3 -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$'){throw 'manifest.json缺少合法版本号'}
$version=[string]$manifest.version
$name='WyerpCollector-v'+$version
$dest=if($OutputDir){[IO.Path]::GetFullPath($OutputDir)}else{Join-Path $root 'dist'}
New-Item -ItemType Directory -Force -Path $dest|Out-Null
$archive=Join-Path $dest ($name+'.zip')
$checksum=Join-Path $dest ($name+'.sha256')
if(Test-Path -LiteralPath $archive){throw ('已存在同名版本压缩包，拒绝覆盖：'+$archive)}
$git=Get-Command git.exe -ErrorAction Stop
$tracked=@(& $git.Source -C $root ls-files -- 'extensions/wyerp-collector')
if($LASTEXITCODE -ne 0 -or $tracked.Count -lt 15){throw '无法确定Git跟踪的合法插件源码文件'}
$prefix='extensions/wyerp-collector/'
$allowedExt=@('.js','.css','.html','.json','.md','.png','.svg','.ico','.webp')
$tmp=Join-Path $env:TEMP ('wyerp-package-'+[guid]::NewGuid().ToString('N'))
try{
 $plugin=Join-Path $tmp $name
 New-Item -ItemType Directory -Path $plugin -Force|Out-Null
 foreach($item in $tracked){
  $relative=$item.Replace('\','/')
  if(-not $relative.StartsWith($prefix,[StringComparison]::Ordinal)){throw 'Git插件清单中包含范围外路径'}
  $sub=$relative.Substring($prefix.Length)
  if($sub -match '(^|/)\.|(^|/)(?:secrets|node_modules|tests|contracts|private|backups|output|本机数据)(/|$)|(?i)\.(env|key|pem|pfx|p12|db|sqlite|dump|bak|zip|exe)$'){
   throw ('发现不可打包的私有或运行文件：'+$sub)
  }
  if([IO.Path]::GetExtension($sub) -notin $allowedExt){throw ('文件类型尚未审查：'+$sub)}
  $full=Join-Path $root ($relative.Replace('/','\'))
  if(!(Test-Path -LiteralPath $full -PathType Leaf)){throw ('源码文件不存在：'+$relative)}
  $to=Join-Path $plugin $sub
  New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force|Out-Null
  Copy-Item -LiteralPath $full -Destination $to
 }
 Copy-Item -LiteralPath (Join-Path $root 'Install-Collector.cmd') -Destination $tmp
 $helperDir=Join-Path $tmp 'tools'
 New-Item -ItemType Directory -Path $helperDir -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $root 'tools/Install-Collector.ps1') -Destination $helperDir
 $note=@(
  ('网研ERP开源采集插件 v'+$version),
  '',
  '1. 完整解压整个ZIP到一个固定文件夹，不要直接在压缩包里运行。',
  '2. 双击 Install-Collector.cmd，程序会打开Edge插件管理页面并复制安装路径。',
  '3. 打开开发人员模式，点击加载解压缩的扩展，粘贴路径并确认。',
  '4. 打开 http://127.0.0.1:8765 并登录ERP；使用1688/Ozon商品页手动采集。',
  '',
  '不要删除已加载的插件文件夹，浏览器需要持续读取文件。',
  '升级时依照插件说明更新，不要自行修改浏览器企业强制安装策略。'
 ) -join [Environment]::NewLine
 [IO.File]::WriteAllText((Join-Path $tmp '安装说明.txt'),$note,[Text.UTF8Encoding]::new($false))
 Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $archive -CompressionLevel Optimal
 if(!(Test-Path -LiteralPath $archive)){throw 'ZIP生成失败'}
 Add-Type -AssemblyName System.IO.Compression
 $zip=[IO.Compression.ZipFile]::OpenRead($archive)
 try{
  $item=$zip.GetEntry($name+'/manifest.json')
  if(!$item){throw '压缩包未包含预期插件manifest'}
  $stream=$item.Open()
  $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
  try{$copy=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
  if([string]$copy.version -ne $version){throw '压缩包版本与源码manifest不一致'}
  if(!$zip.GetEntry('Install-Collector.cmd') -or !$zip.GetEntry('tools/Install-Collector.ps1')){throw '缺少用户安装向导文件'}
  if($zip.Entries.Count -lt $tracked.Count+3){throw '压缩包文件清单不完整'}
 }finally{$zip.Dispose()}
 $hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
 [IO.File]::WriteAllText($checksum,($hash+'  '+$name+'.zip')+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 Write-Output ('PASS 插件文件版本与manifest同步：'+$version)
 Write-Output ('ZIP_PACKAGE='+$archive)
 Write-Output ('ZIP_BYTES=' + (Get-Item -LiteralPath $archive).Length)
 Write-Output ('CHECKSUM_PATH='+$checksum)
 Write-Output ('TRACKED_EXTENSION_FILES='+$tracked.Count)
}finally{
 if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Recurse -Force}
}