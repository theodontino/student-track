import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateWeComBridgeJson,
  validateWeComBridgeJson,
  WeComExtractionError,
} from "@/services/wecom-handoff-extraction-service";

const mocks = vi.hoisted(() => ({
  completionCreate: vi.fn(),
  createClient: vi.fn(),
  getModel: vi.fn(),
  studentFindMany: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({
  createLLMClient: (role?: string) => {
    mocks.createClient(role);
    return { chat: { completions: { create: mocks.completionCreate } } };
  },
  getLLMModel: (role?: string) => {
    mocks.getModel(role);
    return "test-model";
  },
  getLLMCompletionOptions: () => ({ max_tokens: 8192 }),
}));

const prisma = { student: { findMany: mocks.studentFindMany } } as any;

function completion(content = '{"source":"wecomcatch","mode":"candidateOnly","records":[]}', options: {
  finishReason?: string;
  reasoningTokens?: number;
  reasoningContent?: string;
} = {}) {
  return {
    id: "test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{
      index: 0,
      finish_reason: options.finishReason ?? "stop",
      message: { role: "assistant", content, reasoning_content: options.reasoningContent, refusal: null },
      logprobs: null,
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 6,
      total_tokens: 16,
      completion_tokens_details: { reasoning_tokens: options.reasoningTokens ?? 0 },
    },
  };
}

describe("wecom bridge service", () => {
  beforeEach(() => {
    mocks.completionCreate.mockReset();
    mocks.createClient.mockReset();
    mocks.getModel.mockReset();
    mocks.studentFindMany.mockReset().mockResolvedValue([{
      id: "student-1",
      name: "张三",
      studentId: "S001",
      class: { name: "测试班", code: "T-1" },
      communications: [],
    }]);
  });

  it("uses the dedicated extraction role, JSON Schema, and disabled reasoning", async () => {
    mocks.completionCreate.mockResolvedValue(completion());

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" })).resolves.toMatchObject({
      sourceLabel: "粘贴的企微文本",
      bridgeJson: { source: "wecomcatch", mode: "candidateOnly", records: [] },
      diagnostics: {
        modelName: "test-model",
        finishReason: "stop",
        reasoningTokens: 0,
        protocol: "json_schema",
      },
    });
    expect(mocks.createClient).toHaveBeenCalledWith("wecomExtraction");
    expect(mocks.getModel).toHaveBeenCalledWith("wecomExtraction");
    const request = mocks.completionCreate.mock.calls[0][0];
    expect(request.response_format.type).toBe("json_schema");
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.reasoning_effort).toBeUndefined();
  });

  it("accepts a JSON Schema response carried by LM Studio reasoning_content", async () => {
    mocks.completionCreate.mockResolvedValue(completion("", {
      reasoningContent: '{"source":"wecomcatch","mode":"candidateOnly","records":[]}',
      reasoningTokens: 5,
    }));

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" }))
      .resolves.toMatchObject({
        bridgeJson: { source: "wecomcatch", mode: "candidateOnly", records: [] },
        diagnostics: { reasoningTokens: 5, protocol: "json_schema" },
      });
  });

  it("keeps JSON Schema when only the reasoning parameter is unsupported", async () => {
    mocks.completionCreate
      .mockRejectedValueOnce(Object.assign(new Error("reasoning_effort is unsupported"), { status: 400 }))
      .mockResolvedValueOnce(completion());

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" }))
      .resolves.toMatchObject({ diagnostics: { protocol: "json_schema" } });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.completionCreate.mock.calls[1][0].response_format.type).toBe("json_schema");
    expect(mocks.completionCreate.mock.calls[1][0].reasoning_effort).toBeUndefined();
  });

  it("falls back from unsupported Schema to JSON Object but never plain text", async () => {
    mocks.completionCreate
      .mockRejectedValueOnce(Object.assign(new Error("response_format json_schema is unsupported"), { status: 400 }))
      .mockResolvedValueOnce(completion());

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" }))
      .resolves.toMatchObject({ diagnostics: { protocol: "json_object" } });
    expect(mocks.completionCreate.mock.calls[1][0].response_format).toEqual({ type: "json_object" });
    expect(mocks.completionCreate.mock.calls.every(([request]) => request.response_format)).toBe(true);
  });

  it("stops when both structured protocols are unsupported", async () => {
    mocks.completionCreate
      .mockRejectedValueOnce(Object.assign(new Error("response_format json_schema is unsupported"), { status: 400 }))
      .mockRejectedValueOnce(Object.assign(new Error("response_format json_object is unsupported"), { status: 400 }));

    const promise = generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" });
    await expect(promise).rejects.toMatchObject({ code: "protocol_incompatible" } satisfies Partial<WeComExtractionError>);
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
  });

  it("reports length truncation without retrying the same request", async () => {
    mocks.completionCreate.mockResolvedValue(completion('{"source":"wecomcatch"', { finishReason: "length", reasoningTokens: 8000 }));

    await expect(generateWeComBridgeJson(prisma, { sourceText: "张三妈妈：最近希望多鼓励。" }))
      .rejects.toMatchObject({
        code: "output_truncated",
        diagnostics: { finishReason: "length", reasoningTokens: 8000 },
      } satisfies Partial<WeComExtractionError>);
    expect(mocks.completionCreate).toHaveBeenCalledOnce();
  });

  it("retries one Schema-invalid response using structured output", async () => {
    const onRetry = vi.fn();
    mocks.completionCreate
      .mockResolvedValueOnce(completion('{"source":"wecomcatch","mode":"candidateOnly"}'))
      .mockResolvedValueOnce(completion());

    await expect(generateWeComBridgeJson(
      prisma,
      { sourceText: "张三妈妈：最近希望多鼓励。" },
      { onRetry },
    )).resolves.toMatchObject({ bridgeJson: { records: [] } });
    expect(onRetry).toHaveBeenCalledWith("schema");
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.completionCreate.mock.calls[1][0].response_format.type).toBe("json_schema");
  });

  it("retries one network error and then succeeds", async () => {
    const onRetry = vi.fn();
    mocks.completionCreate
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(completion());

    await expect(generateWeComBridgeJson(
      prisma,
      { sourceText: "张三妈妈：最近希望多鼓励。" },
      { onRetry },
    )).resolves.toMatchObject({ bridgeJson: { records: [] } });
    expect(onRetry).toHaveBeenCalledWith("network");
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
  });

  it("accepts a grounded fact only when the quote exists in the cited message", async () => {
    mocks.completionCreate.mockResolvedValue(completion(JSON.stringify({
      source: "wecomcatch",
      mode: "candidateOnly",
      records: [{
        matchedStudent: { id: "student-1", confidence: "high" },
        messageIds: ["M001"],
        factualSummary: "家长明确表示学生近期希望获得更多鼓励。",
        feedbackUse: { relevant: true, category: "learning-confidence", priority: "high" },
        preferenceSignals: [],
        evidence: [{ messageId: "M001", quote: "最近希望多鼓励" }],
        confidence: "high",
      }],
    })));

    await expect(generateWeComBridgeJson(prisma, {
      sourceText: "[message-1] 最近希望多鼓励",
      candidateStudentIds: ["student-1"],
      groundedMessages: [{ id: "message-1", content: "最近希望多鼓励。" }],
    })).resolves.toMatchObject({
      bridgeJson: {
        records: [{
          messageIds: ["message-1"],
          evidence: [{ messageId: "message-1" }],
          factualSummary: expect.any(String),
        }],
      },
    });
    expect(mocks.completionCreate.mock.calls[0][0].messages[0].content).toContain("M001");
    expect(mocks.completionCreate.mock.calls[0][0].messages[0].content).not.toContain("[message-1]");
    const schema = mocks.completionCreate.mock.calls[0][0].response_format.json_schema.schema;
    expect(schema.properties.records.items.required).toContain("evidence");
    expect(schema.properties.records.items.required).toContain("feedbackUse");
    expect(schema.properties.records.items.required).toContain("preferenceSignals");
  });

  it("extracts explicit delivery preferences with separately grounded signals", async () => {
    mocks.completionCreate.mockResolvedValue(completion(JSON.stringify({
      source: "wecomcatch",
      mode: "candidateOnly",
      records: [{
        matchedStudent: { id: "student-1", confidence: "high" },
        messageIds: ["M001"],
        factualSummary: "家长明确偏好简短文字反馈，并接受微信电话沟通。",
        feedbackUse: { relevant: true, category: "feedback-preference", priority: "high" },
        preferenceSignals: [
          { field: "length", value: "short", messageId: "M001", quote: "简短文字反馈" },
          { field: "deliveryChannel", value: "text", messageId: "M001", quote: "文字反馈" },
          { field: "phoneContact", value: "accepted", messageId: "M001", quote: "可以微信电话" },
        ],
        evidence: [{ messageId: "M001", quote: "简短文字反馈" }],
        confidence: "high",
      }],
    })));

    await expect(generateWeComBridgeJson(prisma, {
      sourceText: "[message-1] 可以微信电话，简短文字反馈即可。",
      candidateStudentIds: ["student-1"],
      groundedMessages: [{ id: "message-1", content: "可以微信电话，简短文字反馈即可。", direction: "incoming" }],
    })).resolves.toMatchObject({
      bridgeJson: { records: [{ preferenceSignals: [
        { field: "length", value: "short", messageId: "message-1" },
        { field: "deliveryChannel", value: "text", messageId: "message-1" },
        { field: "phoneContact", value: "accepted", messageId: "message-1" },
      ] }] },
    });
  });

  it("rejects a preference signal grounded in an outgoing teacher message", () => {
    expect(() => validateWeComBridgeJson({
      source: "wecomcatch",
      mode: "candidateOnly",
      records: [{
        matchedStudent: { id: "student-1", confidence: "high" },
        messageIds: ["message-1"],
        factualSummary: "老师询问家长是否希望简短文字反馈。",
        feedbackUse: { relevant: true, category: "feedback-preference", priority: "medium" },
        preferenceSignals: [{ field: "length", value: "short", messageId: "message-1", quote: "简短文字反馈" }],
        evidence: [{ messageId: "message-1", quote: "简短文字反馈" }],
        confidence: "high",
      }],
    }, [{
      id: "message-1",
      content: "是否希望简短文字反馈？",
      direction: "outgoing",
    }], ["student-1"])).toThrow(WeComExtractionError);
  });

  it("rejects invented evidence after one corrective retry", async () => {
    mocks.completionCreate.mockResolvedValue(completion(JSON.stringify({
      source: "wecomcatch",
      mode: "candidateOnly",
      records: [{
        matchedStudent: { id: "student-1", confidence: "high" },
        messageIds: ["M001"],
        factualSummary: "家长明确表示学生准备参加额外课程。",
        feedbackUse: { relevant: true, category: "parent-concern", priority: "medium" },
        preferenceSignals: [],
        evidence: [{ messageId: "M001", quote: "准备参加额外课程" }],
        confidence: "high",
      }],
    })));

    await expect(generateWeComBridgeJson(prisma, {
      sourceText: "[message-1] 最近希望多鼓励",
      candidateStudentIds: ["student-1"],
      groundedMessages: [{ id: "message-1", content: "最近希望多鼓励。" }],
    })).rejects.toMatchObject({ code: "evidence_mismatch" });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.completionCreate.mock.calls[1][0].messages[0].content).toContain("上一次输出未通过结构或证据校验");
  });
});
