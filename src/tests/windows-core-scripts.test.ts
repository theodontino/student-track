import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptRoot = resolve(process.cwd(), "scripts", "windows");
const common = readFileSync(resolve(scriptRoot, "StudentTrack-Core.Common.ps1"), "utf8");
const prepare = readFileSync(resolve(scriptRoot, "Prepare-StudentTrackCore.ps1"), "utf8");
const start = readFileSync(resolve(scriptRoot, "Start-StudentTrackCore.ps1"), "utf8");
const installer = readFileSync(resolve(scriptRoot, "Install-StudentTrackCore.ps1"), "utf8");
const clickInstaller = readFileSync(resolve(scriptRoot, "Install-StudentTrackCore.cmd"), "utf8");
const offlinePrepare = readFileSync(resolve(scriptRoot, "Prepare-StudentTrackCoreOffline.ps1"), "utf8");
const offlineInstaller = readFileSync(resolve(scriptRoot, "Install-StudentTrackCoreOffline.ps1"), "utf8");
const offlineClickInstaller = readFileSync(resolve(scriptRoot, "Install-StudentTrackCoreOffline.cmd"), "utf8");
const offlineBundle = readFileSync(resolve(scriptRoot, "Build-StudentTrackCoreOfflineBundle.ps1"), "utf8");
const offlineBundleTest = readFileSync(resolve(scriptRoot, "Test-StudentTrackCoreOfflineBundle.ps1"), "utf8");
const ciWorkflow = readFileSync(resolve(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
const offlineBundleWorkflow = readFileSync(resolve(process.cwd(), ".github", "workflows", "windows-offline-package.yml"), "utf8");
const verifyAgent = readFileSync(resolve(process.cwd(), "scripts", "verify-agent.ts"), "utf8");
const allScripts = `${common}\n${prepare}\n${start}`;

describe("Windows Core PowerShell entrypoints", () => {
  it("pins the supported Windows, Node, npm, architecture, and Core edition", () => {
    expect(common).toMatch(/Windows \(10\|11\)/);
    expect(common).toMatch(/\^v24\\\./);
    expect(common).toMatch(/\^11\\\./);
    expect(common).toContain('$nodeArchitecture -ne "x64"');
    expect(common).toContain('$windows.OSArchitecture -match "ARM"');
    expect(common).toContain('$env:STUDENT_TRACK_EDITION = "core"');
    expect(common).toContain('$env:GITHUB_ACTIONS -eq "true"');
    expect(prepare).toContain("AllowGitHubActionsServerForCI");
    expect(start).toContain("AllowGitHubActionsServerForCI");
  });

  it("keeps every private runtime directory under LocalAppData without resetting LLM settings", () => {
    expect(common).toContain('$runtimeRoot = Join-Path $env:LOCALAPPDATA "Student Track"');
    for (const directory of ["database", "data", "feedback-attachments", "feedback-inbox", "archives"]) {
      expect(common).toContain(`Join-Path $runtimeRoot "${directory}"`);
    }
    expect(common).toContain("ConvertTo-StudentTrackFileUrl");
    expect(common).toContain("$normalizedPath = $absolutePath.Replace('\\', '/')");
    expect(common).toContain('return "file:$normalizedPath"');
    expect(common).not.toContain("[System.Uri]::new");
    expect(ciWorkflow).toContain('"DATABASE_URL=$($env:DATABASE_URL)"');
    expect(ciWorkflow).toContain("$createdId = $created.id");
    expect(ciWorkflow).toContain('"http://127.0.0.1:3000/api/semesters/$createdId"');
    expect(ciWorkflow).toContain("$persisted.id -ne $createdId");
    expect(ciWorkflow).toContain("TEMP: ${{ runner.temp }}");
    expect(ciWorkflow).toContain("TMP: ${{ runner.temp }}");
    expect(common).not.toMatch(/\$env:LLM_SETTINGS_PATH\s*=/i);
  });

  it("prepares dependencies, Prisma, migrations, backup, and the Core production build without seeding", () => {
    expect(prepare).toContain('@("ci")');
    expect(prepare).toContain('@($prismaCli, "generate")');
    expect(prepare).toContain('@($prismaCli, "migrate", "deploy")');
    expect(prepare).toContain('@("run", "db:backup")');
    expect(prepare).toContain('@("run", "db:verify-backup")');
    expect(prepare).toContain('@("run", "build")');
    expect(prepare).not.toContain("db:seed");
  });

  it("starts only an initialized production build on the loopback address", () => {
    expect(start).toContain('.next\\BUILD_ID');
    expect(start).toContain('.next\\required-server-files.json');
    expect(start).toContain("ConvertFrom-Json");
    expect(start).toContain("$buildMetadata.config.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION");
    expect(start).toContain('$buildEdition -ne "core"');
    expect(start).toContain('$env:NODE_ENV = "production"');
    expect(start).toContain('$env:NPM_CONFIG_OFFLINE = "true"');
    expect(start).toContain('"--hostname", "127.0.0.1", "--port", "3000"');
    expect(start).not.toContain("db:seed");
  });

  it("does not probe, start, or call Full-only transcription and WCG tools", () => {
    expect(allScripts).not.toMatch(/funasr|diarize|tingwu|aliyun|wecom|wcg/i);
  });

  it("offers a clean-machine bootstrap without an administrator install or test-data seed", () => {
    expect(installer.charCodeAt(0)).toBe(0xfeff);
    expect(installer).toContain("#requires -Version 5.1");
    expect(installer).toContain('"v1.3.0-beta.2"');
    expect(installer).toContain("https://nodejs.org/dist/index.json");
    expect(installer).toContain('"win-x64-zip"');
    expect(installer).toContain('^v24\\.');
    expect(installer).toContain('^11\\.');
    expect(installer).not.toContain('^v24\\\\.');
    expect(installer).not.toContain('^11\\\\.');
    expect(installer).toContain('$windows.OSArchitecture -match "ARM"');
    expect(installer).toContain("https://github.com/$Repository/archive/refs/tags/$Tag.zip");
    expect(installer).toMatch(/Join-Path \$RuntimeRoot "node"/);
    expect(installer).toMatch(/Join-Path \$RuntimeRoot "app"/);
    expect(installer).toContain('set "PATH=%~dp0node;%PATH%"');
    expect(installer).toContain("Prepare-StudentTrackCore.ps1");
    expect(installer).not.toMatch(/db:seed|funasr|diarize|tingwu|aliyun|wecom|wcg/i);
  });

  it("offers a double-click launcher that fetches the published bootstrap and preserves errors", () => {
    expect(clickInstaller).toMatch(/^@echo off/m);
    expect(clickInstaller).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(clickInstaller).toContain("releases/download/v1.3.0-beta.2/Install-StudentTrackCore.ps1");
    expect(clickInstaller).toContain("Invoke-WebRequest -UseBasicParsing");
    expect(clickInstaller).toContain("$ErrorActionPreference='Stop'");
    expect(clickInstaller).toContain("SecurityProtocol=[Net.SecurityProtocolType]::Tls12");
    expect(clickInstaller).toContain("Remove-Item -LiteralPath $env:ST_BOOTSTRAP_FILE");
    expect(clickInstaller).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ST_BOOTSTRAP_FILE%"');
    expect(clickInstaller).toContain(":download_failed");
    expect(clickInstaller).toContain(":install_failed");
    expect(clickInstaller).not.toMatch(/db:seed|funasr|diarize|tingwu|aliyun|wecom|wcg/i);
  });

  it("builds and installs a Windows-only offline bundle without a teacher-side download or build", () => {
    for (const script of [offlinePrepare, offlineInstaller, offlineBundle]) {
      expect(script.charCodeAt(0)).toBe(0xfeff);
    }
    expect(offlineClickInstaller.charCodeAt(0)).not.toBe(0xfeff);
    expect(offlineClickInstaller).toMatch(/^@echo off/m);
    expect(offlineClickInstaller).toContain("Install-StudentTrackCoreOffline.ps1");
    expect(offlineClickInstaller).not.toMatch(/https?:\/\//i);

    expect(offlinePrepare).toContain('$env:NPM_CONFIG_OFFLINE = "true"');
    expect(offlinePrepare).toContain('@($prismaCli, "migrate", "deploy")');
    expect(offlinePrepare).toContain('@("run", "db:backup")');
    expect(offlinePrepare).toContain('@("run", "db:verify-backup")');
    expect(offlinePrepare).not.toContain('@("ci")');
    expect(offlinePrepare).not.toContain('"generate"');
    expect(offlinePrepare).not.toContain('@("run", "build")');
    expect(offlinePrepare).not.toContain("db:seed");

    expect(offlineInstaller).toContain('$packageApp = Join-Path $packageRoot "app"');
    expect(offlineInstaller).toContain('$packageNode = Join-Path $packageRoot "node"');
    expect(offlineInstaller).toContain('$runtimeRoot = Join-Path $env:LOCALAPPDATA "Student Track"');
    expect(offlineInstaller).toContain('$runtimeDataRoots = @(');
    expect(offlineInstaller).toContain('Get-ChildItem -LiteralPath $runtimeRoot -Force');
    expect(offlineInstaller).toContain("升级或恢复方案");
    expect(offlineInstaller).toContain('Copy-Item -LiteralPath $packageApp -Destination $runtimeRoot');
    expect(offlineInstaller).toContain('Copy-Item -LiteralPath $packageNode -Destination $runtimeRoot');
    expect(offlineInstaller).toContain("Prepare-StudentTrackCoreOffline.ps1");
    expect(offlineInstaller).toContain("StudentTrack-Core.Common.ps1");
    expect(offlineInstaller).toContain("New-StudentTrackOfflineLauncher");
    expect(offlineInstaller).toContain('Join-Path $RuntimeRoot "Start Student Track Core.cmd"');
    expect(offlineInstaller).toContain("WScript.Shell");
    expect(offlineInstaller).toContain("Remove-Item -LiteralPath $newProgramRoot -Recurse -Force");
    expect(offlineInstaller).toContain('set "NPM_CONFIG_OFFLINE=true"');
    expect(offlineInstaller).not.toMatch(/https?:\/\/|Invoke-WebRequest|npm ci|db:seed/i);
    expect(offlineClickInstaller).toContain("GITHUB_ACTIONS");
    expect(offlineClickInstaller).toContain("content created by this attempt was removed");

    expect(offlineBundle).toContain('STUDENT_TRACK_EDITION -ne "core"');
    expect(offlineBundle).toContain('^v24\\.');
    expect(offlineBundle).not.toContain('^v24\\\\.');
    expect(offlineBundle).toContain("status --porcelain");
    expect(offlineBundle).toContain("干净的已提交工作区");
    expect(offlineBundle).toContain("archive --format=zip");
    expect(offlineBundle).toContain("node_modules");
    expect(offlineBundle).toContain("src\\generated\\prisma");
    expect(offlineBundle).toContain("robocopy.exe");
    expect(offlineBundle).toContain("/XD cache dev");
    expect(offlineBundle).toContain("Install-StudentTrackCoreOffline.ps1");
    expect(offlineBundle).toContain("LICENSE");
    expect(offlineBundle).toContain("student-track-$version-source.zip");
    expect(offlineBundle).toContain("Compress-Archive");
    expect(offlineBundle).toContain('"app\\.next\\dev"');
    expect(offlineBundle).not.toMatch(/https?:\/\/|db:seed|funasr|diarize|tingwu|aliyun|wecom|wcg/i);

    expect(offlineBundleTest.charCodeAt(0)).toBe(0xfeff);
    expect(offlineBundleTest).toContain('$env:NPM_CONFIG_OFFLINE = "true"');
    expect(offlineBundleTest).toContain('$env:HTTP_PROXY = "http://127.0.0.1:9"');
    expect(offlineBundleTest).toContain("Expand-Archive");
    expect(offlineBundleTest).toContain("Install-StudentTrackCoreOffline.cmd");
    expect(offlineBundleTest).toContain("& $installerCommand");
    expect(offlineBundleTest).toContain('Start-Process -FilePath "cmd.exe"');
    expect(offlineBundleTest).toContain('Join-Path $installedRoot "Start Student Track Core.cmd"');
    expect(offlineBundleTest).toContain("Offline Core CI Semester");
    expect(ciWorkflow).toContain("Build and verify the offline Windows Core package");
    expect(ciWorkflow).toContain("Upload verified offline Windows Core package");
    expect(ciWorkflow).toContain("student-track-core-windows-x64-${{ github.sha }}");
    expect(ciWorkflow).toContain("Build-StudentTrackCoreOfflineBundle.ps1");
    expect(ciWorkflow).toContain("Test-StudentTrackCoreOfflineBundle.ps1");
    expect(offlineBundleWorkflow).toContain("workflow_dispatch");
    expect(offlineBundleWorkflow).toContain("完整提交 SHA");
    expect(offlineBundleWorkflow).toContain("完整提交 SHA 构建");
    expect(offlineBundleWorkflow).toContain("OFFLINE_SOURCE_COMMIT");
  });

  it("runs npm steps through Node instead of spawning the Windows cmd shim", () => {
    expect(verifyAgent).toContain("spawn(process.execPath, [npmCliPath, ...step.args]");
    expect(verifyAgent).not.toContain("spawn(npmCommand");
  });
});
