import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateWeComBridgeJson,
  WeComExtractionError,
} from "@/services/wecom-bridge-service";

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
}));

const prisma = { student: { findMany: mocks.studentFindMany } } as any;

function completion(content = '{"source":"wecomcatch","mode":"candidateOnly","records":[]}', options: {
  finishReason?: string;
  reasoningTokens?: number;
} = {}) {
  return {
    id: "test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{
      index: 0,
      finish_reason: options.finishReason ?? "stop",
      message: { role: "assistant", content, refusal: null },
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
    expect(request.reasoning_effort).toBe("none");
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
});
