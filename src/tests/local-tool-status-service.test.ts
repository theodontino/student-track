import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLocalToolsStatus,
  inspectFunASR,
  inspectWccHandoff,
  preflightDiarize,
  resolveWccHandoffPaths,
} from "@/services/local-tool-status-service";

const temporaryDirectories: string[] = [];
const fullOnlyIt = (
  process.env.STUDENT_TRACK_EDITION
  ?? process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION
) === "core" ? it.skip : it;

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "student-track-local-tools-test-"));
  temporaryDirectories.push(root);
  const cwd = path.join(root, "app");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return { cwd, homeDir };
}

function writeFile(targetPath: string, content = "fixture", executable = false) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  if (executable) fs.chmodSync(targetPath, 0o755);
}

function installFunASRFixture(cwd: string, homeDir: string, includeVenv = true) {
  const toolDir = path.join(homeDir, "tools", "funasr-diarize");
  writeFile(path.join(cwd, "diarize.sh"), "#!/bin/sh\n", true);
  writeFile(path.join(toolDir, "diarize_auto.sh"), "#!/bin/sh\n", true);
  writeFile(path.join(toolDir, "diarize.sh"), "#!/bin/sh\n", true);
  writeFile(path.join(toolDir, "diarize_tingwu.sh"), "#!/bin/sh\n", true);
  writeFile(path.join(toolDir, "diarize_aliyun.sh"), "#!/bin/sh\n", true);
  if (includeVenv) writeFile(path.join(toolDir, "venv", "bin", "python"), "#!/bin/sh\n", true);
  writeFile(path.join(toolDir, "hotwords_active.txt"), "chemistry\n");
  fs.mkdirSync(path.join(cwd, "data", "diarize"), { recursive: true });
}

function installWccHandoffFixture(cwd: string) {
  const root = path.join(cwd, "wcc-exchange");
  fs.mkdirSync(path.join(root, "v1", "packages"), { recursive: true });
  fs.mkdirSync(path.join(root, "v1", "receipts"), { recursive: true });
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local-tool-status-service", () => {
  it("does not probe local tools through a direct service call in Core", () => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");
    expect(() => getLocalToolsStatus()).toThrowError(expect.objectContaining({
      status: 404,
      code: "feature_unavailable",
    }));
  });

  fullOnlyIt("reports available fixtures without returning API token contents", () => {
    const { cwd, homeDir } = temporaryProject();
    installFunASRFixture(cwd, homeDir);
    const exchangeRoot = installWccHandoffFixture(cwd);
    const commandDir = path.join(cwd, "commands");
    writeFile(path.join(commandDir, "ffmpeg"), "#!/bin/sh\n", true);
    writeFile(path.join(commandDir, "ffprobe"), "#!/bin/sh\n", true);

    const result = getLocalToolsStatus({
      cwd,
      homeDir,
      env: {
        PATH: commandDir,
        STUDENT_TRACK_WCC_EXCHANGE_ROOT: exchangeRoot,
        WECOMCATCH_API_TOKEN: "never-return-this",
      },
    });

    expect(result.tools.map((tool) => [tool.id, tool.status])).toEqual([
      ["funasr", "available"],
      ["wecomcatch", "available"],
    ]);
    expect(JSON.stringify(result)).not.toContain("never-return-this");
  });

  fullOnlyIt("uses warnings for optional FunASR dependencies and blocks only selected core paths", () => {
    const { cwd, homeDir } = temporaryProject();
    installFunASRFixture(cwd, homeDir, false);
    const options = { cwd, homeDir, env: { PATH: "" } };

    expect(inspectFunASR(options).status).toBe("warning");
    expect(preflightDiarize("auto", options)).toEqual({ ready: true, blockers: [] });
    expect(preflightDiarize("local", options)).toMatchObject({
      ready: false,
      blockers: [expect.stringContaining("Python")],
    });
  });

  fullOnlyIt("reports an unusable handoff path without inspecting WCC runtime", () => {
    const { cwd, homeDir } = temporaryProject();
    const blockedParent = path.join(cwd, "blocked");
    writeFile(blockedParent);
    const env = { STUDENT_TRACK_WCC_EXCHANGE_ROOT: path.join(blockedParent, "exchange") };

    const paths = resolveWccHandoffPaths({ cwd, homeDir, env });
    expect(paths.exchangeRoot).toBe(path.join(blockedParent, "exchange"));
    expect(inspectWccHandoff({ cwd, homeDir, env }).status).toBe("unavailable");
  });
});
