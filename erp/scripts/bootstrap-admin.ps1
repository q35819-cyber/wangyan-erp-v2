#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$DataRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($DataRoot)
$envFile=Join-Path $root 'secrets/wyerp.env'
if(!(Test-Path -LiteralPath $envFile -PathType Leaf)){throw '缺少新电脑的秘密配置文件；先执行setup-local.ps1'}
$node=Get-Command node.exe -ErrorAction Stop
$sec=Read-Host -Prompt '设置全新社区环境唯一admin密码（至少12位，不显示输入）' -AsSecureString
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try{
 $env:WYERP_BOOTSTRAP_ADMIN_PASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
 $script=Join-Path $PSScriptRoot 'bootstrap-admin.js'
 & $node.Source "--env-file-if-exists=$envFile" $script '--confirm-empty-database'
 $result=$LASTEXITCODE
 if($result -ne 0){throw 'admin初始化失败；未验证当前新数据库或全部Schema迁移，请根据错误处理，不要手动插入数据库'}
 Write-Output 'PASS 新环境管理员初始化命令已完成，请到ERP登录页实际登录验证'
}finally{
 Remove-Item Env:\WYERP_BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
 $sec.Dispose()
}