@echo off
cd /d %~dp0
rem Current beta launcher: 2 API nodes + 1 Worker (legacy start.ps1 stays opt-in).
set "ERP_CLUSTER_ENABLED=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
