import { randomInt } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createLLMClient,
  getLLMCompletionOptions,
  getLLMModel,
} from "@/lib/llm";
import { resolveLLMProfileId, type LLMProfileRole } from "@/lib/llm-settings";
import {
  FEEDBACK_MODULES,
  FEEDBACK_PLAN_TYPES,
  FeedbackEvidenceBundleSchema,
  FeedbackPlanInputSnapshotSchema,
  FeedbackPlanItemGenerationConfigSchema,
  normalizeFeedbackGenerationPreferences,
  type CommunicationPreference,
  type FeedbackEvidenceBundle,
  type FeedbackGenerationMode,
  type FeedbackGenerationPreferences,
  type FeedbackPlanInputSnapshot,
  type FeedbackPlanType,
} from "@/lib/feedback-plan";
import type { FeedbackLength, FeedbackStyle } from "@/lib/feedback-sections";
import {
  containsRecipientPlaceholder,
  containsStudentDirectedAddress,
  stripFeedbackInternalBoundary,
} from "@/lib/feedback-text-safety";
import { ApiError } from "@/lib/api-errors";
import {
  generateFeedbackPlanComposition,
  type FeedbackPlanGenerationInput,
} from "@/services/feedback-generation-service";
import { z } from "zod";

export type FeedbackAbTestDb = Pick<PrismaClient, "feedbackPlan">;

export type FeedbackAbTestApproach = "current" | "planner_writer";

export type FeedbackAbTestModification = "direct" | "small_edit" | "content_edit" | "rewrite";
export type FeedbackAbTestAdherence = "full" | "slight_deviation" | "overreach";
export type FeedbackAbTestOverall = "a_much_better" | "a_bit_better" | "tie" | "b_bit_better" | "b_much_better";

export interface FeedbackAbTestScores {
  overall: FeedbackAbTestOverall;
  a: { modification: FeedbackAbTestModification; adherence: FeedbackAbTestAdherence; aiFlavor: number };
  b: { modification: FeedbackAbTestModification; adherence: FeedbackAbTestAdherence; aiFlavor: number };
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface ModelIdentity {
  role: LLMProfileRole;
  profileId: string | null;
  model: string;
}

export interface BlindAssignment {
  left: FeedbackAbTestApproach;
  right: FeedbackAbTestApproach;
}

const briefPointSchema = z.object({
  content: z.string().trim().min(1).max(1600),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(30),
});

const briefContextSchema = z.object({
  content: z.string().trim().min(1).max(1600),
  reason: z.string().trim().min(1).max(500),
});

const briefOmitSchema = z.object({
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(30),
  reason: z.string().trim().min(1).max(500),
});

export const ContentBriefSchema = z.object({
  mainFocus: z.string().trim().min(1).max(1200),
  present: z.array(briefPointSchema).max(30),
  background: z.array(briefPointSchema).max(20),
  interpretations: z.array(briefPointSchema.extend({ confidence: z.enum(["high", "medium", "low"]) })).max(20),
  contextOnly: z.array(briefContextSchema).max(20),
  omit: z.array(briefOmitSchema).max(30),
  communicationIntent: z.string().trim().max(1000),
  unresolved: z.array(z.string().trim().min(1).max(500)).max(20),
});
export type ContentBrief = z.infer<typeof ContentBriefSchema>;

export interface FrozenExperimentInput {
  planId: string;
  planItemId: string;
  planType: FeedbackPlanType;
  generationMode: FeedbackGenerationMode;
  outputRequirement: string;
  generationPreferences?: FeedbackGenerationPreferences;
  planInputSnapshot: FeedbackPlanInputSnapshot;
  evidenceBundle: FeedbackEvidenceBundle;
  studentId: string;
  studentName: string;
  studentNumber?: string;
  communicationPreference?: CommunicationPreference | null;
  referenceDate?: string;
  otherStudentNames: string[];
  style: FeedbackStyle;
  length: FeedbackLength;
}

export interface FeedbackAbTestCandidateItem {
  planItemId: string;
  studentId: string;
  studentName: string;
  studentNumber?: string;
  status: string;
}

export interface FeedbackAbTestCandidatePlan {
  planId: string;
  displayName: string;
  type: string;
  outputRequirement: string;
  items: FeedbackAbTestCandidateItem[];
}

export interface FeedbackAbTestResult {
  version: 1;
  planId: string;
  planItemId: string;
  studentName: string;
  generatedAt: string;
  assignment: BlindAssignment;
  outputs: { current: string; plannerWriter: string };
  plannerBrief: ContentBrief;
  latency: {
    current: { totalMs: number; stages: { generationMs: number } };
    plannerWriter: { totalMs: number; stages: { plannerMs: number; writerMs: number } };
  };
  tokenUsage: {
    current: TokenUsage | null;
    planner: TokenUsage;
    writer: TokenUsage;
    plannerWriter: TokenUsage;
  };
  models: {
    current: { draft: ModelIdentity; review: ModelIdentity };
    planner: ModelIdentity;
    writer: ModelIdentity;
  };
  safetyIssues: { current: string[]; plannerWriter: string[] };
}

export interface FeedbackAbTestStoredResult {
  version: 1;
  planId: string;
  planItemId: string;
  timestamp: string;
  generatedAt: string;
  blindAssignment: BlindAssignment;
  outputs: { A: string; B: string };
  plannerBrief: ContentBrief;
  scores: FeedbackAbTestScores;
  actualApproach: { A: FeedbackAbTestApproach; B: FeedbackAbTestApproach };
  latency: FeedbackAbTestResult["latency"];
  tokenUsage: FeedbackAbTestResult["tokenUsage"];
  models: FeedbackAbTestResult["models"];
}

export interface FeedbackAbTestPlanRecord {
  id: string;
  displayName?: string | null;
  type: string;
  outputRequirement: string;
  generationMode: string;
  inputSnapshot: string;
  archivedAt?: Date | null;
  session?: { date: string } | null;
  rangeEndSession?: { date: string } | null;
  items: FeedbackAbTestItemRecord[];
}

export interface FeedbackAbTestItemRecord {
  id: string;
  studentId: string | null;
  status: string;
  evidenceSnapshot: string;
  generationConfigSnapshot: string;
  student?: { name: string; studentId: string } | null;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function invalidFrozenInput(message: string): never {
  throw new ApiError(message, 409, "conflict", false);
}

function effectiveConfig(plan: FeedbackAbTestPlanRecord, item: FeedbackAbTestItemRecord, snapshot: FeedbackPlanInputSnapshot) {
  const baseType = FEEDBACK_PLAN_TYPES.find((type) => type === plan.type);
  if (!baseType) invalidFrozenInput("反馈计划类型无法从冻结快照确认");

  const rawOverride = parseJson(item.generationConfigSnapshot, null);
  const override = rawOverride && typeof rawOverride === "object" && Object.keys(rawOverride).length > 0
    ? FeedbackPlanItemGenerationConfigSchema.safeParse(rawOverride)
    : null;
  if (override && !override.success) invalidFrozenInput("学生条目的冻结生成配置无效");
  if (override?.success) {
    return {
      type: override.data.type,
      outputRequirement: override.data.outputRequirement,
      generationPreferences: override.data.generationPreferences,
    };
  }

  let generationPreferences: FeedbackGenerationPreferences | undefined;
  try {
    generationPreferences = snapshot.generationPreferences
      ? normalizeFeedbackGenerationPreferences(baseType, snapshot.generationPreferences)
      : undefined;
  } catch {
    invalidFrozenInput("反馈计划的冻结生成偏好无效");
  }
  return { type: baseType, outputRequirement: plan.outputRequirement, generationPreferences };
}

export function buildFrozenExperimentInput(plan: FeedbackAbTestPlanRecord, item: FeedbackAbTestItemRecord): FrozenExperimentInput {
  if (!item.studentId) invalidFrozenInput("请选择学生反馈条目，班级公共反馈不参与本实验");
  const snapshotResult = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
  if (!snapshotResult.success) invalidFrozenInput("反馈计划没有可用的冻结输入快照");
  const snapshot = snapshotResult.data;
  const frozenFact = snapshot.version === 2
    ? snapshot.factSnapshot.items.find((entry) => entry.studentId === item.studentId)
    : undefined;
  if (snapshot.version === 2 && !frozenFact) invalidFrozenInput("学生条目不在反馈计划的冻结事实快照中");

  const evidenceResult = FeedbackEvidenceBundleSchema.safeParse(parseJson(item.evidenceSnapshot, null));
  if (!evidenceResult.success) invalidFrozenInput("反馈计划条目没有可用的冻结证据快照");
  const config = effectiveConfig(plan, item, snapshot);
  const evidenceBundle: FeedbackEvidenceBundle = evidenceResult.data.planType === config.type
    ? evidenceResult.data
    : { ...evidenceResult.data, planType: config.type } as FeedbackEvidenceBundle;
  const studentName = frozenFact?.studentName ?? frozenFact?.studentNumber ?? item.student?.name;
  if (!studentName) invalidFrozenInput("冻结快照中没有学生身份");

  const otherStudentNames = [
    ...(snapshot.version === 2
      ? snapshot.factSnapshot.items
        .filter((entry) => entry.studentId !== item.studentId)
        .flatMap((entry) => entry.studentName ? [entry.studentName] : [])
      : []),
    ...plan.items
      .filter((entry) => entry.id !== item.id && entry.student?.name)
      .map((entry) => entry.student!.name),
  ];
  const preference = frozenFact?.communicationPreference;
  const tone = config.generationPreferences?.tone;
  const style: FeedbackStyle = tone === "professional"
    ? "professional"
    : tone === "gentle" || preference?.terminology !== "professional"
      ? "gentle"
      : "professional";
  const configuredLength = config.generationPreferences?.length;
  const length: FeedbackLength = configuredLength === "short" || (!configuredLength && preference?.length === "short")
    ? "short"
    : "standard";

  return {
    planId: plan.id,
    planItemId: item.id,
    planType: config.type,
    generationMode: plan.generationMode === "fast" ? "fast" : "standard",
    outputRequirement: config.outputRequirement,
    generationPreferences: config.generationPreferences,
    planInputSnapshot: snapshot,
    evidenceBundle,
    studentId: item.studentId,
    studentName,
    studentNumber: frozenFact?.studentNumber ?? item.student?.studentId,
    communicationPreference: preference,
    referenceDate: frozenFact?.referenceDate ?? plan.rangeEndSession?.date ?? plan.session?.date,
    otherStudentNames: [...new Set(otherStudentNames.filter((name) => name && name !== studentName))],
    style,
    length,
  };
}

type ExperimentLLMClient = ReturnType<typeof createLLMClient>;

export function buildCurrentGenerationInput(
  input: FrozenExperimentInput,
  clients: {
    draftClient: ExperimentLLMClient;
    draftModel: string;
    reviewClient: ExperimentLLMClient;
    reviewModel: string;
  },
): FeedbackPlanGenerationInput {
  return {
    studentName: input.studentName,
    planType: input.planType,
    outputRequirement: input.outputRequirement,
    evidenceBundle: input.evidenceBundle,
    style: input.style,
    length: input.length,
    draftClient: clients.draftClient,
    draftModel: clients.draftModel,
    reviewClient: clients.reviewClient,
    reviewModel: clients.reviewModel,
    generationMode: input.generationMode,
    generationPreferences: input.generationPreferences,
    referenceDate: input.referenceDate,
    existingTaskIds: new Set(input.evidenceBundle.executionConstraints.existingTaskIds),
  };
}

export function buildPlannerInput(input: FrozenExperimentInput) {
  return {
    evidenceBundle: input.evidenceBundle,
    plan: {
      type: input.planType,
      outputRequirement: input.outputRequirement,
      generationPreferences: input.generationPreferences ?? null,
      lessonMaterial: input.planInputSnapshot.lessonMaterial,
      referenceDate: input.referenceDate ?? null,
    },
    communicationPreference: input.communicationPreference ?? null,
    deterministicBoundaries: {
      closureType: input.generationPreferences?.closureType ?? null,
      moduleKeys: input.generationPreferences?.moduleKeys ?? [],
      allowedModuleKeys: input.generationPreferences?.moduleKeys?.length
        ? input.generationPreferences.moduleKeys
        : [...FEEDBACK_MODULES[input.planType]],
      existingTaskIds: input.evidenceBundle.executionConstraints.existingTaskIds,
    },
  };
}

export interface RestrictedWriterInput {
  studentName: string;
  plan: {
    type: FeedbackPlanType;
    style: FeedbackStyle;
    length: FeedbackLength;
    closureType: string | null;
  };
  contentBrief: {
    mainFocus: string;
    present: ContentBrief["present"];
    background: ContentBrief["background"];
    interpretations: ContentBrief["interpretations"];
    communicationIntent: string;
  };
  stableRules: string[];
}

export function buildRestrictedWriterInput(input: FrozenExperimentInput, brief: ContentBrief): RestrictedWriterInput {
  return {
    studentName: input.studentName,
    plan: {
      type: input.planType,
      style: input.style,
      length: input.length,
      closureType: input.generationPreferences?.closureType ?? null,
    },
    contentBrief: {
      mainFocus: brief.mainFocus,
      present: brief.present,
      background: brief.background,
      interpretations: brief.interpretations,
      communicationIntent: brief.communicationIntent,
    },
    stableRules: [
      "默认收件人是家长，谈到学生时使用姓名、孩子或第三人称，不直接对学生说你。",
      "只使用受限 ContentBrief 中允许披露的信息，不补充未提供的事实。",
      "自然组织成一条像老师发微信的反馈，不套固定段式，不为了完整强行加入表扬、建议、趋势或历史。",
      "只返回 JSON：{\"feedback\":\"可发送文本\"}。",
    ],
  };
}

function cleanJsonText(value: string) {
  let text = value.trim();
  if (text.startsWith("```")) text = text.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeTokenUsage(value: unknown): TokenUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  const inputTokens = numberOrNull(usage.prompt_tokens);
  const outputTokens = numberOrNull(usage.completion_tokens);
  const reasoningTokens = numberOrNull(details.reasoning_tokens ?? usage.reasoning_tokens);
  const directTotal = numberOrNull(usage.total_tokens);
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: directTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
  };
}

function sumTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const sum = (a: number | null, b: number | null) => a !== null && b !== null ? a + b : a ?? b;
  return {
    inputTokens: sum(left.inputTokens, right.inputTokens),
    outputTokens: sum(left.outputTokens, right.outputTokens),
    reasoningTokens: sum(left.reasoningTokens, right.reasoningTokens),
    totalTokens: sum(left.totalTokens, right.totalTokens),
  };
}

function compatibilityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /response[_ -]?format|json[_ -]?object|reasoning[_ -]?effort|thinking/i.test(message);
}

async function createExperimentJsonCompletion(
  client: ExperimentLLMClient,
  role: LLMProfileRole,
  model: string,
  prompt: string,
) {
  const configured = getLLMCompletionOptions(role, 2048, false);
  const baseBody = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    max_tokens: Math.max(configured.max_tokens, 2048),
    ...(configured.reasoning_effort ? { reasoning_effort: configured.reasoning_effort } : {}),
  };
  let response;
  try {
    response = await client.chat.completions.create({
      ...baseBody,
      response_format: { type: "json_object" as const },
    });
  } catch (error) {
    if (!compatibilityError(error)) throw error;
    response = await client.chat.completions.create(baseBody);
  }
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new ApiError("实验模型未返回有效内容", 502, "llm_schema_invalid", true);
  return { content, usage: normalizeTokenUsage(response.usage) };
}

function parseContentBrief(value: string, evidence: FeedbackEvidenceBundle): ContentBrief {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonText(value));
  } catch {
    throw new ApiError("Planner 未返回合法 ContentBrief", 502, "llm_schema_invalid", true);
  }
  const result = ContentBriefSchema.safeParse(parsed);
  if (!result.success) throw new ApiError("Planner ContentBrief 字段不完整", 502, "llm_schema_invalid", true);
  const allowedRefs = new Set([
    ...evidence.teachingEvidence,
    ...evidence.assessmentEvidence,
    ...evidence.communicationContext,
  ].map((item) => item.id));
  const referencedItems = [
    ...result.data.present,
    ...result.data.background,
    ...result.data.interpretations,
    ...result.data.omit,
  ];
  const unknownRefs = [...new Set(referencedItems.flatMap((item) => item.evidenceRefs).filter((ref) => !allowedRefs.has(ref)))];
  if (unknownRefs.length) {
    throw new ApiError(`Planner ContentBrief 包含未知 evidenceRef：${unknownRefs.slice(0, 6).join("、")}`, 502, "llm_schema_invalid", true);
  }
  return result.data;
}

function parseWriterFeedback(value: string) {
  const cleaned = cleanJsonText(value);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { feedback?: unknown }).feedback === "string") {
      return (parsed as { feedback: string }).feedback.trim();
    }
  } catch {
    // A compatible provider may ignore JSON mode; the deterministic checks below still apply.
  }
  return value.trim();
}

export function applyExperimentSafetyChecks(input: {
  text: string;
  studentName: string;
  otherStudentNames: string[];
}) {
  const text = stripFeedbackInternalBoundary(input.text.trim());
  const issues: string[] = [];
  if (!text) issues.push("空文本");
  if (input.otherStudentNames.some((name) => text.includes(name))) issues.push("出现其他学生姓名");
  if (containsRecipientPlaceholder(text)) issues.push("出现收件人占位符");
  if (containsStudentDirectedAddress(text)) issues.push("明显面向学生而非家长");
  return { text: issues.length ? "" : text, issues: [...new Set(issues)] };
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createBlindAssignment(randomValue = randomInt(0, 2)): BlindAssignment {
  return randomValue === 0
    ? { left: "current", right: "planner_writer" }
    : { left: "planner_writer", right: "current" };
}

function modelIdentity(
  role: LLMProfileRole,
  modelGetter: typeof getLLMModel,
  profileGetter: typeof resolveLLMProfileId,
): ModelIdentity {
  const profileId = profileGetter(role);
  return { role, profileId, model: modelGetter(role, profileId ?? undefined) };
}

function wrapUsageClient(client: ExperimentLLMClient, usageSink: TokenUsage[]) {
  type CompletionCreate = ExperimentLLMClient["chat"]["completions"]["create"];
  const create = client.chat.completions.create.bind(client.chat.completions) as (...args: Parameters<CompletionCreate>) => ReturnType<CompletionCreate>;
  const wrappedCreate = async (...args: Parameters<CompletionCreate>) => {
    const response = await create(...args);
    usageSink.push(normalizeTokenUsage("usage" in response ? response.usage : undefined));
    return response;
  };
  return { chat: { completions: { create: wrappedCreate } } } as unknown as ExperimentLLMClient;
}

export interface FeedbackAbTestDependencies {
  db?: FeedbackAbTestDb;
  currentGenerator?: typeof generateFeedbackPlanComposition;
  createClient?: typeof createLLMClient;
  getModel?: typeof getLLMModel;
  resolveProfileId?: typeof resolveLLMProfileId;
  randomAssignment?: () => BlindAssignment;
}

const planSelect = {
  id: true,
  displayName: true,
  type: true,
  outputRequirement: true,
  generationMode: true,
  inputSnapshot: true,
  archivedAt: true,
  session: { select: { date: true } },
  rangeEndSession: { select: { date: true } },
  items: {
    select: {
      id: true,
      studentId: true,
      status: true,
      evidenceSnapshot: true,
      generationConfigSnapshot: true,
      student: { select: { name: true, studentId: true } },
    },
  },
} as const;

async function readPlan(planId: string, db: FeedbackAbTestDb) {
  const plan = await db.feedbackPlan.findUnique({ where: { id: planId, archivedAt: null }, select: planSelect });
  if (!plan) throw new ApiError("反馈计划不存在或已归档", 404, "not_found", false);
  return plan as FeedbackAbTestPlanRecord;
}

export async function listFeedbackAbTestCandidates(db: FeedbackAbTestDb = prisma): Promise<FeedbackAbTestCandidatePlan[]> {
  const plans = await db.feedbackPlan.findMany({
    where: {
      archivedAt: null,
      semester: { deletedAt: null },
      class: { deletedAt: null },
      items: { some: { studentId: { not: null } } },
    },
    orderBy: { updatedAt: "desc" },
    select: planSelect,
  });
  return plans.flatMap((plan) => {
    const items = plan.items.flatMap((item) => {
      try {
        const frozen = buildFrozenExperimentInput(plan as FeedbackAbTestPlanRecord, item as FeedbackAbTestItemRecord);
        return [{ planItemId: item.id, studentId: frozen.studentId, studentName: frozen.studentName, studentNumber: frozen.studentNumber, status: item.status }];
      } catch {
        return [];
      }
    });
    return items.length
      ? [{ planId: plan.id, displayName: plan.displayName?.trim() || `${plan.type} · ${plan.session?.date ?? "未标日期"}`, type: plan.type, outputRequirement: plan.outputRequirement, items }]
      : [];
  });
}

export async function runFeedbackAbTest(
  input: { planId: string; planItemId: string },
  dependencies: FeedbackAbTestDependencies = {},
): Promise<FeedbackAbTestResult> {
  const db = dependencies.db ?? prisma;
  const plan = await readPlan(input.planId, db);
  const item = plan.items.find((candidate) => candidate.id === input.planItemId);
  if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  const frozen = buildFrozenExperimentInput(plan, item);

  const createClient = dependencies.createClient ?? createLLMClient;
  const modelGetter = dependencies.getModel ?? getLLMModel;
  const profileGetter = dependencies.resolveProfileId ?? resolveLLMProfileId;
  const currentGenerator = dependencies.currentGenerator ?? generateFeedbackPlanComposition;
  const draftIdentity = modelIdentity("feedbackDraft", modelGetter, profileGetter);
  const productionReviewIdentity = frozen.generationMode === "fast"
    ? draftIdentity
    : modelIdentity("feedbackReview", modelGetter, profileGetter);
  const plannerIdentity = draftIdentity;
  const writerIdentity = modelIdentity("feedbackReview", modelGetter, profileGetter);
  const currentUsage: TokenUsage[] = [];
  const rawDraftClient = createClient("feedbackDraft");
  const rawWriterClient = createClient("feedbackReview");
  const draftClient = wrapUsageClient(rawDraftClient, currentUsage);
  const productionReviewClient = frozen.generationMode === "fast"
    ? draftClient
    : wrapUsageClient(rawWriterClient, currentUsage);
  const writerClient = rawWriterClient;
  const currentInput = buildCurrentGenerationInput(frozen, {
    draftClient,
    draftModel: draftIdentity.model,
    reviewClient: productionReviewClient,
    reviewModel: productionReviewIdentity.model,
  });

  const generatedAt = new Date().toISOString();
  const currentStart = nowMs();
  const currentGenerated = await currentGenerator(currentInput);
  const currentSafety = applyExperimentSafetyChecks({
    text: currentGenerated.composition.draftFeedback,
    studentName: frozen.studentName,
    otherStudentNames: frozen.otherStudentNames,
  });
  const currentMs = Math.round(nowMs() - currentStart);

  const plannerStart = nowMs();
  const plannerPrompt = `你是 Student Track 的反馈 Planner。你只负责从冻结事实中规划本次反馈要说什么，不写家长正文，不追求漂亮表达，也不要为了覆盖率强行纳入所有证据。

读取下面的冻结输入。present 是本次值得直接进入反馈的信息，background 是压缩后的背景，interpretations 是有证据支持的教学判断；contextOnly 只供 Planner 理解，Writer 不会看到它的原始内容；omit 表示本次完全不传给 Writer。evidenceRefs 只能使用证据包中的真实证据 ID。

generationPreferences.moduleKeys 是本计划的披露权限边界，不只是写作偏好：非空时只有其中列出的模块可以向 Writer 披露；为空时按当前反馈类型的完整允许模块目录处理。未授权模块只能停留在 contextOnly 或 omit 中用于 Planner 理解与排除，不得出现在 present、background、interpretations 或任何下发给 Writer 的字段中。

冻结输入：
${JSON.stringify(buildPlannerInput(frozen))}

只返回合法 JSON，字段必须是：
{"mainFocus":"...","present":[{"content":"...","evidenceRefs":["..."]}],"background":[{"content":"...","evidenceRefs":["..."]}],"interpretations":[{"content":"...","evidenceRefs":["..."],"confidence":"high|medium|low"}],"contextOnly":[{"content":"...","reason":"..."}],"omit":[{"evidenceRefs":["..."],"reason":"..."}],"communicationIntent":"...","unresolved":[]}

不要输出家长称呼、成稿段落或固定模板。`;
  const plannerResponses: Array<{ content: string; usage: TokenUsage }> = [];
  let plannerBrief: ContentBrief | null = null;
  let plannerFailure: unknown = new ApiError("Planner ContentBrief 无效", 502, "llm_schema_invalid", true);
  for (let attempt = 0; attempt < 2 && !plannerBrief; attempt += 1) {
    const prompt = attempt === 0
      ? plannerPrompt
      : `${plannerPrompt}

上一轮 ContentBrief 无效：${plannerFailure instanceof Error ? plannerFailure.message : "字段或 evidenceRef 不符合协议"}。请从同一份冻结输入重新规划，严格使用真实 evidenceRef；不要静默删除含未知引用的内容，直接返回修正后的完整 JSON。`;
    const response = await createExperimentJsonCompletion(rawDraftClient, "feedbackDraft", plannerIdentity.model, prompt);
    plannerResponses.push(response);
    try {
      plannerBrief = parseContentBrief(response.content, frozen.evidenceBundle);
    } catch (error) {
      plannerFailure = error;
    }
  }
  if (!plannerBrief) throw plannerFailure;
  const plannerUsage = plannerResponses.map((response) => response.usage).reduce(sumTokenUsage);
  const plannerMs = Math.round(nowMs() - plannerStart);

  const writerInput = buildRestrictedWriterInput(frozen, plannerBrief);
  const writerStart = nowMs();
  const writerResponse = await createExperimentJsonCompletion(
    writerClient,
    "feedbackReview",
    writerIdentity.model,
    `你是 Student Track 的反馈 Writer。请根据已经规划好的允许披露内容，写一条自然、像老师真实发微信给家长的反馈。

Writer 只能读取下面的受限输入。不要猜测或补充事实，不要重新读取证据，不要提到 Planner、ContentBrief、模型或内部字段。不要使用固定“总体表现—数据—问题—建议”模板，也不要为了完整而强行加入没有规划的表扬、建议、趋势或历史。

受限输入：
${JSON.stringify(writerInput)}

只返回合法 JSON：{"feedback":"可发送文本"}。`,
  );
  const plannerWriterSafety = applyExperimentSafetyChecks({
    text: parseWriterFeedback(writerResponse.content),
    studentName: frozen.studentName,
    otherStudentNames: frozen.otherStudentNames,
  });
  const writerMs = Math.round(nowMs() - writerStart);
  const assignment = dependencies.randomAssignment?.() ?? createBlindAssignment();

  return {
    version: 1,
    planId: frozen.planId,
    planItemId: frozen.planItemId,
    studentName: frozen.studentName,
    generatedAt,
    assignment,
    outputs: { current: currentSafety.text, plannerWriter: plannerWriterSafety.text },
    plannerBrief,
    latency: {
      current: { totalMs: currentMs, stages: { generationMs: currentMs } },
      plannerWriter: { totalMs: plannerMs + writerMs, stages: { plannerMs, writerMs } },
    },
    tokenUsage: {
      current: currentUsage.length ? currentUsage.reduce(sumTokenUsage) : null,
      planner: plannerUsage,
      writer: writerResponse.usage,
      plannerWriter: sumTokenUsage(plannerUsage, writerResponse.usage),
    },
    models: {
      current: { draft: draftIdentity, review: productionReviewIdentity },
      planner: plannerIdentity,
      writer: writerIdentity,
    },
    safetyIssues: { current: currentSafety.issues, plannerWriter: plannerWriterSafety.issues },
  };
}
