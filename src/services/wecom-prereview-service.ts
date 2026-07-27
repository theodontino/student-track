import type { PrismaClient } from "@/generated/prisma/client";
import {
  WeComExtractionError,
} from "@/services/wecom-bridge-service";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import { withLLMCacheOperation } from "@/services/llm-cache-service";

export type PreReviewVerdict = "confirm" | "reject" | "review";

export interface PreReviewSuggestion {
  verdict: PreReviewVerdict;
  confidence: number;
  reason: string;
  flags: string[];
}

export interface PreReviewStored {
  version: string;
  verdict: PreReviewVerdict;
  confidence: number;
  reason: string;
  flags: string[];
  at: string;
  error?: string;
}

export interface PreReviewBatchStatus {
  taskId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

const PRE_REVIEW_VERSION = "wecom-prereview.v1";
const PRE_REVIEW_CONCURRENCY = 2;
const PRE_REVIEW_MAX_TOKENS = 1024;
const PRE_REVIEW_TEMPERATURE = 0;
// 默认走 low，节省 reasoning tokens；模型不支持时自动降级到不传（默认 high）。
const PRE_REVIEW_REASONING_EFFORT: "low" | "medium" | "high" = "low";

const preReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reason"],
  properties: {
    verdict: { type: "string", enum: ["confirm", "reject", "review"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", minLength: 1, maxLength: 240 },
    flags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 60 } },
  },
} as const;

interface BatchState extends PreReviewBatchStatus {
  cancel: () => void;
}

const tasks = new Map<string, BatchState>();
let activeTaskId: string | null = null;

export function listPreReviewTasks(): PreReviewBatchStatus[] {
  return Array.from(tasks.values()).map(stripCancel);
}

export function getPreReviewTask(taskId: string): PreReviewBatchStatus | null {
  const state = tasks.get(taskId);
  return state ? stripCancel(state) : null;
}

export function cancelPreReviewTask(taskId: string): boolean {
  const state = tasks.get(taskId);
  if (!state || state.status !== "running") return false;
  state.cancel();
  return true;
}

export function readPreReviewSuggestion(
  serialized: string | null | undefined,
): PreReviewSuggestion | null {
  if (!serialized) return null;
  try {
    const data = JSON.parse(serialized) as Partial<PreReviewStored> & { error?: string };
    if (data.error || !data.verdict) return null;
    if (!["confirm", "reject", "review"].includes(data.verdict)) return null;
    return {
      verdict: data.verdict,
      confidence: typeof data.confidence === "number" ? data.confidence : 0,
      reason: typeof data.reason === "string" ? data.reason : "",
      flags: Array.isArray(data.flags) ? data.flags.map(String) : [],
    };
  } catch {
    return null;
  }
}

export async function startPreReview(
  prisma: PrismaClient,
  options: { draftIds?: string[] } = {},
): Promise<PreReviewBatchStatus> {
  if (activeTaskId) {
    const active = tasks.get(activeTaskId);
    if (active?.status === "running") return stripCancel(active);
    activeTaskId = null;
  }
  const where: Record<string, unknown> = { status: "pending", id: { startsWith: "wcc-" } };
  if (options.draftIds && options.draftIds.length > 0) {
    where.id = { in: options.draftIds };
  }
  const drafts = await prisma.draftRecord.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: {
      id: true,
      parsedResult: true,
      sessionCode: true,
    },
  });

  const taskId = `prereview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let cancelled = false;
  const state: BatchState = {
    taskId,
    status: "running",
    total: drafts.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    cancel: () => { cancelled = true; },
  };
  tasks.set(taskId, state);
  activeTaskId = taskId;

  // Fire and forget. The HTTP route returns immediately with the snapshot.
  void runPreReviewLoop(prisma, drafts, state, () => cancelled);

  return stripCancel(state);
}

async function runPreReviewLoop(
  prisma: PrismaClient,
  drafts: Array<{ id: string; parsedResult: string; sessionCode: string | null }>,
  state: BatchState,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    const queue = drafts.slice();
    const workers = Array.from({ length: PRE_REVIEW_CONCURRENCY }, () => worker());
    async function worker() {
      while (!isCancelled()) {
        const next = queue.shift();
        if (!next) return;
        try {
          const suggestion = await evaluateDraft(next);
          await persistSuggestion(prisma, next.id, suggestion, null);
          state.succeeded += 1;
        } catch (error) {
          await persistSuggestion(prisma, next.id, null, errorMessage(error));
          state.failed += 1;
        } finally {
          state.processed += 1;
        }
      }
    }
    await Promise.all(workers);
    state.status = isCancelled() ? "cancelled" : "completed";
  } catch (error) {
    state.status = "failed";
    state.error = errorMessage(error);
  } finally {
    state.finishedAt = new Date().toISOString();
    if (activeTaskId === state.taskId) activeTaskId = null;
  }
}

export async function acceptHighConfidenceDrafts(
  prisma: PrismaClient,
  threshold: number,
): Promise<{ scanned: number; eligible: number; confirmed: number; failed: Array<{ id: string; error: string }> }> {
  const drafts = await prisma.draftRecord.findMany({
    where: { status: "pending", id: { startsWith: "wcc-" }, sessionCode: { not: null } },
    select: { id: true, reviewResult: true, sessionCode: true },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const eligible = drafts.filter((draft) => {
    const suggestion = readPreReviewSuggestion(draft.reviewResult);
    return Boolean(suggestion && suggestion.verdict === "confirm" && suggestion.confidence >= threshold);
  });

  const result = { scanned: drafts.length, eligible: eligible.length, confirmed: 0, failed: [] as Array<{ id: string; error: string }> };
  if (eligible.length === 0) return result;

  const { processDraftReview } = await import("@/services/review-service");
  for (const draft of eligible) {
    try {
      await processDraftReview({ draftId: draft.id, action: "confirm" });
      result.confirmed += 1;
    } catch (error) {
      result.failed.push({ id: draft.id, error: errorMessage(error) });
    }
  }
  return result;
}

export async function bulkReviewDrafts(
  prisma: PrismaClient,
  draftIds: string[],
  action: "confirm" | "reject",
  options: { concurrency?: number } = {},
): Promise<{ total: number; confirmed: number; rejected: number; failed: Array<{ id: string; error: string }> }> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const result = { total: draftIds.length, confirmed: 0, rejected: 0, failed: [] as Array<{ id: string; error: string }> };
  if (draftIds.length === 0) return result;

  const queue = draftIds.slice();
  const { processDraftReview } = await import("@/services/review-service");

  async function worker() {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      try {
        await processDraftReview({ draftId: next, action });
        if (action === "confirm") result.confirmed += 1;
        else result.rejected += 1;
      } catch (error) {
        result.failed.push({ id: next, error: errorMessage(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}

async function evaluateDraft(
  draft: { id: string; parsedResult: string; sessionCode: string | null },
): Promise<PreReviewSuggestion> {
  const parsed = safeJson(draft.parsedResult);
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).wccSource
    : null;
  const sourceRecord = source && typeof source === "object" && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {};
  const messages = Array.isArray(sourceRecord.messages)
    ? sourceRecord.messages as Array<{ id?: string; content?: string; sender?: string }>
    : [];
  const compactMessages = messages.slice(0, 8).map((message) => ({
    id: typeof message.id === "string" ? message.id : "?",
    sender: typeof message.sender === "string" ? message.sender : "未知",
    content: typeof message.content === "string" ? message.content.slice(0, 200) : "",
  }));
  const communication = extractFirstCommunication(parsed);
  const studentName = extractFirstStudentName(parsed);

  const systemPrompt = [
    "你是 Student Track 的 WCC 草稿预审助手。",
    "你的任务是根据学生匹配、沟通内容和（若已选）课次，给出一条审核建议。",
    "verdict 必须是 confirm / reject / review 之一：",
    "  confirm: 沟通内容、关联学生、课次都合理，可直接入库。",
    "  reject: 学生匹配错误、消息无价值、与该学生无关、重复或明显错误。",
    "  review: 存在歧义、重名、价值不高、证据不足，需教师判断。",
    "confidence 是 0 到 1 的小数，verdict=review 时不应高于 0.5。",
    "reason 用一句中文，不超过 60 字，说明判定依据。",
    "flags 是教师应当注意的关键词数组，最多 4 个，每个不超过 12 字；无则返回空数组。",
  ].join("\n");

  const userPayload = {
    draftId: draft.id,
    sessionCode: draft.sessionCode ?? null,
    studentName,
    communication,
    messages: compactMessages,
  };

  const userPrompt = JSON.stringify(userPayload, null, 2);

  const client = createLLMClient("feedbackReview");
  const model = getLLMModel("feedbackReview");

  const { text, protocol } = await withLLMCacheOperation("wecom", "wcc-prereview", () => callLlmWithSchemaFallback(
    client,
    model,
    systemPrompt,
    userPrompt,
  ));

  if (!text || !text.trim()) {
    throw new WeComExtractionError("schema_invalid", `LLM 返回空内容 (protocol=${protocol})`);
  }

  const verdict = parsePreReviewText(text);
  return verdict;
}

interface LlmCall {
  text: string;
  protocol: "json_schema" | "json_object" | "plain";
  model: string;
}

type LlmClient = ReturnType<typeof createLLMClient>;

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

async function callLlmWithSchemaFallback(
  client: LlmClient,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmCall> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Level 1: strict json_schema
  try {
    const response = await createWithReasoningFallback(client, {
      model,
      messages,
      temperature: PRE_REVIEW_TEMPERATURE,
      max_tokens: PRE_REVIEW_MAX_TOKENS,
      response_format: {
        type: "json_schema",
        json_schema: { name: "wecom_prereview", strict: true, schema: preReviewSchema as unknown as Record<string, unknown> },
      },
    });
    return { text: extractRaw(response), protocol: "json_schema", model };
  } catch (error) {
    if (!isProtocolIncompatible(error)) throw classifyHardError(error);
  }

  // Level 2: json_object
  try {
    const response = await createWithReasoningFallback(client, {
      model,
      messages,
      temperature: PRE_REVIEW_TEMPERATURE,
      max_tokens: PRE_REVIEW_MAX_TOKENS,
      response_format: { type: "json_object" },
    });
    return { text: extractRaw(response), protocol: "json_object", model };
  } catch (error) {
    if (!isProtocolIncompatible(error)) throw classifyHardError(error);
  }

  // Level 3: free text with strict prompt instruction
  const freeTextSystem = `${systemPrompt}\n\n严格要求：只用 JSON 格式回复，不要任何解释、Markdown 包裹或前后缀。`;
  const freeTextMessages: ChatMessage[] = [
    { role: "system", content: freeTextSystem },
    { role: "user", content: userPrompt },
  ];
  const response = await createWithReasoningFallback(client, {
    model,
    messages: freeTextMessages,
    temperature: PRE_REVIEW_TEMPERATURE,
    max_tokens: PRE_REVIEW_MAX_TOKENS,
  });
  return { text: extractRaw(response), protocol: "plain", model };
}

type ChatCompletionPayload = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  response_format?: { type: "json_schema"; json_schema: { name: string; strict: true; schema: Record<string, unknown> } } | { type: "json_object" };
};

async function createWithReasoningFallback(
  client: LlmClient,
  payload: ChatCompletionPayload,
): Promise<{ choices: Array<{ message?: { content?: string | null } }> }> {
  // 第一次尝试：带 reasoning_effort。如果模型不支持（例如某些老版本只接受 high），
  // 错误会被识别为 reasoning-related，自动降级重试。
  try {
    return await client.chat.completions.create({
      ...payload,
      reasoning_effort: PRE_REVIEW_REASONING_EFFORT,
    } as never);
  } catch (error) {
    if (!isReasoningUnsupported(error)) throw error;
    // 降级：不传 reasoning_effort，由模型使用默认思考等级。
    return await client.chat.completions.create(payload as never);
  }
}

function isReasoningUnsupported(error: unknown): boolean {
  const status = errorStatus(error);
  if (![400, 404, 422].includes(status ?? 0)) return false;
  const text = errorText(error);
  return /reasoning[_ -]?effort|reasoning.*(?:unsupported|invalid|unknown|extra)|不支持.*reasoning|思考/i.test(text);
}

function isProtocolIncompatible(error: unknown): boolean {
  if (error instanceof WeComExtractionError) {
    return ["protocol_incompatible", "schema_invalid", "model_not_found"].includes(error.code);
  }
  const status = errorStatus(error);
  const text = errorText(error);
  if (status === 400 && /response_format|json_schema|json_object|schema/i.test(text)) return true;
  if (status === 404 && /model|模型/i.test(text)) return true;
  if (status === 400 && /unsupported|not support|不支持/i.test(text)) return true;
  return false;
}

function classifyHardError(error: unknown): WeComExtractionError {
  if (error instanceof WeComExtractionError) return error;
  if (isNetworkError(error)) return new WeComExtractionError("network_error", "LLM 网络请求失败");
  const status = errorStatus(error);
  if (status === 404 && /model|模型/i.test(errorText(error))) {
    return new WeComExtractionError("model_not_found", "配置的 LLM 模型不存在");
  }
  return new WeComExtractionError("provider_error", `LLM 服务拒绝请求（HTTP ${status || "未知"}）`);
}

function errorStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
    const response = (error as { response?: { status?: unknown } }).response;
    if (response && typeof response.status === "number") return response.status;
  }
  return null;
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function isNetworkError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "ECONNREFUSED") return true;
  const text = errorText(error);
  return /network|fetch failed|timeout|ENOTFOUND|ECONNRESET/i.test(text);
}

function parsePreReviewText(raw: string): PreReviewSuggestion {
  const text = stripFence(raw);
  const candidates: string[] = [];
  candidates.push(text);
  // 尝试截取第一个 {...} 段，避免模型前后加废话
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  let parsed: Record<string, unknown> | null = null;
  let lastError: string | null = null;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "parse_failed";
    }
  }
  if (!parsed) {
    // 容错：verdict 缺失或不是 JSON 都不算硬错，统一降级为 review
    const verdictMatch = raw.match(/\b(confirm|reject|review)\b/i);
    if (verdictMatch) {
      return {
        verdict: verdictMatch[1].toLowerCase() as PreReviewVerdict,
        confidence: 0,
        reason: lastError ? `LLM 响应非 JSON：${lastError.slice(0, 80)}` : "LLM 响应非 JSON，已按需复核处理",
        flags: ["parse_fallback"],
      };
    }
    throw new WeComExtractionError("schema_invalid", `LLM 返回无法解析为 verdict JSON: ${lastError ?? "empty"}`);
  }

  const rawVerdict = String(parsed.verdict || "review").toLowerCase();
  const verdict: PreReviewVerdict = (["confirm", "reject", "review"] as const).includes(rawVerdict as PreReviewVerdict)
    ? (rawVerdict as PreReviewVerdict)
    : "review";
  const confidence = clamp01(Number(parsed.confidence ?? 0));
  const reason = String(parsed.reason || "").trim().slice(0, 240) || (verdict === "review" ? "LLM 未提供原因" : "LLM 未提供原因");
  const flags = Array.isArray(parsed.flags)
    ? parsed.flags.map((item) => String(item).slice(0, 60)).filter(Boolean).slice(0, 8)
    : [];

  return { verdict, confidence, reason, flags };
}

async function persistSuggestion(
  prisma: PrismaClient,
  draftId: string,
  suggestion: PreReviewSuggestion | null,
  errorMessage: string | null,
): Promise<void> {
  const payload: PreReviewStored = suggestion
    ? {
      version: PRE_REVIEW_VERSION,
      verdict: suggestion.verdict,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      flags: suggestion.flags,
      at: new Date().toISOString(),
    }
    : {
      version: PRE_REVIEW_VERSION,
      verdict: "review",
      confidence: 0,
      reason: "",
      flags: [],
      at: new Date().toISOString(),
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  await prisma.draftRecord.update({
    where: { id: draftId },
    data: { reviewResult: JSON.stringify(payload) },
  });
}

function stripCancel(state: BatchState): PreReviewBatchStatus {
  const { cancel, ...rest } = state;
  void cancel;
  return rest;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function extractFirstCommunication(parsed: unknown): { type?: string; summary?: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const root = parsed as Record<string, unknown>;
  const students = Array.isArray(root.students) ? root.students as Array<Record<string, unknown>> : [];
  for (const student of students) {
    const comm = student.communication;
    if (comm && typeof comm === "object" && !Array.isArray(comm)) {
      const record = comm as Record<string, unknown>;
      return {
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        ...(typeof record.summary === "string" ? { summary: record.summary.slice(0, 400) } : {}),
      };
    }
  }
  return {};
}

function extractFirstStudentName(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const students = Array.isArray(root.students) ? root.students as Array<Record<string, unknown>> : [];
  for (const student of students) {
    if (typeof student.name === "string" && student.name.trim()) return student.name.trim();
  }
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 1000) / 1000;
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function extractRaw(response: { choices?: Array<{ message?: { content?: string | null } }> }): string {
  return response.choices?.[0]?.message?.content ?? "";
}

function errorMessage(error: unknown): string {
  if (error instanceof WeComExtractionError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export { callLlmWithSchemaFallback, parsePreReviewText };
