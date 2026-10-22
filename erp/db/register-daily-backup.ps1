param([string]$At = '03:00')
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'backup-if-needed.ps1'
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '"'
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'WyerpDailyBackup' -Description 'Wyerp daily PostgreSQL backup check; skips when a complete backup already exists today.' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "Scheduled task WyerpDailyBackup registered at $At."
