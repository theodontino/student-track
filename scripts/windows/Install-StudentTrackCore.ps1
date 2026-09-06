#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ReleaseTag = "v1.3.0-beta.5",
    [switch]$NoDesktopShortcut
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repository = "theodontino/student-track"

function Assert-StudentTrackWindowsClient {
    if ($env:OS -ne "Windows_NT") {
        throw "Student Track Core 安装器仅支持 Windows 10/11 x64。"
    }

    $windows = Get-CimInstance -ClassName Win32_OperatingSystem
    if ($windows.Caption -notmatch "Windows (10|11)" -or $windows.OSArchitecture -notmatch "64" -or $windows.OSArchitecture -match "ARM") {
        throw "仅支持 Windows 10/11 x64；当前系统为 $($windows.Caption) $($windows.OSArchitecture)。"
    }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "Windows 未提供 LOCALAPPDATA，无法确定 Student Track 安装位置。"
    }
}

function Invoke-StudentTrackDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

function Get-LatestNode24Release {
    $releases = @(Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json")
    $release = @($releases | Where-Object {
        $_.version -match "^v24\." -and $_.files -contains "win-x64-zip"
    } | Select-Object -First 1)[0]

    if ($null -eq $release) {
        throw "无法从 Node.js 官方发布列表找到 Node.js 24 x64。"
    }
    return $release
}

function Assert-PortableNode {
    param([Parameter(Mandatory = $true)][string]$NodeRoot)

    $node = Join-Path $NodeRoot "node.exe"
    $npm = Join-Path $NodeRoot "npm.cmd"
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $npm -PathType Leaf)) {
        throw "Node.js 运行时不完整：$NodeRoot"
    }

    $version = (& $node --version).Trim()
    $architecture = (& $node -p "process.arch").Trim()
    $npmVersion = (& $npm --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch "^v24\." -or $architecture -ne "x64" -or $npmVersion -notmatch "^11\.") {
        throw "需要 Node.js 24 x64 和 npm 11；当前为 $version / $architecture / npm $npmVersion。"
    }
}

function Install-PortableNode {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$TemporaryRoot
    )

    $nodeRoot = Join-Path $RuntimeRoot "node"
    if (Test-Path -LiteralPath $nodeRoot) {
        Assert-PortableNode -NodeRoot $nodeRoot
        return $nodeRoot
    }

    $release = Get-LatestNode24Release
    $archiveName = "node-$($release.version)-win-x64.zip"
    $archivePath = Join-Path $TemporaryRoot $archiveName
    Invoke-StudentTrackDownload -Uri "https://nodejs.org/dist/$($release.version)/$archiveName" -Destination $archivePath

    $extractRoot = Join-Path $TemporaryRoot "node"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    $extracted = @(Get-ChildItem -LiteralPath $extractRoot -Directory)
    if ($extracted.Count -ne 1) {
        throw "Node.js 安装包结构不符合预期。"
    }
    Move-Item -LiteralPath $extracted[0].FullName -Destination $nodeRoot
    Assert-PortableNode -NodeRoot $nodeRoot
    return $nodeRoot
}

function Install-StudentTrackSource {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$TemporaryRoot,
        [Parameter(Mandatory = $true)][string]$Tag
    )

    $appRoot = Join-Path $RuntimeRoot "app"
    if (Test-Path -LiteralPath $appRoot) {
        throw "检测到现有安装：$appRoot。新安装器不会覆盖已有程序或数据。"
    }

    $archivePath = Join-Path $TemporaryRoot "student-track-$Tag.zip"
    Invoke-StudentTrackDownload -Uri "https://github.com/$Repository/archive/refs/tags/$Tag.zip" -Destination $archivePath

    $extractRoot = Join-Path $TemporaryRoot "app"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    $projects = @(Get-ChildItem -LiteralPath $extractRoot -Directory | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName "package.json") -PathType Leaf
    })
    if ($projects.Count -ne 1) {
        throw "Student Track 发布包结构不符合预期。"
    }
    Move-Item -LiteralPath $projects[0].FullName -Destination $appRoot
    return $appRoot
}

function New-StudentTrackLauncher {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)

    $launcher = Join-Path $RuntimeRoot "Start Student Track Core.cmd"
    @(
        "@echo off",
        "setlocal",
        'set "PATH=%~dp0node;%PATH%"',
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\windows\Start-StudentTrackCore.ps1"',
        "pause"
    ) | Set-Content -LiteralPath $launcher -Encoding ASCII
    return $launcher
}

function New-StudentTrackUninstallLauncher {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)

    $launcher = Join-Path $RuntimeRoot "Uninstall Student Track Core.cmd"
    @(
        "@echo off",
        "setlocal EnableExtensions DisableDelayedExpansion",
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\windows\Uninstall-StudentTrackCore.ps1"',
        'set "UNINSTALL_EXIT_CODE=%ERRORLEVEL%"',
        'if "%UNINSTALL_EXIT_CODE%"=="0" del /f /q "%~f0"',
        'if not "%UNINSTALL_EXIT_CODE%"=="0" pause',
        'exit /b %UNINSTALL_EXIT_CODE%'
    ) | Set-Content -LiteralPath $launcher -Encoding ASCII
    return $launcher
}

function New-StudentTrackDesktopShortcut {
    param([Parameter(Mandatory = $true)][string]$Launcher)

    $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        return
    }
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "Student Track Core.lnk"))
    $shortcut.TargetPath = $Launcher
    $shortcut.WorkingDirectory = Split-Path -Parent $Launcher
    $shortcut.Save()
}

Assert-StudentTrackWindowsClient
if ($ReleaseTag -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+") {
    throw "ReleaseTag 格式无效：$ReleaseTag"
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$runtimeRoot = Join-Path $env:LOCALAPPDATA "Student Track"
[void](New-Item -ItemType Directory -Path $runtimeRoot -Force)
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "student-track-install-$PID"
[void](New-Item -ItemType Directory -Path $temporaryRoot -Force)

try {
    $nodeRoot = Install-PortableNode -RuntimeRoot $runtimeRoot -TemporaryRoot $temporaryRoot
    $env:Path = "$nodeRoot;$env:Path"
    $appRoot = Install-StudentTrackSource -RuntimeRoot $runtimeRoot -TemporaryRoot $temporaryRoot -Tag $ReleaseTag
    $prepare = Join-Path $appRoot "scripts\windows\Prepare-StudentTrackCore.ps1"
    & $prepare

    $launcher = New-StudentTrackLauncher -RuntimeRoot $runtimeRoot
    $uninstallLauncher = New-StudentTrackUninstallLauncher -RuntimeRoot $runtimeRoot
    if (-not $NoDesktopShortcut) {
        New-StudentTrackDesktopShortcut -Launcher $launcher
    }

    Write-Host "Student Track Core 已安装完成。"
    Write-Host "程序目录：$appRoot"
    Write-Host "数据目录：$runtimeRoot"
    Write-Host "启动方式：双击 $launcher，或桌面上的 Student Track Core。"
    Write-Host "卸载方式：双击 $uninstallLauncher；教学数据库和运行数据会保留。"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
