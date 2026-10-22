$ErrorActionPreference = 'Stop'

$email = (Read-Host '请输入用于发信的 QQ 邮箱').Trim()
if ($email -notmatch '^[^\s@]+@qq\.com$') {
    throw '请输入完整的 QQ 邮箱地址，请填写你自己的邮箱地址。'
}

$secureCode = Read-Host '请输入 QQ 邮箱 SMTP 授权码（输入时不会显示）' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCode)
try {
    $authorizationCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

if ([string]::IsNullOrWhiteSpace($authorizationCode) -or $authorizationCode -match '[\r\n]') {
    throw 'SMTP 授权码不能为空，也不能包含换行。'
}

function ConvertTo-EnvQuotedValue([string]$value) {
    return '"' + $value.Replace('\', '\\').Replace('"', '\"') + '"'
}

$localFolder = -join @([char]0x672C, [char]0x673A, [char]0x6570, [char]0x636E)
$configFolder = -join @([char]0x914D, [char]0x7F6E)
$configuredDataRoot = if ($env:WYERP_LOCAL_DATA_ROOT) {
    $env:WYERP_LOCAL_DATA_ROOT
} else {
    [Environment]::GetEnvironmentVariable('WYERP_LOCAL_DATA_ROOT', 'User')
}
$secretDirectory = if ($configuredDataRoot) {
    [IO.Path]::GetFullPath((Join-Path $configuredDataRoot 'secrets'))
} else {
    [IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $PSScriptRoot '..') $localFolder) $configFolder))
}
$environmentFile = Join-Path $secretDirectory 'wyerp.env'
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null

$lines = @(
    'SMTP_HOST=smtp.qq.com'
    'SMTP_PORT=465'
    'SMTP_SECURE=true'
    ('SMTP_USER=' + (ConvertTo-EnvQuotedValue $email))
    ('SMTP_PASS=' + (ConvertTo-EnvQuotedValue $authorizationCode))
    ('SMTP_FROM=' + (ConvertTo-EnvQuotedValue $email))
    ('BUG_REPORT_EMAIL=' + (ConvertTo-EnvQuotedValue $email))
)
[IO.File]::WriteAllLines($environmentFile, $lines, [Text.UTF8Encoding]::new($false))

& icacls.exe $environmentFile /inheritance:r /grant:r "$env:USERNAME`:(R,W)" 'SYSTEM:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'SMTP 配置已写入，但收紧文件权限失败，请检查该文件的访问权限。'
}

$authorizationCode = $null
Write-Host "配置完成：$environmentFile"
Write-Host '请关闭当前网研ERP服务，再双击 start.bat 重新启动。'
