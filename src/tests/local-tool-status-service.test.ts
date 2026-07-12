import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getLocalToolsStatus,
  inspectFunASR,
  inspectWeComCatch,
  preflightDiarize,
  preflightWeComCatchSync,
  resolveWeComCatchPaths,
} from "@/services/local-tool-status-service";

const temporaryDirectories: string[] = [];

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chem-track-local-tools-test-"));
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

function installWeComCatchFixture(cwd: string) {
  const root = path.join(cwd, "tools", "wecomcatch");
  writeFile(path.join(root, "bin", "wecomcatch"), "#!/bin/sh\n", true);
  writeFile(path.join(root, "config.local.json"), '{"apiKey":"never-return-this"}');
  writeFile(path.join(root, "runtime", "archive.sqlite3"), "private-chat-content");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local-tool-status-service", () => {
  it("reports available fixtures without returning config or database contents", () => {
    const { cwd, homeDir } = temporaryProject();
    installFunASRFixture(cwd, homeDir);
    installWeComCatchFixture(cwd);
    const commandDir = path.join(cwd, "commands");
    writeFile(path.join(commandDir, "ffmpeg"), "#!/bin/sh\n", true);
    writeFile(path.join(commandDir, "ffprobe"), "#!/bin/sh\n", true);

    const result = getLocalToolsStatus({ cwd, homeDir, env: { PATH: commandDir } });

    expect(result.tools.map((tool) => [tool.id, tool.status])).toEqual([
      ["funasr", "available"],
      ["wecomcatch", "available"],
    ]);
    expect(JSON.stringify(result)).not.toContain("never-return-this");
    expect(JSON.stringify(result)).not.toContain("private-chat-content");
  });

  it("uses warnings for optional FunASR dependencies and blocks only selected core paths", () => {
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

  it("reports missing required WeComCatch paths and resolves overrides without reading them", () => {
    const { cwd, homeDir } = temporaryProject();
    const env = {
      WECOMCATCH_CLI_PATH: "custom/bin/wecomcatch",
      WECOMCATCH_RUNTIME_DIR: "shared-runtime",
      WECOMCATCH_CONFIG_PATH: "shared-config.json",
    };

    const paths = resolveWeComCatchPaths({ cwd, homeDir, env });
    expect(paths.cli).toBe(path.join(cwd, "custom", "bin", "wecomcatch"));
    expect(paths.runtimeDir).toBe(path.join(cwd, "tools", "wecomcatch", "shared-runtime"));
    expect(paths.config).toBe(path.join(cwd, "tools", "wecomcatch", "shared-config.json"));
    expect(inspectWeComCatch({ cwd, homeDir, env }).status).toBe("unavailable");
    expect(preflightWeComCatchSync({ cwd, homeDir, env }).ready).toBe(false);
  });
});
