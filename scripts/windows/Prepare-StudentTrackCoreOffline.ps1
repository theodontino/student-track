#requires -Version 5.1

param([switch]$AllowGitHubActionsServerForCI)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "StudentTrack-Core.Common.ps1")

$tools = Assert-StudentTrackCorePrerequisites -AllowGitHubActionsServerForCI:$AllowGitHubActionsServerForCI
$runtime = Initialize-StudentTrackCoreEnvironment
$projectRoot = Get-StudentTrackProjectRoot
$prismaCli = Join-Path $projectRoot "node_modules\prisma\build\index.js"
$buildId = Join-Path $projectRoot ".next\BUILD_ID"
$requiredServerFiles = Join-Path $projectRoot ".next\required-server-files.json"
$generatedClient = Join-Path $projectRoot "src\generated\prisma\client.ts"

foreach ($requiredPath in @($prismaCli, $buildId, $requiredServerFiles, $generatedClient)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "离线包不完整，缺少必要文件：$requiredPath"
    }
}

$buildMetadata = Get-Content -LiteralPath $requiredServerFiles -Raw | ConvertFrom-Json
$buildEdition = $buildMetadata.config.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION
if ($buildEdition -ne "core") {
    throw "当前离线包不是 Student Track Core，请重新获取 Windows Core 安装包。"
}

Push-Location $projectRoot
try {
    $env:NPM_CONFIG_OFFLINE = "true"

    if ((Test-Path -LiteralPath $runtime.DatabasePath -PathType Leaf) -and (Get-Item -LiteralPath $runtime.DatabasePath).Length -gt 0) {
        Write-Host "检测到既有数据库，迁移前创建并校验备份。"
        Invoke-StudentTrackCommand -FilePath $tools.Npm -ArgumentList @("run", "db:backup")
        Invoke-StudentTrackCommand -FilePath $tools.Npm -ArgumentList @("run", "db:verify-backup")
    } elseif (-not (Test-Path -LiteralPath $runtime.DatabasePath -PathType Leaf)) {
        $database = [System.IO.File]::Open(
            $runtime.DatabasePath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $database.Dispose()
    }

    Invoke-StudentTrackCommand -FilePath $tools.Node -ArgumentList @($prismaCli, "migrate", "deploy")

    Write-Host "Student Track Core 离线包已准备完成。"
    Write-Host "运行数据：$($runtime.RuntimeRoot)"
} finally {
    Pop-Location
}
