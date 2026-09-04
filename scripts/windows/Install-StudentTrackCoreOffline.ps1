#requires -Version 5.1

param(
    [switch]$SkipDesktopShortcut,
    [switch]$AllowGitHubActionsServerForCI
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Student Track Core 离线安装包仅支持 Windows 10/11 x64。"
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "Windows 未提供 LOCALAPPDATA，无法确定 Student Track 安装目录。"
}

$packageRoot = $PSScriptRoot
$packageApp = Join-Path $packageRoot "app"
$packageNode = Join-Path $packageRoot "node"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "Student Track"
$appRoot = Join-Path $runtimeRoot "app"
$nodeRoot = Join-Path $runtimeRoot "node"
$runtimeDataRoots = @(
    (Join-Path $runtimeRoot "database"),
    (Join-Path $runtimeRoot "data"),
    (Join-Path $runtimeRoot "feedback-attachments"),
    (Join-Path $runtimeRoot "feedback-inbox"),
    (Join-Path $runtimeRoot "archives")
)

foreach ($requiredDirectory in @($packageApp, $packageNode)) {
    if (-not (Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
        throw "离线安装包不完整，缺少目录：$requiredDirectory"
    }
}

$env:PATH = "$packageNode;$env:PATH"
. (Join-Path $packageApp "scripts\windows\StudentTrack-Core.Common.ps1")
[void](Assert-StudentTrackCorePrerequisites -AllowGitHubActionsServerForCI:$AllowGitHubActionsServerForCI)

if (Test-Path -LiteralPath $runtimeRoot) {
    if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
        throw "Student Track 安装位置不是目录：$runtimeRoot"
    }
    if (@(Get-ChildItem -LiteralPath $runtimeRoot -Force).Count -gt 0) {
        throw "检测到已有 Student Track 程序或教学数据。离线包不会覆盖或恢复既有安装，请联系发布者获取升级或恢复方案。"
    }
}

function New-StudentTrackOfflineLauncher {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)

    $launcher = Join-Path $RuntimeRoot "Start Student Track Core.cmd"
    @(
        "@echo off",
        "setlocal EnableExtensions DisableDelayedExpansion",
        'set "PATH=%~dp0node;%PATH%"',
        'set "NPM_CONFIG_OFFLINE=true"',
        'if "%GITHUB_ACTIONS%"=="true" (',
        '  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\windows\Start-StudentTrackCore.ps1" -OfflineBundle -AllowGitHubActionsServerForCI',
        ') else (',
        '  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\windows\Start-StudentTrackCore.ps1" -OfflineBundle',
        ')',
        'set "START_EXIT_CODE=%ERRORLEVEL%"',
        'if "%GITHUB_ACTIONS%"=="true" exit /b %START_EXIT_CODE%',
        'pause',
        'exit /b %START_EXIT_CODE%'
    ) | Set-Content -LiteralPath $launcher -Encoding ascii
    return $launcher
}

[void](New-Item -ItemType Directory -Path $runtimeRoot -Force)
$installationStarted = $false
try {
    $installationStarted = $true
    Copy-Item -LiteralPath $packageApp -Destination $runtimeRoot -Recurse -Force
    Copy-Item -LiteralPath $packageNode -Destination $runtimeRoot -Recurse -Force

    $env:PATH = "$nodeRoot;$env:PATH"
    $env:NPM_CONFIG_OFFLINE = "true"
    $prepareScript = Join-Path $appRoot "scripts\windows\Prepare-StudentTrackCoreOffline.ps1"
    & $prepareScript -AllowGitHubActionsServerForCI:$AllowGitHubActionsServerForCI

    $launcher = New-StudentTrackOfflineLauncher -RuntimeRoot $runtimeRoot
} catch {
    if ($installationStarted) {
        foreach ($newProgramRoot in @($appRoot, $nodeRoot)) {
            if (Test-Path -LiteralPath $newProgramRoot) {
                Remove-Item -LiteralPath $newProgramRoot -Recurse -Force
            }
        }
        foreach ($newRuntimeDataRoot in $runtimeDataRoots) {
            if (Test-Path -LiteralPath $newRuntimeDataRoot) {
                Remove-Item -LiteralPath $newRuntimeDataRoot -Recurse -Force
            }
        }
        Write-Warning "离线安装未完成，已移除本次创建的程序和运行目录；既有教学数据没有改动。"
    }
    throw
}

if (-not $SkipDesktopShortcut) {
    $desktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
    if ([string]::IsNullOrWhiteSpace($desktopDirectory)) {
        Write-Warning "无法定位 Windows 桌面目录；可直接运行 $launcher。"
    } else {
        try {
            $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktopDirectory "Student Track Core.lnk"))
            $shortcut.TargetPath = $launcher
            $shortcut.WorkingDirectory = $runtimeRoot
            $shortcut.Save()
        } catch {
            Write-Warning "无法创建桌面快捷方式；可直接运行 $launcher。"
        }
    }
}

Write-Host "Student Track Core 离线安装完成。"
Write-Host "程序目录：$runtimeRoot"
if (-not $SkipDesktopShortcut) {
    Write-Host "以后请双击桌面的 Student Track Core 启动。"
}
