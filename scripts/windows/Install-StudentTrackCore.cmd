@echo off
setlocal
title Student Track Core Installer

set "INSTALLER_URL=https://github.com/theodontino/student-track/releases/download/v1.3.0-beta.2/Install-StudentTrackCore.ps1"
set "INSTALLER_PATH=%TEMP%\Install-StudentTrackCore-v1.3.0-beta.2.ps1"

echo Downloading Student Track Core installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%INSTALLER_URL%' -OutFile '%INSTALLER_PATH%'"
if errorlevel 1 goto :download_failed

echo Starting installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER_PATH%"
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
exit /b 1

:install_failed
echo.
echo Installation did not finish. Read the message above, then try again.
pause
exit /b %INSTALL_EXIT_CODE%
