import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptRoot = resolve(process.cwd(), "scripts", "windows");
const common = readFileSync(resolve(scriptRoot, "StudentTrack-Core.Common.ps1"), "utf8");
const prepare = readFileSync(resolve(scriptRoot, "Prepare-StudentTrackCore.ps1"), "utf8");
const start = readFileSync(resolve(scriptRoot, "Start-StudentTrackCore.ps1"), "utf8");
const ciWorkflow = readFileSync(resolve(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
const allScripts = `${common}\n${prepare}\n${start}`;

describe("Windows Core PowerShell entrypoints", () => {
  it("pins the supported Windows, Node, npm, architecture, and Core edition", () => {
    expect(common).toMatch(/Windows \(10\|11\)/);
    expect(common).toMatch(/\^v24\\\./);
    expect(common).toMatch(/\^11\\\./);
    expect(common).toContain('$nodeArchitecture -ne "x64"');
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
    expect(start).toContain('"--hostname", "127.0.0.1", "--port", "3000"');
    expect(start).not.toContain("db:seed");
  });

  it("does not probe, start, or call Full-only transcription and WCG tools", () => {
    expect(allScripts).not.toMatch(/funasr|diarize|wecom|wcg/i);
  });
});
