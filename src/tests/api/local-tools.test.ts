import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getLocalToolsStatus } = vi.hoisted(() => ({
  getLocalToolsStatus: vi.fn(),
}));

vi.mock("@/services/local-tool-status-service", () => ({ getLocalToolsStatus }));

import { GET } from "@/app/api/system/local-tools/route";

const fullOnlyIt = (
  process.env.STUDENT_TRACK_EDITION
  ?? process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION
) === "core" ? it.skip : it;

describe("GET /api/system/local-tools", () => {
  beforeEach(() => {
    getLocalToolsStatus.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  fullOnlyIt("returns the read-only local tool status payload", async () => {
    getLocalToolsStatus.mockReturnValue({
      checkedAt: "2026-07-12T00:00:00.000Z",
      tools: [{
        id: "funasr",
        name: "FunASR",
        status: "warning",
        summary: "warning",
        checks: [],
      }],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkedAt: "2026-07-12T00:00:00.000Z",
      tools: [expect.objectContaining({ id: "funasr", status: "warning" })],
    });
    expect(getLocalToolsStatus).toHaveBeenCalledOnce();
  });

  it("returns the unified Core feature response without probing the machine", async () => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");

    const response = await GET();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "当前 Core 版未包含此功能",
      code: "feature_unavailable",
      retryable: false,
    });
    expect(getLocalToolsStatus).not.toHaveBeenCalled();
  });
});
