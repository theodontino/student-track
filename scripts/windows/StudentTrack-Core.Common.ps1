#requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-StudentTrackProjectRoot {
    $projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "package.json") -PathType Leaf)) {
        throw "找不到 Student Track 项目根目录：$projectRoot"
    }
    return $projectRoot
}

function Assert-StudentTrackCorePrerequisites {
    param([switch]$AllowGitHubActionsServerForCI)

    if ($env:OS -ne "Windows_NT") {
        throw "Student Track Core 准备脚本仅支持 Windows 10/11 x64。"
    }

    $windows = Get-CimInstance -ClassName Win32_OperatingSystem
    if ($windows.OSArchitecture -notmatch "64") {
        throw "仅支持 Windows 10/11 x64；当前系统为 $($windows.Caption) $($windows.OSArchitecture)。"
    }
    $supportedClient = $windows.Caption -match "Windows (10|11)"
    $githubServerTest = (
        $AllowGitHubActionsServerForCI
        -and $env:GITHUB_ACTIONS -eq "true"
        -and $windows.Caption -match "Windows Server"
    )
    if (-not $supportedClient -and -not $githubServerTest) {
        throw "仅支持 Windows 10/11 x64；当前系统为 $($windows.Caption) $($windows.OSArchitecture)。"
    }

    $node = Get-Command node.exe -ErrorAction Stop
    $nodeVersion = (& $node.Source --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch "^v24\.") {
        throw "需要 Node.js 24 x64；当前版本为 $nodeVersion。"
    }
    $nodeArchitecture = (& $node.Source -p "process.arch").Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeArchitecture -ne "x64") {
        throw "需要 Node.js 24 x64；当前 Node 架构为 $nodeArchitecture。"
    }

    $npm = Get-Command npm.cmd -ErrorAction Stop
    $npmVersion = (& $npm.Source --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $npmVersion -notmatch "^11\.") {
        throw "需要 npm 11；当前版本为 $npmVersion。"
    }

    return [PSCustomObject]@{
        Node = $node.Source
        Npm = $npm.Source
    }
}

function ConvertTo-StudentTrackFileUrl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $absolutePath = [System.IO.Path]::GetFullPath($Path)
    return ([System.Uri]::new($absolutePath)).AbsoluteUri
}

function Initialize-StudentTrackCoreEnvironment {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "Windows 未提供 LOCALAPPDATA，无法确定 Student Track 运行目录。"
    }

    $runtimeRoot = Join-Path $env:LOCALAPPDATA "Student Track"
    $databaseRoot = Join-Path $runtimeRoot "database"
    $dataRoot = Join-Path $runtimeRoot "data"
    $attachmentRoot = Join-Path $runtimeRoot "feedback-attachments"
    $inboxRoot = Join-Path $runtimeRoot "feedback-inbox"
    $archiveRoot = Join-Path $runtimeRoot "archives"

    foreach ($directory in @($runtimeRoot, $databaseRoot, $dataRoot, $attachmentRoot, $inboxRoot, $archiveRoot)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }

    $databasePath = Join-Path $databaseRoot "student-track.db"
    $env:STUDENT_TRACK_EDITION = "core"
    $env:STUDENT_TRACK_RUNTIME_ROOT = $runtimeRoot
    $env:STUDENT_TRACK_DATA_ROOT = $dataRoot
    $env:STUDENT_TRACK_ARCHIVES_ROOT = $archiveRoot
    $env:STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT = $attachmentRoot
    $env:STUDENT_TRACK_FEEDBACK_INBOX_ROOT = $inboxRoot
    $env:DATABASE_URL = ConvertTo-StudentTrackFileUrl -Path $databasePath
    $env:NEXT_TELEMETRY_DISABLED = "1"

    return [PSCustomObject]@{
        RuntimeRoot = $runtimeRoot
        DatabasePath = $databasePath
        ArchiveRoot = $archiveRoot
    }
}

function Invoke-StudentTrackCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "命令执行失败（退出码 $LASTEXITCODE）：$FilePath $($ArgumentList -join ' ')"
    }
}
