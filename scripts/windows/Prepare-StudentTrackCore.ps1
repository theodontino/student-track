#requires -Version 5.1

param([switch]$AllowGitHubActionsServerForCI)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "StudentTrack-Core.Common.ps1")

$tools = Assert-StudentTrackCorePrerequisites -AllowGitHubActionsServerForCI:$AllowGitHubActionsServerForCI
$runtime = Initialize-StudentTrackCoreEnvironment
$projectRoot = Get-StudentTrackProjectRoot
$prismaCli = Join-Path $projectRoot "node_modules\prisma\build\index.js"

Push-Location $projectRoot
try {
    Invoke-StudentTrackCommand -FilePath $tools.Npm -ArgumentList @("ci")

    if (-not (Test-Path -LiteralPath $prismaCli -PathType Leaf)) {
        throw "npm ci 完成后仍找不到 Prisma CLI：$prismaCli"
    }
    Invoke-StudentTrackCommand -FilePath $tools.Node -ArgumentList @($prismaCli, "generate")

    if (Test-Path -LiteralPath $runtime.DatabasePath -PathType Leaf) {
        if ((Get-Item -LiteralPath $runtime.DatabasePath).Length -gt 0) {
            Write-Host "检测到既有数据库，迁移前创建并校验备份。"
            Invoke-StudentTrackCommand -FilePath $tools.Npm -ArgumentList @("run", "db:backup")
            Invoke-StudentTrackCommand -FilePath $tools.Npm -ArgumentList @("run", "db:verify-backup")
        }
    } else {
        $database = [System.IO.File]::Open(
            $runtime.DatabasePath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $database.Dispose()
    }

    Invoke-StudentTrackCommand -FilePath $tools.Node -ArgumentList @($prismaCli, "migrate", "deploy")
    Invoke-StudentTrackCommand -FilePath $tools.Npm -ArgumentList @("run", "build")

    Write-Host "Student Track Core 已准备完成。"
    Write-Host "运行数据：$($runtime.RuntimeRoot)"
    Write-Host "下一步：运行 scripts\windows\Start-StudentTrackCore.ps1"
} finally {
    Pop-Location
}
