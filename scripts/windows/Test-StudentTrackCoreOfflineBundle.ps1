#requires -Version 5.1

param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$ScratchRoot,
    [switch]$AllowGitHubActionsServerForCI
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$archivePath = (Resolve-Path -LiteralPath $ArchivePath).Path
$scratchRoot = [System.IO.Path]::GetFullPath($ScratchRoot)
if (Test-Path -LiteralPath $scratchRoot) {
    if ((Get-ChildItem -LiteralPath $scratchRoot -Force | Measure-Object).Count -gt 0) {
        throw "离线包验收目录必须为空：$scratchRoot"
    }
} else {
    [void](New-Item -ItemType Directory -Path $scratchRoot -Force)
}

$expandedRoot = Join-Path $scratchRoot "expanded"
Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedRoot -Force
$packageRoot = Join-Path $expandedRoot "StudentTrackCore"
$installer = Join-Path $packageRoot "Install-StudentTrackCoreOffline.ps1"
$installerCommand = Join-Path $packageRoot "Install-StudentTrackCoreOffline.cmd"

foreach ($requiredPath in @(
    $installer,
    $installerCommand,
    (Join-Path $packageRoot "LICENSE"),
    (Join-Path $packageRoot "source"),
    (Join-Path $packageRoot "app\node_modules"),
    (Join-Path $packageRoot "app\.next\BUILD_ID"),
    (Join-Path $packageRoot "app\src\generated\prisma\client.ts"),
    (Join-Path $packageRoot "node\node.exe"),
    (Join-Path $packageRoot "node\npm.cmd")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "离线包缺少必要文件：$requiredPath"
    }
}

foreach ($forbiddenPath in @(
    "app\data",
    "app\archives",
    "app\dev.db",
    "app\.env",
    "app\.git",
    "app\.next\dev",
    "app\.next\cache"
)) {
    if (Test-Path -LiteralPath (Join-Path $packageRoot $forbiddenPath)) {
        throw "离线包包含不应发布的路径：$forbiddenPath"
    }
}

$env:LOCALAPPDATA = Join-Path $scratchRoot "local-app-data"
$env:PATH = "$(Join-Path $packageRoot 'node');$env:PATH"
$env:NPM_CONFIG_OFFLINE = "true"
$env:HTTP_PROXY = "http://127.0.0.1:9"
$env:HTTPS_PROXY = "http://127.0.0.1:9"
$env:NO_PROXY = "127.0.0.1,localhost"

$installerArguments = '/d /c ""' + $installerCommand + '""'
$installerProcess = Start-Process -FilePath "cmd.exe" -ArgumentList $installerArguments -NoNewWindow -Wait -PassThru
if ($installerProcess.ExitCode -ne 0) {
    throw "离线安装器退出失败（退出码 $($installerProcess.ExitCode)）。"
}

$installedRoot = Join-Path $env:LOCALAPPDATA "Student Track"
foreach ($requiredPath in @(
    (Join-Path $installedRoot "app\.next\BUILD_ID"),
    (Join-Path $installedRoot "app\node_modules\prisma\build\index.js"),
    (Join-Path $installedRoot "node\node.exe"),
    (Join-Path $installedRoot "Start Student Track Core.cmd"),
    (Join-Path $installedRoot "database\student-track.db")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "离线安装未写入必要文件：$requiredPath"
    }
}

$env:PATH = "$(Join-Path $installedRoot 'node');$env:PATH"
$launcher = Join-Path $installedRoot "Start Student Track Core.cmd"
$stdout = Join-Path $scratchRoot "student-track-core.stdout.log"
$stderr = Join-Path $scratchRoot "student-track-core.stderr.log"

function Start-CoreServer {
    $launcherArguments = '/d /c ""' + $launcher + '""'
    return Start-Process -FilePath "cmd.exe" -ArgumentList $launcherArguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
}

function Show-CoreServerLogs {
    Write-Host "::group::Offline Student Track Core stdout"
    if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Tail 200 }
    Write-Host "::endgroup::"
    Write-Host "::group::Offline Student Track Core stderr"
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Tail 200 }
    Write-Host "::endgroup::"
}

function Wait-CoreServer([System.Diagnostics.Process]$Process) {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 60) {
        $Process.Refresh()
        if ($Process.HasExited) {
            Show-CoreServerLogs
            throw "离线 Core 启动进程提前退出（退出码 $($Process.ExitCode)）。"
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000/api/semesters" -TimeoutSec 1
            if ($response.StatusCode -eq 200) { return }
        } catch {}
        Start-Sleep -Seconds 1
    }
    Show-CoreServerLogs
    throw "离线 Core 未在 60 秒内启动。"
}

function Stop-CoreServer([System.Diagnostics.Process]$Process) {
    if ($null -ne $Process -and -not $Process.HasExited) {
        & taskkill.exe /PID $Process.Id /T /F | Out-Null
        $Process.WaitForExit()
    }
}

$server = $null
try {
    $server = Start-CoreServer
    Wait-CoreServer $server
    $body = @{ name = "Offline Core CI Semester"; startDate = "2099-01-01"; endDate = "2099-06-30" } | ConvertTo-Json
    $created = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/semesters" -ContentType "application/json" -Body $body
    if (-not $created.id) {
        throw "离线 Core 生产服务未创建最小学期。"
    }
    $createdId = $created.id
    Stop-CoreServer $server
    $server = $null

    $server = Start-CoreServer
    Wait-CoreServer $server
    $persisted = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:3000/api/semesters/$createdId"
    if ($persisted.id -ne $createdId) {
        throw "离线 Core 重启后未读到先前写入的学期。"
    }
} finally {
    Stop-CoreServer $server
}
