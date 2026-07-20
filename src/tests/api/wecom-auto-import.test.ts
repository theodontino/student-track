import { beforeEach, describe, expect, it, vi } from "vitest";

const runWeComAutoImport = vi.hoisted(() => vi.fn());

vi.mock("@/services/wecom-auto-import-service", () => ({
  runWeComAutoImport,
}));

import { POST } from "@/app/api/wecom/auto-import/route";

describe("POST /api/wecom/auto-import", () => {
  beforeEach(() => {
    runWeComAutoImport.mockReset();
  });

  it("streams progress and completion as newline-delimited JSON", async () => {
    runWeComAutoImport.mockImplementation(async (_prisma, options) => {
      options.emit({
        type: "progress",
        phase: "extracting",
        progress: 50,
        message: "正在处理",
      });
      options.emit({
        type: "complete",
        result: { createdCount: 0 },
        conversationCount: 0,
        messageCount: 0,
        batchCount: 0,
        since: "2026-07-20T00:00:00.000Z",
      });
    });

    const response = await POST();
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(lines).toEqual([
      expect.objectContaining({ type: "progress", progress: 50 }),
      expect.objectContaining({ type: "complete", batchCount: 0 }),
    ]);
  });

  it("does not expose provider or filesystem details in stream errors", async () => {
    runWeComAutoImport.mockRejectedValue(new Error("/private/config provider response"));

    const response = await POST();
    const body = await response.text();

    expect(body).toContain("数据库未写入失败批次");
    expect(body).not.toContain("/private/config");
    expect(body).not.toContain("provider response");
  });
});
