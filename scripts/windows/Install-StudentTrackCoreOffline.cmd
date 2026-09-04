@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Student Track Core Offline Installer

echo Installing Student Track Core from this offline package...
if "%GITHUB_ACTIONS%"=="true" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-StudentTrackCoreOffline.ps1" -AllowGitHubActionsServerForCI
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-StudentTrackCoreOffline.ps1"
)
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"
if not "%INSTALL_EXIT_CODE%"=="0" goto :install_failed

echo.
echo Installation finished. Use the Student Track Core desktop shortcut to start it.
if "%GITHUB_ACTIONS%"=="true" exit /b 0
pause
exit /b 0

:install_failed
echo.
echo Installation did not finish. Read the message above; content created by this attempt was removed and existing teaching data was preserved.
if "%GITHUB_ACTIONS%"=="true" exit /b %INSTALL_EXIT_CODE%
pause
exit /b %INSTALL_EXIT_CODE%
