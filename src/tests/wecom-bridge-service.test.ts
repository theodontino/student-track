import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateWeComBridgeJson } from "@/services/wecom-bridge-service";

const mocks = vi.hoisted(() => ({
  completionCreate: vi.fn(),
  studentFindMany: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mocks.completionCreate } } }),
  getLLMModel: () => "test-model",
}));

const prisma = {
  student: { findMany: mocks.studentFindMany },
} as any;

describe("wecom bridge service", () => {
  beforeEach(() => {
    mocks.completionCreate.mockReset();
    mocks.studentFindMany.mockReset().mockResolvedValue([
      {
        id: "student-1",
        name: "张三",
        studentId: "S001",
        class: { name: "测试班", code: "T-1" },
      },
    ]);
  });

  it("returns bridge JSON from a valid LLM response", async () => {
    mocks.completionCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ source: "wecomcatch", mode: "candidateOnly", records: [] }) } }],
    });

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" })).resolves.toMatchObject({
      sourceLabel: "粘贴的企微文本",
      bridgeJson: { source: "wecomcatch", mode: "candidateOnly", records: [] },
    });
    expect(mocks.studentFindMany).toHaveBeenCalledOnce();
  });

  it("rejects invalid LLM JSON before import or database writes can happen", async () => {
    mocks.completionCreate.mockResolvedValue({
      choices: [{ message: { content: "这不是 JSON" } }],
    });

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" }))
      .rejects.toThrow("LLM 未返回合法 JSON");
    expect(mocks.studentFindMany).toHaveBeenCalledOnce();
  });
});
