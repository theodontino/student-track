import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  getLLMCompletionOptions: () => ({ max_tokens: 4096, reasoning_effort: "low" }),
}));
import { WeComExtractionError } from "@/services/wecom-handoff-extraction-service";
import {
  callLlmWithSchemaFallback,
  parsePreReviewText,
  readPreReviewError,
  type PreReviewSuggestion,
} from "@/services/wecom-prereview-service";

type CompletionResponse = { choices: Array<{ message: { content: string | null; reasoning_content?: string | null } }> };

function clientWith(...responses: Array<CompletionResponse | Error>): {
  client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) create.mockRejectedValueOnce(response);
    else create.mockResolvedValueOnce(response);
  }
  return {
    client: { chat: { completions: { create } } },
    create,
  };
}

describe("parsePreReviewText", () => {
  it("parses a clean JSON verdict", () => {
    const result = parsePreReviewText(JSON.stringify({
      verdict: "confirm",
      confidence: 0.91,
      reason: "沟通内容、关联学生都清晰",
      flags: ["learning-progress"],
    }));
    expect(result).toEqual<PreReviewSuggestion>({
      verdict: "confirm",
      confidence: 0.91,
      reason: "沟通内容、关联学生都清晰",
      flags: ["learning-progress"],
    });
  });

  it("strips markdown code fences before parsing", () => {
    const fenced = "```json\n" + JSON.stringify({
      verdict: "reject",
      confidence: 0.2,
      reason: "消息无价值",
      flags: [],
    }) + "\n```";
    expect(parsePreReviewText(fenced).verdict).toBe("reject");
  });

  it("extracts the first JSON object when the model adds prose", () => {
    const wrapped = "好的，我的建议如下：" + JSON.stringify({
      verdict: "review",
      confidence: 0.4,
      reason: "存在歧义",
      flags: ["同名"],
    }) + "  请教师复核。";
    const result = parsePreReviewText(wrapped);
    expect(result.verdict).toBe("review");
    expect(result.reason).toBe("存在歧义");
  });

  it("falls back to the verdict keyword when the response is not JSON", () => {
    const result = parsePreReviewText("I think this should be: confirm because the student matches.");
    expect(result.verdict).toBe("confirm");
    expect(result.confidence).toBe(0);
    expect(result.flags).toContain("parse_fallback");
  });

  it("clamps invalid confidence values and defaults reason when missing", () => {
    const result = parsePreReviewText(JSON.stringify({ verdict: "confirm", confidence: 1.7 }));
    expect(result.verdict).toBe("confirm");
    expect(result.confidence).toBe(1);
    expect(result.reason).toBe("LLM 未提供原因");
  });

  it("coerces unknown verdict values to review", () => {
    const result = parsePreReviewText(JSON.stringify({ verdict: "approve", confidence: 0.5, reason: "误判" }));
    expect(result.verdict).toBe("review");
  });

  it("truncates flags beyond 8 entries and 60 characters each", () => {
    const flags = Array.from({ length: 12 }, (_, index) => `${index}-`.repeat(20));
    const result = parsePreReviewText(JSON.stringify({
      verdict: "review",
      confidence: 0.3,
      reason: "需要关注",
      flags,
    }));
    expect(result.flags).toHaveLength(8);
    expect(result.flags.every((flag) => flag.length <= 60)).toBe(true);
  });

  it("throws when no verdict keyword can be recovered", () => {
    expect(() => parsePreReviewText("not even close to JSON")).toThrow(WeComExtractionError);
  });

  it("exposes persisted pre-review errors instead of treating them as unreviewed", () => {
    expect(readPreReviewError(JSON.stringify({ verdict: "review", error: "schema_invalid: empty content" })))
      .toBe("schema_invalid: empty content");
    expect(readPreReviewError(JSON.stringify({ verdict: "review" }))).toBeNull();
  });
});

describe("callLlmWithSchemaFallback", () => {
  const basePrompt = { system: "你是预审助手", user: "{\"draftId\":\"wcc-1\"}" };
  const okText = JSON.stringify({ verdict: "confirm", confidence: 0.8, reason: "ok", flags: [] });

  it("uses json_schema on the first attempt when supported", async () => {
    const { client, create } = clientWith({ choices: [{ message: { content: okText } }] });
    const result = await callLlmWithSchemaFallback(
      client as never,
      "test-model",
      basePrompt.system,
      basePrompt.user,
    );
    expect(result.protocol).toBe("json_schema");
    expect(result.model).toBe("test-model");
    expect(result.text).toBe(okText);
    const payload = create.mock.calls[0][0];
    expect(payload.response_format.type).toBe("json_schema");
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload.reasoning_effort).toBe("low");
    expect(payload).not.toHaveProperty("temperature");
  });

  it("downgrades to json_object when the provider rejects json_schema", async () => {
    const schemaError = new WeComExtractionError("protocol_incompatible", "response_format 不支持");
    const { client, create } = clientWith(
      schemaError,
      { choices: [{ message: { content: okText } }] },
    );
    const result = await callLlmWithSchemaFallback(
      client as never,
      "test-model",
      basePrompt.system,
      basePrompt.user,
    );
    expect(result.protocol).toBe("json_object");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].response_format).toEqual({ type: "json_object" });
    expect(create.mock.calls[1][0].reasoning_effort).toBe("low");
  });

  it("downgrades to plain text when both json_schema and json_object fail", async () => {
    const schemaError = new WeComExtractionError("protocol_incompatible", "json_schema 不可用");
    const objectError = new WeComExtractionError("protocol_incompatible", "json_object 不可用");
    const plainText = '{"verdict":"review","confidence":0.3,"reason":"兜底解析","flags":[]}';
    const { client, create } = clientWith(
      schemaError,
      objectError,
      { choices: [{ message: { content: plainText } }] },
    );
    const result = await callLlmWithSchemaFallback(
      client as never,
      "test-model",
      basePrompt.system,
      basePrompt.user,
    );
    expect(result.protocol).toBe("plain");
    expect(create).toHaveBeenCalledTimes(3);
    const thirdCall = create.mock.calls[2][0];
    expect(thirdCall.response_format).toBeUndefined();
    expect(thirdCall.messages[0].content).toContain("严格要求：只用 JSON 格式回复");
    expect(thirdCall.reasoning_effort).toBe("low");
  });

  it("treats 400 unsupported errors as protocol incompatibility", async () => {
    const httpError = Object.assign(new Error("400 Bad Request: response_format not supported"), {
      status: 400,
    });
    const { client } = clientWith(
      httpError,
      { choices: [{ message: { content: okText } }] },
    );
    const result = await callLlmWithSchemaFallback(
      client as never,
      "test-model",
      basePrompt.system,
      basePrompt.user,
    );
    expect(result.protocol).toBe("json_object");
  });

  it("propagates hard errors such as missing API key", async () => {
    const authError = Object.assign(new Error("Missing API key"), { status: 401 });
    const { client } = clientWith(authError);
    await expect(
      callLlmWithSchemaFallback(client as never, "test-model", basePrompt.system, basePrompt.user),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("keeps the request compatible when the provider reports an unsupported reasoning hint", async () => {
    const reasoningError = Object.assign(new Error("400 Bad Request: reasoning_effort not supported by this model"), {
      status: 400,
    });
    const { client, create } = clientWith(
      reasoningError,
      { choices: [{ message: { content: okText } }] },
    );
    const result = await callLlmWithSchemaFallback(
      client as never,
      "test-model",
      basePrompt.system,
      basePrompt.user,
    );
    expect(result.protocol).toBe("json_schema");
    expect(create).toHaveBeenCalledTimes(2);
    // 首次携带低思考强度；兼容重试会明确去掉该字段。
    expect(create.mock.calls[0][0].reasoning_effort).toBe("low");
    expect(create.mock.calls[1][0].reasoning_effort).toBeUndefined();
  });

  it("uses reasoning_content when a local reasoning model leaves content empty", async () => {
    const { client } = clientWith({ choices: [{ message: {
      content: "",
      reasoning_content: okText,
    } }] });
    const result = await callLlmWithSchemaFallback(
      client as never,
      "local-reasoning-model",
      basePrompt.system,
      basePrompt.user,
    );
    expect(result.text).toBe(okText);
  });
});
