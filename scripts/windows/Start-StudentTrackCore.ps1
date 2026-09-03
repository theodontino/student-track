#requires -Version 5.1

param([switch]$AllowGitHubActionsServerForCI)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "StudentTrack-Core.Common.ps1")

$tools = Assert-StudentTrackCorePrerequisites -AllowGitHubActionsServerForCI:$AllowGitHubActionsServerForCI
$runtime = Initialize-StudentTrackCoreEnvironment
$projectRoot = Get-StudentTrackProjectRoot
$buildId = Join-Path $projectRoot ".next\BUILD_ID"
$requiredServerFiles = Join-Path $projectRoot ".next\required-server-files.json"

if (-not (Test-Path -LiteralPath $runtime.DatabasePath -PathType Leaf)) {
    throw "尚未初始化数据库，请先运行 scripts\windows\Prepare-StudentTrackCore.ps1。"
}
if (-not (Test-Path -LiteralPath $buildId -PathType Leaf)) {
    throw "尚未生成生产构建，请先运行 scripts\windows\Prepare-StudentTrackCore.ps1。"
}
if (-not (Test-Path -LiteralPath $requiredServerFiles -PathType Leaf)) {
    throw "生产构建缺少版本信息，请重新运行 scripts\windows\Prepare-StudentTrackCore.ps1。"
}
$buildMetadata = Get-Content -LiteralPath $requiredServerFiles -Raw | ConvertFrom-Json
$buildEdition = $buildMetadata.config.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION
if ($buildEdition -ne "core") {
    throw "当前生产构建不是 Student Track Core，请重新运行 scripts\windows\Prepare-StudentTrackCore.ps1。"
}

$env:NODE_ENV = "production"
Push-Location $projectRoot
try {
    Write-Host "Student Track Core 将在 http://127.0.0.1:3000 启动。"
    Invoke-StudentTrackCommand -FilePath $tools.Npm -ArgumentList @(
        "run", "start", "--", "--hostname", "127.0.0.1", "--port", "3000"
    )
} finally {
    Pop-Location
}
