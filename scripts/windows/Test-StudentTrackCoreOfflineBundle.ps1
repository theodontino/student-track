#requires -Version 5.1

param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$ScratchRoot,
    [switch]$AllowGitHubActionsServerForCI
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($AllowGitHubActionsServerForCI) {
    $env:GITHUB_ACTIONS = "true"
}

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
    (Join-Path $packageRoot "app\node_modules\pdfjs-dist\legacy\build\pdf.mjs"),
    (Join-Path $packageRoot "app\node_modules\pdfjs-dist\legacy\build\pdf.worker.mjs"),
    (Join-Path $packageRoot "app\node_modules\pdfjs-dist\cmaps\Adobe-GB1-UCS2.bcmap"),
    (Join-Path $packageRoot "app\node_modules\pdfjs-dist\standard_fonts\LiberationSans-Regular.ttf"),
    (Join-Path $packageRoot "app\node_modules\pdfjs-dist\iccs\CGATS001Compat-v2-micro.icc"),
    (Join-Path $packageRoot "app\node_modules\pdfjs-dist\wasm\openjpeg.wasm"),
    (Join-Path $packageRoot "app\.next\BUILD_ID"),
    (Join-Path $packageRoot "app\src\generated\prisma\client.ts"),
    (Join-Path $packageRoot "app\scripts\windows\Uninstall-StudentTrackCore.ps1"),
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

& $installerCommand
if ($LASTEXITCODE -ne 0) {
    throw "离线安装器退出失败（退出码 $LASTEXITCODE）。"
}

$installedRoot = Join-Path $env:LOCALAPPDATA "Student Track"
foreach ($requiredPath in @(
    (Join-Path $installedRoot "app\.next\BUILD_ID"),
    (Join-Path $installedRoot "app\node_modules\prisma\build\index.js"),
    (Join-Path $installedRoot "app\node_modules\pdfjs-dist\legacy\build\pdf.mjs"),
    (Join-Path $installedRoot "app\node_modules\pdfjs-dist\legacy\build\pdf.worker.mjs"),
    (Join-Path $installedRoot "app\node_modules\pdfjs-dist\cmaps\Adobe-GB1-UCS2.bcmap"),
    (Join-Path $installedRoot "app\node_modules\pdfjs-dist\standard_fonts\LiberationSans-Regular.ttf"),
    (Join-Path $installedRoot "app\node_modules\pdfjs-dist\iccs\CGATS001Compat-v2-micro.icc"),
    (Join-Path $installedRoot "app\node_modules\pdfjs-dist\wasm\openjpeg.wasm"),
    (Join-Path $installedRoot "node\node.exe"),
    (Join-Path $installedRoot "Start Student Track Core.cmd"),
    (Join-Path $installedRoot "Uninstall Student Track Core.cmd"),
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

function Test-BundledPdfParser([string]$SessionCode) {
    Add-Type -AssemblyName System.Net.Http
    # Fixed ASCII PDF containing the supported report marker but intentionally no score summary.
    $pdfBytes = [Convert]::FromBase64String("JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9Db3VudCAxIC9LaWRzIFszIDAgUl0gPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxMDMgPj4Kc3RyZWFtCkJUCi9GMSAxMiBUZgo3MiA3MjAgVGQKKFBST0JMRU0gU0VUIFJFUE9SVCAyMDk5LzA3LzEzKSBUagowIC0xOCBUZAooU3ludGhldGljIGFzc2Vzc21lbnQgZml4dHVyZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzOTUgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0NjUKJSVFT0YK")
    $client = $null
    $multipart = $null
    $pdfResponse = $null
    try {
        $client = [System.Net.Http.HttpClient]::new()
        $multipart = [System.Net.Http.MultipartFormDataContent]::new()
        $sessionContent = [System.Net.Http.StringContent]::new($SessionCode)
        $pdfContent = [System.Net.Http.ByteArrayContent]::new($pdfBytes)
        $pdfContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/pdf")
        $multipart.Add($sessionContent, "sessionCode")
        $multipart.Add($pdfContent, "file", "synthetic-assessment.pdf")
        $pdfResponse = $client.PostAsync("http://127.0.0.1:3000/api/feedback/assessment-pdf", $multipart).GetAwaiter().GetResult()
        $pdfStatusCode = [int]$pdfResponse.StatusCode
        $pdfResponseBody = $pdfResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $pdfError = $pdfResponseBody | ConvertFrom-Json
        if ($pdfStatusCode -ne 400 -or $pdfError.error -ne "题集报告中未找到总题数或正确率") {
            throw "离线 Core 的 PDF.js 未能从固定合成 PDF 读取题集报告标识（HTTP $pdfStatusCode）：$pdfResponseBody"
        }
    } finally {
        if ($null -ne $pdfResponse) { $pdfResponse.Dispose() }
        if ($null -ne $multipart) { $multipart.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
    }
}

$server = $null
try {
    $server = Start-CoreServer
    Wait-CoreServer $server
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3000)
    if ($listeners.Count -eq 0 -or @($listeners | Where-Object LocalAddress -ne "127.0.0.1").Count -gt 0) {
        throw "离线 Core 生产服务存在非 127.0.0.1 的监听地址。"
    }
    $body = @{ name = "Offline Core CI Semester"; startDate = "2099-01-01"; endDate = "2099-06-30" } | ConvertTo-Json
    $created = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/semesters" -ContentType "application/json" -Body $body
    if (-not $created.id) {
        throw "离线 Core 生产服务未创建最小学期。"
    }
    $createdId = $created.id

    $classBody = @{ code = "OFFLINE-PDF-CLASS"; name = "Offline PDF Synthetic Class" } | ConvertTo-Json
    $createdClass = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/semesters/$createdId/classes" -ContentType "application/json" -Body $classBody
    if (-not $createdClass.id) {
        throw "离线 Core 生产服务未创建 PDF 验收班级。"
    }
    $sessionBody = @{ classId = $createdClass.id; date = "2099-02-01"; requestKey = "offline-core-pdf-session-1" } | ConvertTo-Json
    $createdSession = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/semesters/$createdId/session" -ContentType "application/json" -Body $sessionBody
    if (-not $createdSession.code) {
        throw "离线 Core 生产服务未创建 PDF 验收课次。"
    }
    Test-BundledPdfParser $createdSession.code

    Stop-CoreServer $server
    $server = $null

    $server = Start-CoreServer
    Wait-CoreServer $server
    $persisted = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:3000/api/semesters/$createdId"
    if ($persisted.id -ne $createdId) {
        throw "离线 Core 重启后未读到先前写入的学期。"
    }

    $preservationMarker = Join-Path $installedRoot "data\uninstall-preservation-marker.txt"
    Set-Content -LiteralPath $preservationMarker -Value "preserved runtime marker" -NoNewline -Encoding utf8
    Stop-CoreServer $server
    $server = $null

    $uninstaller = Join-Path $installedRoot "app\scripts\windows\Uninstall-StudentTrackCore.ps1"
    & $uninstaller -SkipConfirmation -SkipDesktopShortcut
    if (-not (Test-Path -LiteralPath (Join-Path $installedRoot "database\student-track.db") -PathType Leaf)) {
        throw "卸载器删除了应保留的数据库。"
    }
    if (-not (Test-Path -LiteralPath $preservationMarker -PathType Leaf)) {
        throw "卸载器删除了应保留的运行数据。"
    }
    foreach ($removedPath in @(
        (Join-Path $installedRoot "app"),
        (Join-Path $installedRoot "node"),
        (Join-Path $installedRoot "Start Student Track Core.cmd")
    )) {
        if (Test-Path -LiteralPath $removedPath) {
            throw "卸载器没有移除程序路径：$removedPath"
        }
    }

    & $installerCommand
    if ($LASTEXITCODE -ne 0) {
        throw "保留数据后的重新安装失败（退出码 $LASTEXITCODE）。"
    }
    $server = Start-CoreServer
    Wait-CoreServer $server
    $persistedAfterReinstall = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:3000/api/semesters/$createdId"
    if ($persistedAfterReinstall.id -ne $createdId) {
        throw "卸载并重新安装后未读到原学期。"
    }
} finally {
    Stop-CoreServer $server
}
