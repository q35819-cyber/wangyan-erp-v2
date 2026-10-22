#Requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$DataRoot,
 [string]$PgHostName='127.0.0.1',
 [ValidateRange(1,65535)][int]$PgPort=5432,
 [string]$PgDatabase='wyerp_community_fresh',
 [string]$PgUser='wyerp_community_app',
 [string]$PgMigrationUser='wyerp_community_migrator',
 [switch]$PasswordFromEnvironment
)
$ErrorActionPreference='Stop'
$erpRoot=Split-Path -Parent $PSScriptRoot
$repoRoot=Split-Path -Parent $erpRoot
$root=[IO.Path]::GetFullPath($DataRoot)
if([IO.Path]::GetPathRoot($root) -eq $root){throw '拒绝使用磁盘根目录'}
if($root.StartsWith([IO.Path]::GetFullPath($repoRoot).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){
 throw '数据目录必须位于Git仓库之外'
}
if(Test-Path -LiteralPath $root){throw '数据目录已经存在；为保护原ERP数据，不能覆盖。请使用全新目录'}
if($PgDatabase -cnotmatch '^wyerp_community_[a-z0-9_]+$' -or
   $PgUser -cnotmatch '^[a-z][a-z0-9_]{2,62}$' -or
   $PgMigrationUser -cnotmatch '^[a-z][a-z0-9_]{2,62}$'){
 throw '数据库须命名为wyerp_community_*，并使用独立的安全PostgreSQL角色名'
}
if($PgHostName -notin @('127.0.0.1','localhost','::1')){
 throw '社区初始化只允许本机数据库，禁止连接远程或原业务数据库'
}
function Read-SecurePlain([string]$caption){
 $sec=Read-Host -Prompt $caption -AsSecureString
 $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
 try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
 finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$sec.Dispose()}
}
$appPwd=''
$migPwd=''
if($PasswordFromEnvironment){
 $appPwd=[string]$env:WYERP_SETUP_APP_PASSWORD
 $migPwd=[string]$env:WYERP_SETUP_MIGRATION_PASSWORD
}else{
 $appPwd=Read-SecurePlain '请输入新建的PG运行账号密码（输入内容不会显示）'
 $migPwd=Read-SecurePlain '请输入新建的PG迁移账号密码（输入内容不会显示）'
}
if([string]::IsNullOrWhiteSpace($appPwd) -or [string]::IsNullOrWhiteSpace($migPwd)){
 throw '密码不能为空，尚未创建文件'
}
foreach($pwd in @($appPwd,$migPwd)){
 if($pwd.Contains('"') -or $pwd.Contains([string][char]96) -or $pwd.Contains([string][char]10) -or $pwd.Contains([string][char]13)){
  throw '为兼容Node环境文件，新PG密码暂不允许双引号、反引号或换行'
 }
}
$success=$false
try{
 $secretDir=Join-Path $root 'secrets'
 New-Item -ItemType Directory -Path $secretDir -Force |Out-Null
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 & icacls.exe $root '/inheritance:r' '/grant:r' "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' |Out-Null
 if($LASTEXITCODE -ne 0){throw 'Windows私有目录ACL失败'}
 function New-Key {
  $random=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$bytes=New-Object byte[] 32;$random.GetBytes($bytes);return ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()}
  finally{$random.Dispose()}
 }
 foreach($name in @('credentials.key','csrf.key','private-object.key')){
  [IO.File]::WriteAllText((Join-Path $secretDir $name),(New-Key)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 }
 $lines=@(
  'NODE_ENV=development',
  'ERP_HOST=127.0.0.1',
  'ERP_PORT=8765',
  'PUBLIC_ORIGIN=http://127.0.0.1:8765',
  ('ERP_DATA_DIR='+(Join-Path $root 'data')),
  ('ERP_PRIVATE_OBJECT_DIR='+(Join-Path $root 'private-objects')),
  ('PGHOST='+$PgHostName),
  ('PGPORT='+$PgPort),
  ('PGDATABASE='+$PgDatabase),
  ('PGUSER='+$PgUser),
  ('PGPASSWORD="'+$appPwd+'"'),
  ('PGMIGRATIONUSER='+$PgMigrationUser),
  ('PGMIGRATIONPASSWORD="'+$migPwd+'"'),
  'PGSSLMODE=disable',
  'SMTP_USER=',
  'SMTP_PASS=',
  'SMTP_FROM=',
  'BUG_REPORT_EMAIL=',
  'ERP_LEGACY_JSON_LAZY_IMPORT=0',
  'ERP_CHARGING_ENABLED=0',
  'ERP_PUBLIC_LAUNCH=0'
 )
 [IO.File]::WriteAllText((Join-Path $secretDir 'wyerp.env'),($lines -join [Environment]::NewLine)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 foreach($sub in @('data','private-objects','backups')){New-Item -ItemType Directory -Path (Join-Path $root $sub) -Force|Out-Null}
 $success=$true
 Write-Output ('PASS 新建隐私数据目录：'+$root)
 Write-Output 'PASS 独立生成3个随机密钥及本机配置（不显示明文，数据库账号需另行创建）'
 Write-Output 'NEXT 在本机PostgreSQL创建空数据库及对应的PG账号。随后运行doctor-local.ps1 -CheckDatabase'
 Write-Output 'NEXT 设置会话变量：$env:WYERP_LOCAL_DATA_ROOT = <上述目录>'
 Write-Output 'NEXT 运行迁移，再运行ERP的start.ps1（只绑定本机8765端口）'
}finally{
 $appPwd=$null;$migPwd=$null
 if(-not $success -and (Test-Path -LiteralPath $root)){Write-Warning '初始化中止。可能存在部分新文件；不会自动删除，以免误删'}
}