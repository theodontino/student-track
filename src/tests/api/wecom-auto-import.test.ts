import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runWeComAutoImport: vi.fn(),
  getStatus: vi.fn(),
  requestCancellation: vi.fn(),
}));

vi.mock("@/services/wecom-auto-import-service", () => ({
  runWeComAutoImport: mocks.runWeComAutoImport,
  getWeComAutoImportStatus: mocks.getStatus,
  requestWeComAutoImportCancellation: mocks.requestCancellation,
}));

import { DELETE, GET, POST } from "@/app/api/wecom/auto-import/route";

describe("POST /api/wecom/auto-import", () => {
  beforeEach(() => {
    mocks.runWeComAutoImport.mockReset();
    mocks.getStatus.mockReset();
    mocks.requestCancellation.mockReset();
  });

  it("streams progress and completion as newline-delimited JSON", async () => {
    mocks.runWeComAutoImport.mockImplementation(async (_prisma, options) => {
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
    mocks.runWeComAutoImport.mockRejectedValue(new Error("/private/config provider response"));

    const response = await POST();
    const body = await response.text();

    expect(body).toContain("数据库未写入失败批次");
    expect(body).not.toContain("/private/config");
    expect(body).not.toContain("provider response");
  });

  it.each([
    {
      phase: "syncing",
      error: "full sidebar scan incomplete: observed 96 of 147 rows (65.3%)",
      expected: "会话扫描覆盖率低于安全门槛",
    },
    {
      phase: "syncing",
      error: "WeCom window size changed during full sidebar scan",
      expected: "企微窗口或会话侧栏尺寸发生变化",
    },
    {
      phase: "syncing",
      error: "Visible conversation table not found; keep the WeCom window open",
      expected: "打开企微主窗口并停留在消息页",
    },
    {
      phase: "extracting",
      error: "provider request failed with a private response",
      expected: "LLM 调用或候选提取失败",
    },
  ])("returns an actionable safe error for $phase failures", async ({ phase, error, expected }) => {
    mocks.runWeComAutoImport.mockImplementation(async (_prisma, options) => {
      options.emit({ type: "progress", phase, progress: 10, message: "处理中" });
      throw new Error(error);
    });

    const response = await POST();
    const body = await response.text();

    expect(body).toContain(expected);
    expect(body).not.toContain(error);
  });

  it("returns resumable status for a refreshed page", async () => {
    mocks.getStatus.mockResolvedValue({ active: true, run: { id: "run-1", progress: 42 } });
    const response = await GET();
    await expect(response.json()).resolves.toMatchObject({ active: true, run: { progress: 42 } });
  });

  it("accepts a stop-and-rollback request", async () => {
    mocks.requestCancellation.mockResolvedValue({ accepted: true, runId: "run-1", rollbackRequested: true });
    const response = await DELETE(new Request("http://localhost/api/wecom/auto-import", {
      method: "DELETE",
      body: JSON.stringify({ mode: "stop_and_rollback" }),
    }) as never);
    expect(response.status).toBe(202);
    expect(mocks.requestCancellation).toHaveBeenCalledWith(expect.anything(), "stop_and_rollback");
  });
});
