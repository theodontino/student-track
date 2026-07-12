import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveWeComCatchScriptPath,
  runWeComCatchCommand,
  type WeComCatchExecFile,
} from "@/services/wecomcatch-service";

describe("wecomcatch-service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls the configured external CLI and parses JSON stdout", async () => {
    vi.stubEnv("WECOMCATCH_PROJECT_ROOT", "/external/wecomcatch");
    const scriptPath = resolve("/external/wecomcatch/bin/wecomcatch");
    const execFileImpl: WeComCatchExecFile = (file, args, _options, callback) => {
      expect(file).toBe(scriptPath);
      expect(args).toEqual(["status"]);
      callback(null, "{\"complete\":444,\"pending\":3}", "");
    };

    const result = await runWeComCatchCommand("status", { execFileImpl });
    expect(result).toMatchObject({
      command: "status",
      scriptPath,
      parsed: { complete: 444, pending: 3 },
    });
  });

  it("requires an explicit external project configuration", () => {
    expect(() => resolveWeComCatchScriptPath({})).toThrow("未配置外部 WeComCatch");
  });

  it("honors a WECOMCATCH_CLI_PATH override", async () => {
    vi.stubEnv("WECOMCATCH_CLI_PATH", "/external/wecomcatch-alternate/bin/wecomcatch");
    const expectedPath = resolve("/external/wecomcatch-alternate/bin/wecomcatch");
    expect(resolveWeComCatchScriptPath()).toBe(expectedPath);

    const execFileImpl: WeComCatchExecFile = (file, args, _options, callback) => {
      expect(file).toBe(expectedPath);
      expect(args).toEqual(["sync-status"]);
      callback(null, "{}", "");
    };

    await expect(runWeComCatchCommand("sync-status", { execFileImpl })).resolves.toMatchObject({
      scriptPath: expectedPath,
      parsed: {},
    });
  });

  it("rejects failed commands with captured stdout and stderr", async () => {
    vi.stubEnv("WECOMCATCH_PROJECT_ROOT", "/external/wecomcatch");
    const execFileImpl: WeComCatchExecFile = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("boom"), { code: 2 });
      callback(error, "partial", "failed clearly");
    };

    await expect(runWeComCatchCommand("export", { execFileImpl })).rejects.toMatchObject({
      message: "failed clearly",
      result: expect.objectContaining({ stdout: "partial", stderr: "failed clearly" }),
    });
  });
});
