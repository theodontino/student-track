import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptRoot = resolve(process.cwd(), "scripts", "macos");
const common = readFileSync(resolve(scriptRoot, "StudentTrack-Full.Common.sh"), "utf8");
const installer = readFileSync(resolve(scriptRoot, "Install-StudentTrackFullOffline.sh"), "utf8");
const clickInstaller = readFileSync(resolve(scriptRoot, "Install-StudentTrackFullOffline.command"), "utf8");
const start = readFileSync(resolve(scriptRoot, "Start-StudentTrackFull.sh"), "utf8");
const uninstaller = readFileSync(resolve(scriptRoot, "Uninstall-StudentTrackFull.sh"), "utf8");
const bundle = readFileSync(resolve(scriptRoot, "Build-StudentTrackFullOfflineBundle.sh"), "utf8");
const bundleTest = readFileSync(resolve(scriptRoot, "Test-StudentTrackFullOfflineBundle.sh"), "utf8");
const ciWorkflow = readFileSync(resolve(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
const bundleWorkflow = readFileSync(resolve(process.cwd(), ".github", "workflows", "macos-offline-package.yml"), "utf8");

describe("macOS Full offline bundle scripts", () => {
  it("pins macOS, Node 24, npm 11, matching architecture, and Full runtime roots", () => {
    expect(common).toContain('"$(uname -s)" != "Darwin"');
    expect(common).toMatch(/arm64\|x86_64/);
    expect(common).toContain("v24.*");
    expect(common).toContain("11.*");
    expect(common).toContain('node_version="$("$node_executable" --version)"');
    expect(common).toContain('node_architecture="$("$node_executable" -p \'process.arch\')"');
    expect(common).toContain('npm_version="$("$npm_executable" --version)"');
    expect(common).toContain('export STUDENT_TRACK_EDITION="full"');
    expect(common).toContain('$HOME/Library/Application Support/Student Track');
    for (const directory of ["database", "data", "feedback-attachments", "feedback-inbox", "archives"]) {
      expect(common).toContain(directory);
    }
  });

  it("installs a complete offline production build and permits retained-data reinstall", () => {
    expect(clickInstaller).toContain("Install-StudentTrackFullOffline.sh");
    expect(installer).toContain('/usr/bin/ditto "$package_app" "$app_root"');
    expect(installer).toContain('/usr/bin/ditto "$package_node" "$node_root"');
    expect(installer).toContain("NPM_CONFIG_OFFLINE");
    expect(installer).toContain("migrate deploy");
    expect(installer).toContain("db:backup");
    expect(installer).toContain("db:verify-backup");
    expect(installer).toContain("NEXT_PUBLIC_STUDENT_TRACK_EDITION");
    expect(installer).toContain("Uninstall Student Track Full.command");
    expect(installer).toContain("${preexisting_data_roots[$index]}");
    expect(installer).not.toContain("db:seed");
  });

  it("starts the Full production service only on loopback", () => {
    expect(start).toContain(".next/BUILD_ID");
    expect(start).toContain('export NODE_ENV="production"');
    expect(start).toContain("--hostname 127.0.0.1 --port");
    expect(start).toContain("/api/semesters");
    expect(start).toContain("/usr/bin/open");
    expect(start).not.toContain("next dev");
  });

  it("removes program files while preserving every teaching-data directory", () => {
    expect(uninstaller).toContain('rm -rf "$app_root" "$node_root"');
    expect(uninstaller).toContain('rm -f "$start_launcher"');
    expect(uninstaller).not.toContain('rm -rf "$runtime_root"');
    expect(uninstaller).not.toMatch(/rm -rf .*database|rm -rf .*archives/);
    expect(uninstaller).toContain("数据库和运行数据仍保留");
    expect(uninstaller).toContain("再次运行安装器可以继续使用原数据库");
  });

  it("builds from a clean committed, architecture-specific Full workspace", () => {
    expect(bundle).toContain("status --porcelain");
    expect(bundle).toContain("干净的已提交工作区");
    expect(bundle).toContain('STUDENT_TRACK_EDITION:-}" != "full"');
    expect(bundle).toContain("node_modules");
    expect(bundle).toContain("src/generated/prisma");
    expect(bundle).toContain("Install-StudentTrackFullOffline.command");
    expect(bundle).toContain("student-track-$version-source.zip");
    expect(bundle).toContain("--sequesterRsrc --keepParent");
    expect(bundle).toContain("StudentTrackFull-macOS-$node_architecture-$version.zip");
  });

  it("verifies install, persistence, data-preserving uninstall, and reinstall", () => {
    expect(bundleTest).toContain("HTTP_PROXY");
    expect(bundleTest).toContain("Offline Full CI Semester");
    expect(bundleTest).toContain("127.0.0.1:$port");
    expect(bundleTest).toContain("uninstall-preservation-marker.txt");
    expect(bundleTest).toContain("卸载器删除了应保留的数据库或运行数据");
    expect(bundleTest).toContain("macOS Full 离线包安装、卸载保留数据和重新安装验收通过");
    expect(ciWorkflow).toContain("Build and verify the offline macOS Full bundle");
    expect(ciWorkflow).toContain("Upload verified offline macOS Full bundle");
    expect(bundleWorkflow).toContain("workflow_dispatch");
    expect(bundleWorkflow).toContain("完整提交 SHA");
  });
});
