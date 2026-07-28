import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { FEEDBACK_COMMUNICATION_CATEGORIES } from "@/lib/feedback-communication";
import { createLLMClient, getLLMCompletionOptions, getLLMModel } from "@/lib/llm";
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
  | "model_not_found"
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

const candidateBridgeSchema = {
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
          "kind", "source", "matchedStudent", "occurredAt", "target",
          "summary", "summaryForStudentTrack", "feedbackUse", "feedbackContext", "attentionSignals", "confidence",
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
          target: { type: "string" },
          summary: { type: "string" },
          summaryForStudentTrack: { type: "string" },
          feedbackUse: {
            type: "object",
            additionalProperties: false,
            required: ["relevant", "category", "priority"],
            properties: {
              relevant: { type: "boolean" },
              category: { type: "string", enum: FEEDBACK_COMMUNICATION_CATEGORIES },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
          },
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
        required: ["matchedStudent", "messageIds", "factualSummary", "feedbackUse", "evidence", "confidence"],
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
          feedbackUse: {
            type: "object",
            additionalProperties: false,
            required: ["relevant", "category", "priority"],
            properties: {
              relevant: { type: "boolean", enum: [true] },
              category: { type: "string", enum: FEEDBACK_COMMUNICATION_CATEGORIES },
              priority: { type: "string", enum: ["high", "medium"] },
            },
          },
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

function groundedReferenceContext(
  sourceText: string,
  messages: Array<{ id: string; content: string }>,
) {
  const referenceToId = new Map<string, string>();
  const idToReference = new Map<string, string>();
  messages.forEach((message, index) => {
    const reference = `M${String(index + 1).padStart(3, "0")}`;
    referenceToId.set(reference, message.id);
    idToReference.set(message.id, reference);
  });
  let modelText = sourceText;
  for (const [messageId, reference] of idToReference) {
    modelText = modelText
      .replaceAll(`[消息ID:${messageId}]`, `[消息引用:${reference}]`)
      .replaceAll(`[${messageId}]`, `[消息引用:${reference}]`);
  }
  return {
    modelText,
    modelMessages: messages.map((message) => ({
      id: idToReference.get(message.id) as string,
      content: message.content,
    })),
    referenceToId,
  };
}

function restoreGroundedMessageIds(
  value: unknown,
  referenceToId: Map<string, string>,
) {
  const restored = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(restored.records)) return restored;
  for (const recordValue of restored.records) {
    if (!recordValue || typeof recordValue !== "object") continue;
    const record = recordValue as Record<string, unknown>;
    if (Array.isArray(record.messageIds)) {
      record.messageIds = record.messageIds.map((reference) => (
        typeof reference === "string" ? referenceToId.get(reference) ?? reference : reference
      ));
    }
    if (Array.isArray(record.evidence)) {
      for (const evidenceValue of record.evidence) {
        if (!evidenceValue || typeof evidenceValue !== "object") continue;
        const evidence = evidenceValue as Record<string, unknown>;
        if (typeof evidence.messageId === "string") {
          evidence.messageId = referenceToId.get(evidence.messageId) ?? evidence.messageId;
        }
      }
    }
  }
  return restored;
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
      const rawMessageIds = Array.isArray(record?.messageIds)
        ? record.messageIds.filter((item): item is string => (
          typeof item === "string" && item.trim().length > 0
        ))
        : [];
      const messageIds = Array.isArray(record?.messageIds)
        ? [...new Set(rawMessageIds)]
        : [];
      const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
      const summary = clean(record?.factualSummary);
      const feedbackUse = record?.feedbackUse && typeof record.feedbackUse === "object"
        ? record.feedbackUse as Record<string, unknown>
        : null;
      if (
        !student
        || typeof student.id !== "string"
        || !allowedStudents.has(student.id)
        || student.confidence !== "high"
        || record?.confidence !== "high"
        || messageIds.length === 0
        || messageIds.length !== rawMessageIds.length
        || summary.length < 10
        || summary.length > 300
        || !feedbackUse
        || feedbackUse.relevant !== true
        || !FEEDBACK_COMMUNICATION_CATEGORIES.includes(feedbackUse.category as typeof FEEDBACK_COMMUNICATION_CATEGORIES[number])
        || !["high", "medium"].includes(clean(feedbackUse.priority))
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
    const feedbackUse = record?.feedbackUse && typeof record.feedbackUse === "object"
      ? record.feedbackUse as Record<string, unknown>
      : null;
    if (
      record?.kind !== "communication"
      || !source
      || !Array.isArray(source.messageIds)
      || !student
      || typeof student.id !== "string"
      || typeof record.summaryForStudentTrack !== "string"
      || !feedbackUse
      || typeof feedbackUse.relevant !== "boolean"
      || !FEEDBACK_COMMUNICATION_CATEGORIES.includes(feedbackUse.category as typeof FEEDBACK_COMMUNICATION_CATEGORIES[number])
      || !["high", "medium", "low"].includes(clean(feedbackUse.priority))
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
  schema: Record<string, unknown>,
  onRetry?: GenerateWeComBridgeOptions["onRetry"],
): Promise<{ response: CompletionResponse; protocol: "json_schema" | "json_object" }> {
  const base = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    temperature,
    ...getLLMCompletionOptions("wecomExtraction", 8192),
  };
  const { reasoning_effort: _reasoningEffort, ...baseWithoutReasoning } = base;
  void _reasoningEffort;
  const schemaFormat = {
    type: "json_schema" as const,
    json_schema: { name: "wecom_candidate", strict: true, schema },
  };

  try {
    const response = await callOnceWithNetworkRetry(() => client.chat.completions.create({
      ...base,
      response_format: schemaFormat,
    }), onRetry);
    return { response, protocol: "json_schema" };
  } catch (error) {
    if (isReasoningUnsupported(error)) {
      try {
        const response = await callOnceWithNetworkRetry(() => client.chat.completions.create({
          ...baseWithoutReasoning,
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

export async function createWecomStructuredCompletion(
  client: CompletionClient,
  model: string,
  prompt: string,
  temperature: number,
  schema: Record<string, unknown>,
  onRetry?: GenerateWeComBridgeOptions["onRetry"],
): Promise<{ response: CompletionResponse; protocol: "json_schema" | "json_object" }> {
  return createStructuredCompletion(client, model, prompt, temperature, schema, onRetry);
}

export function classifyWeComProviderError(error: unknown): WeComExtractionError {
  return classifyProviderError(error);
}

function classifyProviderError(error: unknown): WeComExtractionError {
  if (error instanceof WeComExtractionError) return error;
  if (isNetworkError(error)) return new WeComExtractionError("network_error", "LLM 网络请求失败");
  if (
    errorStatus(error) === 404
    && /model|模型/i.test(errorText(error))
  ) {
    return new WeComExtractionError("model_not_found", "配置的 LLM 模型不存在");
  }
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

function structuredResponseText(response: CompletionResponse, protocol: "json_schema" | "json_object") {
  const message = response.choices[0]?.message as (typeof response.choices)[number]["message"] & {
    reasoning_content?: unknown;
  };
  const content = message?.content?.trim() || "";
  // LM Studio's Qwen-compatible server can place a JSON Schema response in
  // reasoning_content while leaving content empty. Accept that non-standard
  // location only for structured output; the same Schema and evidence checks
  // below still decide whether it is safe to consume.
  if (!content && protocol === "json_schema" && typeof message?.reasoning_content === "string") {
    return message.reasoning_content.trim();
  }
  return content;
}

function extractCompletion(
  response: CompletionResponse,
  modelName: string,
  protocol: "json_schema" | "json_object",
  groundedMessages?: Array<{ id: string; content: string }>,
  candidateStudentIds: string[] = [],
) {
  const rawOutput = structuredResponseText(response, protocol);
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
  const referenceContext = grounded
    ? groundedReferenceContext(text, input.groundedMessages ?? [])
    : null;
  const promptText = referenceContext?.modelText ?? text;
  const validationMessages = referenceContext?.modelMessages ?? input.groundedMessages;
  const prompt = grounded
    ? `你是 Student Track 的企微事实提取器。只提取当前连续交流段中能由原文逐字证明、且能唯一绑定学生的长期沟通事实。

学生候选：
${JSON.stringify(roster.map((student) => ({ id: student.id, name: student.name, studentId: student.studentId })), null, 2)}

输出必须严格符合 JSON Schema。只保留能改善后续课后反馈的中高价值信息：学习进步、具体困难、学习习惯、学习方法、学习信心、家长担心、反馈偏好、教师仍需兑现的承诺，或会直接影响学习表现的临时背景。收悉、感谢、排课、报名缴费、接送、普通请假、文件发送、群通知和无新增事实的寒暄不得输出。越接近当前时间且尚未被后续消息取代的信息，priority 越高。每条记录只能使用候选学生 ID，matchedStudent.confidence 和 confidence 都必须基于原文判断；feedbackUse.relevant 必须为 true，priority 只能为 high 或 medium。messageIds 只引用支撑该事实的 M001、M002 等短消息引用，不得猜测原始消息 ID。evidence.messageId 使用同一短引用。evidence 必须提供 1 至 3 条输入消息中逐字存在的短句，不得改写标点、措辞或补充推断。factualSummary 只概括已经明确发生或明确约定的事实；不得生成建议、课次、沟通对象或关注标签。没有足够逐字证据或没有反馈价值时 records 返回空数组。

当前连续交流段：
${promptText}`
    : `你是 Student Track 的企微家校沟通提取器。请从当前连续交流段中提取对“课后反馈”有长期价值、且能明确绑定到某个学生的家校沟通信息。

学生名单：
${JSON.stringify(roster, null, 2)}

输出必须严格符合提供的 JSON Schema。只生成 kind=communication 的记录；只有对后续课后反馈有中高价值的信息才令 feedbackUse.relevant=true 并输出：学习进步、具体困难、学习习惯、学习方法、学习信心、家长担心、反馈偏好、教师仍需兑现的承诺，或会直接影响学习表现的临时背景。收悉、感谢、排课、报名缴费、接送、普通请假、文件发送、群通知和无新增事实的寒暄不得输出。越接近当前时间且尚未被后续消息取代的信息，priority 越高。没有有价值的新事实时 records 返回空数组。不能明确匹配唯一学生时 confidence 填 low，不得臆测。summaryForStudentTrack 只保留家长关注点、学生状态和仍需兑现的行动。attentionSignals 只根据明确文字事实识别 academic-performance、learning-confidence、parent-concern、withdrawal-intent，没有时返回空数组。输入提供的会话 ID 和消息 ID 必须照抄，messageIds 只包含支撑记录的输入消息 ID。只是重复 recentCommunications 且没有新事实、新变化或新行动时不生成记录。

当前连续交流段：
${text}`;

  const client = createLLMClient("wecomExtraction");
  const model = getLLMModel("wecomExtraction");
  const schema = grounded ? groundedBridgeSchema : candidateBridgeSchema;
  const first = await createStructuredCompletion(client, model, prompt, 0.1, schema, options.onRetry);
  try {
    const extracted = extractCompletion(
      first.response,
      model,
      first.protocol,
      validationMessages,
      candidateStudentIds,
    );
    return {
      sourceLabel,
      ...extracted,
      bridgeJson: referenceContext
        ? restoreGroundedMessageIds(extracted.bridgeJson, referenceContext.referenceToId)
        : extracted.bridgeJson,
    };
  } catch (error) {
    if (
      !(error instanceof WeComExtractionError)
      || !["schema_invalid", "evidence_mismatch"].includes(error.code)
    ) throw error;
    options.onRetry?.("schema");
  }

  const retryPrompt = `${prompt}\n\n上一次输出未通过结构或证据校验。请重新完整提取，只返回符合 Schema 的 JSON；消息引用必须逐字复制 M001、M002 等短编号，证据 quote 必须逐字存在于对应消息。`;
  const retry = await createStructuredCompletion(client, model, retryPrompt, 0, schema, options.onRetry);
  try {
    const extracted = extractCompletion(
      retry.response,
      model,
      retry.protocol,
      validationMessages,
      candidateStudentIds,
    );
    return {
      sourceLabel,
      ...extracted,
      bridgeJson: referenceContext
        ? restoreGroundedMessageIds(extracted.bridgeJson, referenceContext.referenceToId)
        : extracted.bridgeJson,
    };
  } catch (error) {
    if (
      error instanceof WeComExtractionError
      && ["schema_invalid", "evidence_mismatch"].includes(error.code)
    ) {
      throw new WeComExtractionError(
        error.code,
        "LLM 连续两次未返回可验证的企微候选 JSON",
        error.diagnostics,
      );
    }
    throw error;
  }
}
