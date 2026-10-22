#Requires -Version 5.1
[CmdletBinding()]
param([string]$DataRoot)
$ErrorActionPreference = 'Stop'
$root = if ($DataRoot) {
    [IO.Path]::GetFullPath($DataRoot)
} elseif ($env:WYERP_LOCAL_DATA_ROOT) {
    [IO.Path]::GetFullPath($env:WYERP_LOCAL_DATA_ROOT)
} else {
    $persistent = [Environment]::GetEnvironmentVariable('WYERP_LOCAL_DATA_ROOT', 'User')
    if ($persistent) { [IO.Path]::GetFullPath($persistent) } else { '' }
}
if (-not $root) {
    throw '必须设置WYERP_LOCAL_DATA_ROOT或使用-DataRoot指定已初始化的数据目录；禁止自行创建空配置'
}
$envFile = Join-Path (Join-Path $root 'secrets') 'wyerp.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $legacy = Join-Path (Join-Path $root '配置') 'wyerp.env'
    if (Test-Path -LiteralPath $legacy -PathType Leaf) { $envFile = $legacy }
    else { throw '没有已有的wyerp.env；请先运行setup-local.ps1' }
}
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\') + '\'
if ([IO.Path]::GetFullPath($envFile).StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '私人配置文件必须位于Git仓库外'
}
$email = (Read-Host '请输入你自己的QQ SMTP发件邮箱').Trim()
if ($email -notmatch '^[^@\s]+@qq\.com$') { throw '当前脚本只支持QQ SMTP，请填写自己的邮箱地址' }
$secure = Read-Host '请输入自己的QQ SMTP授权码（输入不显示）' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$code = ''
try { $code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$secure.Dispose() }
if ([string]::IsNullOrWhiteSpace($code) -or $code.Contains('"') -or $code.Contains([string][char]96) -or $code.Contains([string][char]10) -or $code.Contains([string][char]13)) {
    throw 'SMTP授权码不能为空或包含引号、反引号、换行'
}
function Quote-Env([string]$value) { return '"' + $value.Replace('\','\\').Replace('"','\"') + '"' }
$original = [IO.File]::ReadAllText($envFile, [Text.Encoding]::UTF8)
$updates = [ordered]@{
 SMTP_HOST = 'smtp.qq.com'
 SMTP_PORT = '465'
 SMTP_SECURE = 'true'
 SMTP_USER = (Quote-Env $email)
 SMTP_PASS = (Quote-Env $code)
 SMTP_FROM = (Quote-Env $email)
 BUG_REPORT_EMAIL = (Quote-Env $email)
}
$seen = @{}
$output = [System.Collections.Generic.List[string]]::new()
foreach ($line in @($original -split '\r?\n')) {
    if ($line -match '^([A-Z][A-Z0-9_]*)=') {
        $name = $matches[1]
        if ($updates.Contains($name)) {
            if ($seen.ContainsKey($name)) { throw ('SMTP配置中有重复项：' + $name + '，已拒绝覆盖') }
            $seen[$name] = $true
            $output.Add($name + '=' + $updates[$name])
            continue
        }
    }
    $output.Add($line)
}
foreach ($name in $updates.Keys) { if (-not $seen.ContainsKey($name)) { $output.Add($name + '=' + $updates[$name]) } }
$replacement = ($output -join [Environment]::NewLine).TrimEnd([char]13,[char]10) + [Environment]::NewLine
$temp = Join-Path (Split-Path -Parent $envFile) ('wyerp.smtp.' + [Guid]::NewGuid().ToString('N') + '.tmp')
$backup = Join-Path (Split-Path -Parent $envFile) ('wyerp.smtp.previous.' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $acl = Get-Acl -LiteralPath $envFile
    $stream = [IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $writer = New-Object IO.StreamWriter($stream,[Text.UTF8Encoding]::new($false))
        try { $writer.Write($replacement);$writer.Flush() } finally { $writer.Dispose() }
    } finally { $stream.Dispose() }
    Set-Acl -LiteralPath $temp -AclObject $acl
    [IO.File]::Replace($temp,$envFile,$backup)
} finally {
    $code = $null
    $replacement = $null
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
}
Write-Output 'PASS 仅更新SMTP配置；原数据库和加密设置保持不变。请重启ERP并测试发件。'
