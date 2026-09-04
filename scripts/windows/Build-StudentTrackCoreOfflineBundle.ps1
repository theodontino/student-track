#requires -Version 5.1

param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$packagePath = Join-Path $projectRoot "package.json"
$nodeModules = Join-Path $projectRoot "node_modules"
$nextRoot = Join-Path $projectRoot ".next"
$generatedClient = Join-Path $projectRoot "src\generated\prisma\client.ts"
$requiredServerFiles = Join-Path $nextRoot "required-server-files.json"
$buildId = Join-Path $nextRoot "BUILD_ID"

foreach ($requiredPath in @($packagePath, $nodeModules, $generatedClient, $requiredServerFiles, $buildId)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "离线包只能从已完成依赖安装、Prisma 生成和 Core 生产构建的工作区创建；缺少：$requiredPath"
    }
}
if ($env:STUDENT_TRACK_EDITION -ne "core") {
    throw "离线包只能从 STUDENT_TRACK_EDITION=core 的生产构建创建。"
}
if (Test-Path -LiteralPath (Join-Path $nextRoot "dev")) {
    throw "离线包不能包含 .next\dev；请从干净的 Core 生产构建创建。"
}

$buildMetadata = Get-Content -LiteralPath $requiredServerFiles -Raw | ConvertFrom-Json
if ($buildMetadata.config.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION -ne "core") {
    throw "当前生产构建不是 Student Track Core。"
}

$nodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$nodeVersion = (& $nodeExecutable --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch "^v24\.") {
    throw "离线包需要 Node.js 24 x64；当前为 $nodeVersion。"
}
$nodeArchitecture = (& $nodeExecutable -p "process.arch").Trim()
if ($LASTEXITCODE -ne 0 -or $nodeArchitecture -ne "x64") {
    throw "离线包需要 Node.js 24 x64；当前架构为 $nodeArchitecture。"
}

$git = Get-Command git.exe -ErrorAction Stop
$workingTreeState = @(& $git.Source -C $projectRoot status --porcelain)
if ($LASTEXITCODE -ne 0) {
    throw "无法检查离线包对应的 Git 工作区。"
}
if ($workingTreeState.Count -gt 0) {
    throw "离线包只能从干净的已提交工作区创建。"
}
$sourceCommit = (& $git.Source -C $projectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "无法读取离线包对应的 Git 提交。"
}

$outputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputDirectory) {
    if ((Get-ChildItem -LiteralPath $outputDirectory -Force | Measure-Object).Count -gt 0) {
        throw "离线包输出目录必须为空：$outputDirectory"
    }
} else {
    [void](New-Item -ItemType Directory -Path $outputDirectory -Force)
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = $package.version

$stageRoot = Join-Path $outputDirectory "stage"
$bundleRoot = Join-Path $stageRoot "StudentTrackCore"
$bundleApp = Join-Path $bundleRoot "app"
$bundleNode = Join-Path $bundleRoot "node"
$sourceArchive = Join-Path $stageRoot "student-track-source.zip"
$archivePath = Join-Path $outputDirectory "StudentTrackCore-Windows-x64-$version.zip"

[void](New-Item -ItemType Directory -Path $bundleApp -Force)
[void](New-Item -ItemType Directory -Path $bundleNode -Force)

& $git.Source -C $projectRoot archive --format=zip "--output=$sourceArchive" HEAD
if ($LASTEXITCODE -ne 0) {
    throw "无法生成离线包对应源码。"
}
Expand-Archive -LiteralPath $sourceArchive -DestinationPath $bundleApp -Force

Copy-Item -LiteralPath $nodeModules -Destination $bundleApp -Recurse -Force
$generatedClientRoot = Join-Path $projectRoot "src\generated\prisma"
$bundleGeneratedPrisma = Join-Path $bundleApp "src\generated\prisma"
[void](New-Item -ItemType Directory -Path $bundleGeneratedPrisma -Force)
Copy-Item -Path (Join-Path $generatedClientRoot "*") -Destination $bundleGeneratedPrisma -Recurse -Force
& robocopy.exe $nextRoot (Join-Path $bundleApp ".next") /E /XD cache dev /NFL /NDL /NJH /NJS | Out-Null
$robocopyExitCode = $LASTEXITCODE
if ($robocopyExitCode -gt 7) {
    throw "复制 Core 生产构建失败（robocopy 退出码 $robocopyExitCode）。"
}
# Robocopy 将 1 视为成功复制；不要让该成功码误导调用方。
$global:LASTEXITCODE = 0

$nodeRoot = Split-Path -Parent $nodeExecutable
Copy-Item -Path (Join-Path $nodeRoot "*") -Destination $bundleNode -Recurse -Force

foreach ($installer in @("Install-StudentTrackCoreOffline.ps1", "Install-StudentTrackCoreOffline.cmd")) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $installer) -Destination $bundleRoot -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination $bundleRoot -Force

$sourceDirectory = Join-Path $bundleRoot "source"
[void](New-Item -ItemType Directory -Path $sourceDirectory -Force)
Copy-Item -LiteralPath $sourceArchive -Destination (Join-Path $sourceDirectory "student-track-$version-source.zip") -Force

$buildInfo = [ordered]@{
    product = "Student Track Core"
    version = $version
    edition = "core"
    sourceCommit = $sourceCommit
    nodeVersion = $nodeVersion
}
$buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bundleRoot "BUILD-INFO.json") -Encoding utf8

foreach ($forbiddenPath in @(
    "app\data",
    "app\archives",
    "app\dev.db",
    "app\dev.db-wal",
    "app\dev.db-shm",
    "app\.env",
    "app\feedback-attachments",
    "app\feedback-inbox",
    "app\.git",
    "app\.next\dev",
    "app\.next\cache"
)) {
    if (Test-Path -LiteralPath (Join-Path $bundleRoot $forbiddenPath)) {
        throw "离线包包含了不应发布的路径：$forbiddenPath"
    }
}

Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal
Write-Host "已创建离线安装包：$archivePath"
