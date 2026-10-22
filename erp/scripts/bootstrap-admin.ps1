#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [switch]$PromptForPassword
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DataRoot)
$envFile = Join-Path $root 'secrets/wyerp.env'
$secretDir = Join-Path $root 'secrets'
$record = Join-Path $secretDir 'initial-admin-password.txt'
if (!(Test-Path -LiteralPath $envFile -PathType Leaf)) {
  throw '缺少新电脑的秘密配置文件。请先运行setup-local.ps1，创建全新数据根目录'
}
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($root.StartsWith([IO.Path]::GetFullPath($repoRoot).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) {
  throw '出于安全，禁止把管理员密码文件创建在Git仓库内'
}
$node = Get-Command node.exe -ErrorAction Stop
$secure = $null
$ptr = [IntPtr]::Zero
$generated = $false
$success = $false
$password = $null
try {
  if ($PromptForPassword) {
    $secure = Read-Host -Prompt '请输入全新admin密码（至少12位，输入不显示）' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } else {
    if (Test-Path -LiteralPath $record) {
      throw '已存在初始化管理员密码文件，拒绝覆盖。若已有admin请直接登录，不得重建或重置；如未初始化请先人工核对'
    }
    # Cryptographically strong 32-byte one-time password; 43 URL-safe characters.
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $bytes = New-Object byte[] 32
      $rng.GetBytes($bytes)
      $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    } finally { $rng.Dispose() }
    # Make a private, exclusive, non-overwritable record BEFORE committing DB admin.
    # Only the local interactive account and Windows SYSTEM may read it.
    $stream = [IO.File]::Open($record,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
      $writer = New-Object IO.StreamWriter($stream,[Text.UTF8Encoding]::new($false))
      try { $writer.WriteLine('username=admin');$writer.WriteLine('password='+$password);$writer.Flush() }
      finally { $writer.Dispose() }
    } finally { $stream.Dispose() }
    $generated = $true
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $record '/inheritance:r' '/grant:r' "*$($sid):F" '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw '管理员密码文件访问权限设置失败；拒绝创建管理员'
    }
  }
  if ([string]::IsNullOrWhiteSpace($password) -or $password.Length -lt 12 -or $password.Length -gt 128) {
    throw '管理员密码应为12-128字符，未执行任何管理员创建操作'
  }
  $env:WYERP_BOOTSTRAP_ADMIN_PASSWORD = $password
  $scriptFile = Join-Path $PSScriptRoot 'bootstrap-admin.js'
  & $node.Source "--env-file-if-exists=$envFile" $scriptFile '--confirm-empty-database'
  if ($LASTEXITCODE -ne 0) {
    throw '管理员初始化未通过：请先完成新数据库迁移，并确认是完全空白的本机社区数据库'
  }
  $success = $true
  Write-Output 'PASS 已为全新空库创建唯一系统管理员：admin'
  if ($generated) {
    Write-Output ('管理员密码已随机生成，**仅保存在本机**：'+$record)
    Write-Output '请在新机由使用者本人查看此文件并妥善保存。确认登录成功后删除一次性密码文件，不要上传或发到聊天中'
  } else {
    Write-Output '使用刚才人工输入的密码登录；脚本未保存或显示该密码'
  }
} finally {
  Remove-Item Env:\WYERP_BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $password = $null
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($null -ne $secure) { $secure.Dispose() }
  if ($generated -and -not $success -and (Test-Path -LiteralPath $record)) {
    Remove-Item -LiteralPath $record -Force
    Write-Warning '管理员创建失败；已清理此次新生成的临时密码文件，未变更已有用户密码'
  }
}