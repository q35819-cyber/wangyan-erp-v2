@echo off
chcp 65001 >nul
set "SCRIPT=%~dp0tools\Install-Collector.ps1"
if not exist "%SCRIPT%" (
 echo ERROR: Cannot find Install-Collector.ps1.
 pause
 exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Installer helper failed. Please read the details above.
pause
exit /b %RESULT%