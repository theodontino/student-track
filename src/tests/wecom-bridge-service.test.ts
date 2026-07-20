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
    expect(mocks.studentFindMany.mock.calls[0][0].select).not.toHaveProperty("communications");
    expect(mocks.completionCreate.mock.calls[0][0].messages[0].content).toContain("attentionSignals");
    expect(mocks.completionCreate.mock.calls[0][0].response_format).toEqual({ type: "json_object" });
  });

  it("includes recent communications only for explicitly constrained students", async () => {
    mocks.studentFindMany.mockResolvedValueOnce([{
      id: "student-1",
      name: "张三",
      studentId: "S001",
      class: { name: "测试班", code: "T-1" },
      communications: [{ summary: "仅当前学生的历史摘要" }],
    }]);
    mocks.completionCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
    });

    await generateWeComBridgeJson(prisma, {
      sourceText: "张三妈妈：最近希望多鼓励。",
      candidateStudentIds: ["student-1"],
    });

    expect(mocks.studentFindMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ["student-1"] } },
    });
    expect(mocks.studentFindMany.mock.calls[0][0].select).toHaveProperty("communications");
    expect(mocks.completionCreate.mock.calls[0][0].messages[0].content)
      .toContain("仅当前学生的历史摘要");
  });

  it("automatically retries one malformed JSON response", async () => {
    const onRetry = vi.fn();
    mocks.completionCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"source":"wecomcatch" "records":[]}' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"source":"wecomcatch","mode":"candidateOnly","records":[]}' } }] });

    await expect(generateWeComBridgeJson(
      prisma,
      { sourceText: "张三妈妈：最近希望多鼓励。" },
      { onRetry },
    )).resolves.toMatchObject({ bridgeJson: { records: [] } });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.completionCreate.mock.calls[1][0].temperature).toBe(0);
  });

  it("falls back when an OpenAI-compatible provider does not support JSON mode", async () => {
    mocks.completionCreate
      .mockRejectedValueOnce(Object.assign(new Error("response_format json_object is unsupported"), { status: 400 }))
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"source":"wecomcatch","mode":"candidateOnly","records":[]}' } }] });

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" }))
      .resolves.toMatchObject({ bridgeJson: { records: [] } });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.completionCreate.mock.calls[0][0].response_format).toEqual({ type: "json_object" });
    expect(mocks.completionCreate.mock.calls[1][0].response_format).toBeUndefined();
  });

  it("rejects invalid LLM JSON before import or database writes can happen", async () => {
    mocks.completionCreate.mockResolvedValue({
      choices: [{ message: { content: "这不是 JSON" } }],
    });

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" }))
      .rejects.toThrow("LLM 连续两次未返回合法的企微候选 JSON");
    expect(mocks.studentFindMany).toHaveBeenCalledOnce();
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
  });
});
