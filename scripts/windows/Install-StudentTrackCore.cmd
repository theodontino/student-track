@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Student Track Core Installer

set "ST_BOOTSTRAP_URL=https://github.com/theodontino/student-track/releases/download/v1.3.0-beta.5/Install-StudentTrackCore.ps1"
set "ST_BOOTSTRAP_FILE=%TEMP%\Install-StudentTrackCore-v1.3.0-beta.5.ps1"

echo Downloading Student Track Core installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Remove-Item -LiteralPath $env:ST_BOOTSTRAP_FILE -Force -ErrorAction SilentlyContinue; Invoke-WebRequest -UseBasicParsing -Uri $env:ST_BOOTSTRAP_URL -OutFile $env:ST_BOOTSTRAP_FILE } catch { Write-Error $_; exit 1 }"
set "DOWNLOAD_EXIT_CODE=%ERRORLEVEL%"
if not "%DOWNLOAD_EXIT_CODE%"=="0" goto :download_failed

echo Starting installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ST_BOOTSTRAP_FILE%"
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"
if not "%INSTALL_EXIT_CODE%"=="0" goto :install_failed

echo.
echo Installation finished. Use the Student Track Core desktop shortcut to start it.
pause
exit /b 0

:download_failed
echo.
echo Download failed. Check the Internet connection and try again.
pause
exit /b %DOWNLOAD_EXIT_CODE%

:install_failed
echo.
echo Installation did not finish. Read the message above, then try again.
pause
exit /b %INSTALL_EXIT_CODE%
