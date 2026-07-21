import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import type { ChatCompletion } from "openai/resources/chat/completions";

export interface GenerateWeComBridgeInput {
  sourceText?: string;
  exportPath?: string;
  candidateStudentIds?: string[];
  groundedMessages?: Array<{ id: string; content: string }>;
}

export interface WeComExtractionDiagnostics {
  modelName: string;
  finishReason: string | null;
  promptTokens: number | null;
  reasoningTokens: number | null;
  completionTokens: number | null;
  responseCharacters: number;
  protocol: "json_schema" | "json_object";
}

export interface GenerateWeComBridgeResult {
  sourceLabel: string;
  bridgeJson: unknown;
  rawOutput: string;
  diagnostics: WeComExtractionDiagnostics;
}

export type WeComExtractionErrorCode =
  | "protocol_incompatible"
  | "output_truncated"
  | "schema_invalid"
  | "network_error"
  | "provider_error"
  | "oversized_message"
  | "evidence_mismatch";

export class WeComExtractionError extends Error {
  constructor(
    public readonly code: WeComExtractionErrorCode,
    message: string,
    public readonly diagnostics?: Partial<WeComExtractionDiagnostics>,
  ) {
    super(message);
    this.name = "WeComExtractionError";
  }
}

interface GenerateWeComBridgeOptions {
  onRetry?: (reason: "network" | "schema") => void;
}

const legacyBridgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "mode", "records"],
  properties: {
    source: { type: "string", enum: ["wecomcatch"] },
    mode: { type: "string", enum: ["candidateOnly"] },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind", "source", "matchedStudent", "occurredAt", "sessionCode", "target",
          "summary", "summaryForChemTrack", "feedbackContext", "attentionSignals", "confidence",
        ],
        properties: {
          kind: { type: "string", enum: ["communication"] },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["conversationId", "conversationTitle", "messageIds"],
            properties: {
              conversationId: { type: ["string", "null"] },
              conversationTitle: { type: "string" },
              messageIds: { type: "array", items: { type: "string" } },
            },
          },
          matchedStudent: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name", "studentId", "confidence"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              studentId: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
          },
          occurredAt: { type: "string" },
          sessionCode: { type: ["string", "null"] },
          target: { type: "string" },
          summary: { type: "string" },
          summaryForChemTrack: { type: "string" },
          feedbackContext: {
            type: "object",
            additionalProperties: false,
            required: ["toneHint", "nextAction"],
            properties: {
              toneHint: { type: "string" },
              nextAction: { type: "string" },
            },
          },
          attentionSignals: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["reason", "confidence", "evidenceSummary"],
              properties: {
                reason: {
                  type: "string",
                  enum: [
                    "academic-performance", "learning-confidence", "parent-concern", "withdrawal-intent",
                  ],
                },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                evidenceSummary: { type: "string" },
              },
            },
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
} as const;

const groundedBridgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "mode", "records"],
  properties: {
    source: { type: "string", enum: ["wecomcatch"] },
    mode: { type: "string", enum: ["candidateOnly"] },
    records: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["matchedStudent", "messageIds", "factualSummary", "evidence", "confidence"],
        properties: {
          matchedStudent: {
            type: "object",
            additionalProperties: false,
            required: ["id", "confidence"],
            properties: {
              id: { type: "string", minLength: 1 },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
          },
          messageIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          factualSummary: { type: "string", minLength: 10, maxLength: 300 },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["messageId", "quote"],
              properties: {
                messageId: { type: "string", minLength: 1 },
                quote: { type: "string", minLength: 4, maxLength: 160 },
              },
            },
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
} as const;

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorStatus(error: unknown) {
  return Number((error as { status?: unknown })?.status || 0);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function isReasoningUnsupported(error: unknown) {
  return [400, 404, 422].includes(errorStatus(error))
    && /reasoning[_ -]?effort|reasoning.*(?:unsupported|invalid|unknown|extra)/i.test(errorText(error));
}

function isSchemaUnsupported(error: unknown) {
  return [400, 404, 422].includes(errorStatus(error))
    && /response[_ -]?format|json[_ -]?schema|structured output|schema.*(?:unsupported|invalid|unknown)/i.test(errorText(error));
}

function isJsonObjectUnsupported(error: unknown) {
  return [400, 404, 422].includes(errorStatus(error))
    && /response[_ -]?format|json[_ -]?object|json mode/i.test(errorText(error));
}

function isNetworkError(error: unknown) {
  const status = errorStatus(error);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function parseJsonObject(text: string) {
  try {
    return JSON.parse(text.trim()) as Record<string, unknown>;
  } catch {
    throw new WeComExtractionError("schema_invalid", "LLM 返回内容不是合法 JSON");
  }
}

function normalizeEvidenceText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function validateWeComBridgeJson(
  value: Record<string, unknown>,
  groundedMessages?: Array<{ id: string; content: string }>,
  candidateStudentIds: string[] = [],
) {
  if (value.source !== "wecomcatch" || value.mode !== "candidateOnly" || !Array.isArray(value.records)) {
    throw new WeComExtractionError("schema_invalid", "LLM 返回 JSON 不符合企微候选结构");
  }
  if (groundedMessages) {
    const messages = new Map(groundedMessages.map((message) => [message.id, normalizeEvidenceText(message.content)]));
    const allowedStudents = new Set(candidateStudentIds);
    for (const recordValue of value.records) {
      const record = recordValue && typeof recordValue === "object" ? recordValue as Record<string, unknown> : null;
      const student = record?.matchedStudent && typeof record.matchedStudent === "object"
        ? record.matchedStudent as Record<string, unknown>
        : null;
      const messageIds = Array.isArray(record?.messageIds)
        ? [...new Set(record.messageIds.filter((item): item is string => (
          typeof item === "string" && item.trim().length > 0
        )))]
        : [];
      const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
      const summary = clean(record?.factualSummary);
      if (
        !student
        || typeof student.id !== "string"
        || !allowedStudents.has(student.id)
        || student.confidence !== "high"
        || record?.confidence !== "high"
        || messageIds.length === 0
        || summary.length < 10
        || summary.length > 300
        || evidence.length < 1
        || evidence.length > 3
      ) {
        throw new WeComExtractionError("evidence_mismatch", "模型记录缺少可自动写入的高置信度事实证据");
      }
      for (const evidenceValue of evidence) {
        const item = evidenceValue && typeof evidenceValue === "object"
          ? evidenceValue as Record<string, unknown>
          : null;
        const messageId = clean(item?.messageId);
        const quote = normalizeEvidenceText(clean(item?.quote));
        if (
          !messageIds.includes(messageId)
          || !messages.has(messageId)
          || quote.length < 4
          || quote.length > 160
          || !messages.get(messageId)?.includes(quote)
        ) {
          throw new WeComExtractionError("evidence_mismatch", "模型引用的原文证据与消息内容不一致");
        }
      }
    }
    return value;
  }
  for (const recordValue of value.records) {
    const record = recordValue && typeof recordValue === "object"
      ? recordValue as Record<string, unknown>
      : null;
    const source = record?.source && typeof record.source === "object"
      ? record.source as Record<string, unknown>
      : null;
    const student = record?.matchedStudent && typeof record.matchedStudent === "object"
      ? record.matchedStudent as Record<string, unknown>
      : null;
    if (
      record?.kind !== "communication"
      || !source
      || !Array.isArray(source.messageIds)
      || !student
      || typeof student.id !== "string"
      || typeof record.summaryForChemTrack !== "string"
      || !Array.isArray(record.attentionSignals)
    ) {
      throw new WeComExtractionError("schema_invalid", "LLM 返回的企微记录未通过 Schema 校验");
    }
  }
  return value;
}

async function loadSource(input: GenerateWeComBridgeInput) {
  const sourceText = clean(input.sourceText);
  if (sourceText) return { text: sourceText, sourceLabel: "粘贴的企微文本" };

  const exportPath = clean(input.exportPath);
  if (!exportPath) throw new Error("缺少企微导出文本或文件路径");
  const resolvedPath = resolve(exportPath);
  return { text: await readFile(resolvedPath, "utf8"), sourceLabel: resolvedPath };
}

type CompletionClient = ReturnType<typeof createLLMClient>;
type CompletionResponse = ChatCompletion;

async function callOnceWithNetworkRetry(
  create: () => Promise<CompletionResponse>,
  onRetry?: GenerateWeComBridgeOptions["onRetry"],
) {
  try {
    return await create();
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    onRetry?.("network");
    try {
      return await create();
    } catch (retryError) {
      if (isNetworkError(retryError)) {
        throw new WeComExtractionError("network_error", "LLM 网络请求连续失败");
      }
      throw retryError;
    }
  }
}

async function createStructuredCompletion(
  client: CompletionClient,
  model: string,
  prompt: string,
  temperature: number,
  schema: typeof legacyBridgeSchema | typeof groundedBridgeSchema,
  onRetry?: GenerateWeComBridgeOptions["onRetry"],
): Promise<{ response: CompletionResponse; protocol: "json_schema" | "json_object" }> {
  const base = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    temperature,
    max_tokens: 8192,
  };
  const schemaFormat = {
    type: "json_schema" as const,
    json_schema: { name: "wecom_candidate", strict: true, schema },
  };

  try {
    const response = await callOnceWithNetworkRetry(() => client.chat.completions.create({
      ...base,
      response_format: schemaFormat,
      reasoning_effort: "none",
    }), onRetry);
    return { response, protocol: "json_schema" };
  } catch (error) {
    if (isReasoningUnsupported(error)) {
      try {
        const response = await callOnceWithNetworkRetry(() => client.chat.completions.create({
          ...base,
          response_format: schemaFormat,
        }), onRetry);
        return { response, protocol: "json_schema" };
      } catch (schemaError) {
        if (!isSchemaUnsupported(schemaError)) throw classifyProviderError(schemaError);
      }
    } else if (!isSchemaUnsupported(error)) {
      throw classifyProviderError(error);
    }
  }

  try {
    const response = await callOnceWithNetworkRetry(() => client.chat.completions.create({
      ...base,
      response_format: { type: "json_object" },
    }), onRetry);
    return { response, protocol: "json_object" };
  } catch (error) {
    if (isJsonObjectUnsupported(error) || isSchemaUnsupported(error)) {
      throw new WeComExtractionError(
        "protocol_incompatible",
        "当前企微提取模型不支持 JSON Schema 或 JSON Object 结构化输出",
      );
    }
    throw classifyProviderError(error);
  }
}

function classifyProviderError(error: unknown): WeComExtractionError {
  if (error instanceof WeComExtractionError) return error;
  if (isNetworkError(error)) return new WeComExtractionError("network_error", "LLM 网络请求失败");
  return new WeComExtractionError("provider_error", `LLM 服务拒绝请求（HTTP ${errorStatus(error) || "未知"}）`);
}

function completionDiagnostics(
  response: CompletionResponse,
  modelName: string,
  protocol: "json_schema" | "json_object",
  responseCharacters: number,
): WeComExtractionDiagnostics {
  const usage = response.usage;
  const details = usage?.completion_tokens_details as { reasoning_tokens?: number } | undefined;
  return {
    modelName,
    finishReason: response.choices[0]?.finish_reason ?? null,
    promptTokens: usage?.prompt_tokens ?? null,
    reasoningTokens: details?.reasoning_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    responseCharacters,
    protocol,
  };
}

function extractCompletion(
  response: CompletionResponse,
  modelName: string,
  protocol: "json_schema" | "json_object",
  groundedMessages?: Array<{ id: string; content: string }>,
  candidateStudentIds: string[] = [],
) {
  const rawOutput = response.choices[0]?.message?.content?.trim() || "";
  const diagnostics = completionDiagnostics(response, modelName, protocol, rawOutput.length);
  if (diagnostics.finishReason === "length") {
    throw new WeComExtractionError("output_truncated", "LLM 输出达到长度上限", diagnostics);
  }
  if (diagnostics.finishReason !== "stop") {
    throw new WeComExtractionError(
      "provider_error",
      `LLM 未正常结束（${diagnostics.finishReason || "缺少结束原因"}）`,
      diagnostics,
    );
  }
  if (!rawOutput) throw new WeComExtractionError("schema_invalid", "LLM 未返回企微候选 JSON", diagnostics);
  try {
    return {
      bridgeJson: validateWeComBridgeJson(parseJsonObject(rawOutput), groundedMessages, candidateStudentIds),
      rawOutput,
      diagnostics,
    };
  } catch (error) {
    if (error instanceof WeComExtractionError) {
      throw new WeComExtractionError(error.code, error.message, diagnostics);
    }
    throw error;
  }
}

export async function generateWeComBridgeJson(
  prisma: PrismaClient,
  input: GenerateWeComBridgeInput,
  options: GenerateWeComBridgeOptions = {},
): Promise<GenerateWeComBridgeResult> {
  const { text, sourceLabel } = await loadSource(input);
  const candidateStudentIds = Array.isArray(input.candidateStudentIds)
    ? [...new Set(input.candidateStudentIds.filter((id) => typeof id === "string" && id.trim()))]
    : [];
  let roster: Array<{
    id: string;
    name: string;
    studentId: string;
    className: string;
    recentCommunications: string[];
  }>;
  if (candidateStudentIds.length > 0) {
    const students = await prisma.student.findMany({
      where: { id: { in: candidateStudentIds } },
      select: {
        id: true,
        name: true,
        studentId: true,
        class: { select: { name: true, code: true } },
        communications: {
          select: { summary: true },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { studentId: "asc" },
    });
    roster = students.map((student) => ({
      id: student.id,
      name: student.name,
      studentId: student.studentId,
      className: student.class?.name ?? student.class?.code ?? "",
      recentCommunications: student.communications.map((item) => item.summary),
    }));
  } else {
    const students = await prisma.student.findMany({
      select: {
        id: true,
        name: true,
        studentId: true,
        class: { select: { name: true, code: true } },
      },
      orderBy: { studentId: "asc" },
    });
    roster = students
      .filter((student) => student.name.trim() && text.includes(student.name.trim()))
      .map((student) => ({
        id: student.id,
        name: student.name,
        studentId: student.studentId,
        className: student.class?.name ?? student.class?.code ?? "",
        recentCommunications: [],
      }));
  }
  if (roster.length === 0) throw new Error("未能从聊天内容中确定候选学生，请先补充学生姓名");

  const grounded = Array.isArray(input.groundedMessages);
  const prompt = grounded
    ? `你是 Chem-Track 的企微事实提取器。只提取当前连续交流段中能由原文逐字证明、且能唯一绑定学生的长期沟通事实。

学生候选：
${JSON.stringify(roster.map((student) => ({ id: student.id, name: student.name, studentId: student.studentId })), null, 2)}

输出必须严格符合 JSON Schema。每条记录只能使用候选学生 ID，matchedStudent.confidence 和 confidence 都必须基于原文判断。messageIds 只引用支撑该事实的输入消息。evidence 必须提供 1 至 3 条输入消息中逐字存在的短句，不得改写标点、措辞或补充推断。factualSummary 只概括已经明确发生或明确约定的事实；不得生成建议、语气、评价、课次、沟通对象、未来计划或关注标签。没有足够逐字证据时 records 返回空数组。

当前连续交流段：
${text}`
    : `你是 Chem-Track 的企微家校沟通提取器。请从当前连续交流段中提取对“课后反馈”有长期价值、且能明确绑定到某个学生的家校沟通信息。

学生名单：
${JSON.stringify(roster, null, 2)}

输出必须严格符合提供的 JSON Schema。只生成 kind=communication 的记录；没有有价值的新事实时 records 返回空数组。不能明确匹配唯一学生时 confidence 填 low，不得臆测。没有明确课次时 sessionCode 填 null。summaryForChemTrack 保留家长关注点、学生状态、后续反馈口径或行动建议。attentionSignals 只根据明确文字事实识别 academic-performance、learning-confidence、parent-concern、withdrawal-intent，没有时返回空数组。输入提供的会话 ID 和消息 ID 必须照抄，messageIds 只包含支撑记录的输入消息 ID。只是重复 recentCommunications 且没有新事实、新变化或新行动时不生成记录。

当前连续交流段：
${text}`;

  const client = createLLMClient("wecomExtraction");
  const model = getLLMModel("wecomExtraction");
  const schema = grounded ? groundedBridgeSchema : legacyBridgeSchema;
  const first = await createStructuredCompletion(client, model, prompt, 0.1, schema, options.onRetry);
  try {
    return {
      sourceLabel,
      ...extractCompletion(first.response, model, first.protocol, input.groundedMessages, candidateStudentIds),
    };
  } catch (error) {
    if (!(error instanceof WeComExtractionError) || error.code !== "schema_invalid") throw error;
    options.onRetry?.("schema");
  }

  const retryPrompt = `${prompt}\n\n上一次输出未通过 Schema 校验。请重新完整提取，只返回符合 Schema 的 JSON。`;
  const retry = await createStructuredCompletion(client, model, retryPrompt, 0, schema, options.onRetry);
  try {
    return {
      sourceLabel,
      ...extractCompletion(retry.response, model, retry.protocol, input.groundedMessages, candidateStudentIds),
    };
  } catch (error) {
    if (error instanceof WeComExtractionError && error.code === "schema_invalid") {
      throw new WeComExtractionError(
        "schema_invalid",
        "LLM 连续两次未返回符合 Schema 的企微候选 JSON",
        error.diagnostics,
      );
    }
    throw error;
  }
}
