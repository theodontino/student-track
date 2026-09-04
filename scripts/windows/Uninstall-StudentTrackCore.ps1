#requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$SkipConfirmation,
    [switch]$SkipDesktopShortcut
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Student Track Core 卸载器仅支持 Windows。"
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "Windows 未提供 LOCALAPPDATA，无法确定 Student Track 安装目录。"
}

$runtimeRoot = Join-Path $env:LOCALAPPDATA "Student Track"
$appRoot = Join-Path $runtimeRoot "app"
$nodeRoot = Join-Path $runtimeRoot "node"
$startLauncher = Join-Path $runtimeRoot "Start Student Track Core.cmd"
$preservedPaths = @(
    (Join-Path $runtimeRoot "database"),
    (Join-Path $runtimeRoot "data"),
    (Join-Path $runtimeRoot "feedback-attachments"),
    (Join-Path $runtimeRoot "feedback-inbox"),
    (Join-Path $runtimeRoot "archives")
)

if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
    Write-Host "没有找到 Student Track Core 安装目录：$runtimeRoot"
    exit 0
}

if (-not $SkipConfirmation) {
    Write-Host "将卸载 Student Track Core 程序和便携 Node。"
    Write-Host "数据库、LLM 设置、附件、收件箱和备份会保留在：$runtimeRoot"
    $confirmation = Read-Host "输入 UNINSTALL 继续"
    if ($confirmation -ne "UNINSTALL") {
        Write-Host "已取消卸载。"
        exit 1
    }
}

$nodePrefix = [System.IO.Path]::GetFullPath($nodeRoot).TrimEnd('\') + '\'
Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        if (-not [string]::IsNullOrWhiteSpace($_.Path)) {
            $processPath = [System.IO.Path]::GetFullPath($_.Path)
            if ($processPath.StartsWith($nodePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $_.Id -Force -ErrorAction Stop
                $_.WaitForExit()
            }
        }
    } catch {
        throw "无法停止 Student Track Core 进程，请先关闭启动窗口后重试。"
    }
}

foreach ($programPath in @($appRoot, $nodeRoot, $startLauncher)) {
    if (Test-Path -LiteralPath $programPath) {
        Remove-Item -LiteralPath $programPath -Recurse -Force
    }
}

if (-not $SkipDesktopShortcut) {
    $desktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
    if (-not [string]::IsNullOrWhiteSpace($desktopDirectory)) {
        $desktopShortcut = Join-Path $desktopDirectory "Student Track Core.lnk"
        if (Test-Path -LiteralPath $desktopShortcut) {
            Remove-Item -LiteralPath $desktopShortcut -Force
        }
    }
}

Write-Host "Student Track Core 程序已卸载。"
Write-Host "以下教学数据目录没有删除："
foreach ($preservedPath in $preservedPaths) {
    Write-Host "- $preservedPath"
}
Write-Host "再次运行安装器可以继续使用原数据库。"
