import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveWeComCatchScriptPath,
  runWeComCatchCommand,
  WECOMCATCH_SCRIPT_PATH,
  type WeComCatchExecFile,
} from "@/services/wecomcatch-service";

describe("wecomcatch-service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls the project-local CLI and parses JSON stdout", async () => {
    const execFileImpl: WeComCatchExecFile = (file, args, _options, callback) => {
      expect(file).toBe(WECOMCATCH_SCRIPT_PATH);
      expect(args).toEqual(["status"]);
      callback(null, "{\"complete\":444,\"pending\":3}", "");
    };

    const result = await runWeComCatchCommand("status", { execFileImpl });
    expect(result).toMatchObject({
      command: "status",
      scriptPath: WECOMCATCH_SCRIPT_PATH,
      parsed: { complete: 444, pending: 3 },
    });
  });

  it("honors a WECOMCATCH_CLI_PATH override", async () => {
    vi.stubEnv("WECOMCATCH_CLI_PATH", "tools/wecomcatch-alternate/bin/wecomcatch");
    const expectedPath = resolve(process.cwd(), "tools/wecomcatch-alternate/bin/wecomcatch");
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
