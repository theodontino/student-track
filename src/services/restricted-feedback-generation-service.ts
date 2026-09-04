import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { createLLMClient } from "@/lib/llm";
import { getLLMCompletionOptions } from "@/lib/llm";
import {
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_CLOSURE_TYPES,
  FEEDBACK_MODULES,
  PARENT_ACTION_TYPES,
  FeedbackEvidenceBundleSchema,
  sanitizeFeedbackComposition,
  sanitizeFeedbackEvidenceBundle,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackGenerationPreferences,
  type FeedbackPlanType,
} from "@/lib/feedback-plan";
import type { FeedbackLength, FeedbackStyle } from "@/lib/feedback-sections";
import { sanitizeFeedbackPromptText } from "@/lib/feedback-text-safety";
import { ApiError } from "@/lib/api-errors";
import {
  modelEvidenceBundle,
  normalizeCompositionDates,
} from "@/services/feedback-generation-service";

type LLMClient = ReturnType<typeof createLLMClient>;

const STRATEGY_MAX_TOKENS = 4096;
const WRITER_MAX_TOKENS = 4096;
const TEACHING_BACKGROUND_REF_PREFIX = "teaching-background:";
const OUTPUT_REQUIREMENT_REF = "teacher-output-requirement";

const strategyPointSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  moduleKey: z.string().trim().min(1).max(100),
  kind: z.enum(["fact", "teaching_background", "interpretation", "teacher_instruction"]),
  content: z.string().trim().min(1).max(1600),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

const strategyContextSchema = z.object({
  content: z.string().trim().min(1).max(1600),
  reason: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
});

const strategyOmitSchema = z.object({
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(30),
  reason: z.string().trim().min(1).max(500),
});

const strategyParentActionSchema = z.object({
  type: z.enum(PARENT_ACTION_TYPES),
  actionBrief: z.string().trim().min(1).max(800),
  successCriteriaBrief: z.string().trim().max(500),
  notNeededBrief: z.string().trim().max(500),
  pointIds: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
});

export const FeedbackStrategyV1Schema = z.object({
  version: z.literal(1),
  mainFocus: z.string().trim().min(1).max(1200),
  closureType: z.enum(FEEDBACK_CLOSURE_TYPES),
  points: z.array(strategyPointSchema).min(1).max(40),
  contextOnly: z.array(strategyContextSchema).max(20),
  omit: z.array(strategyOmitSchema).max(40),
  communicationIntent: z.string().trim().max(1000),
  needParentAction: z.boolean(),
  parentAction: strategyParentActionSchema.nullable(),
  unresolved: z.array(z.string().trim().min(1).max(500)).max(20),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.points.forEach((point, index) => {
    if (ids.has(point.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["points", index, "id"], message: "策略内容点 ID 不能重复" });
    }
    ids.add(point.id);
  });
  if (value.needParentAction !== Boolean(value.parentAction)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parentAction"], message: "家长动作开关与策略不一致" });
  }
});
export type FeedbackStrategyV1 = z.infer<typeof FeedbackStrategyV1Schema>;

const writerDisclosureSchema = z.object({
  id: z.string().regex(/^D[1-9][0-9]*$/),
  moduleKey: z.string().trim().min(1).max(100),
  kind: strategyPointSchema.shape.kind,
  content: z.string().trim().min(1).max(12000),
});

export const RestrictedWriterInputV1Schema = z.object({
  version: z.literal(1),
  studentName: z.string().trim().min(1).max(200),
  recipient: z.literal("parent"),
  plan: z.object({
    type: z.enum(["class_update", "event_micro", "stage_trend", "course_end"]),
    style: z.enum(["gentle", "professional"]),
    length: z.enum(["short", "standard"]),
    closureType: z.enum(FEEDBACK_CLOSURE_TYPES),
    communicationIntent: z.string().trim().max(1000),
  }),
  disclosures: z.array(writerDisclosureSchema).max(40),
  parentAction: z.object({
    type: z.enum(PARENT_ACTION_TYPES),
    disclosureIds: z.array(writerDisclosureSchema.shape.id).min(1).max(10),
  }).nullable(),
  stableRules: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
});
export type RestrictedWriterInputV1 = z.infer<typeof RestrictedWriterInputV1Schema>;

const writerModuleSchema = z.object({
  key: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(5000),
  disclosureIds: z.array(writerDisclosureSchema.shape.id).min(1).max(40),
});

export const RestrictedWriterOutputV1Schema = z.object({
  version: z.literal(1),
  modules: z.array(writerModuleSchema).min(1).max(12),
  coverage: z.array(z.object({
    disclosureId: writerDisclosureSchema.shape.id,
    statement: z.string().trim().min(2).max(1000),
  })).max(100),
  parentAction: z.object({
    action: z.string().trim().min(1).max(1000),
    successCriteria: z.string().trim().max(500),
    notNeeded: z.string().trim().max(500),
  }).nullable(),
  draftFeedback: z.string().trim().min(1).max(10000),
});
export type RestrictedWriterOutputV1 = z.infer<typeof RestrictedWriterOutputV1Schema>;

const generationTokenUsageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().nullable(),
  outputTokens: z.number().finite().nonnegative().nullable(),
  reasoningTokens: z.number().finite().nonnegative().nullable(),
  totalTokens: z.number().finite().nonnegative().nullable(),
});

const restrictedGenerationStageTraceSchema = z.object({
  model: z.string().min(1).max(500),
  attempts: z.number().int().min(1),
  durationMs: z.number().int().nonnegative(),
  usage: generationTokenUsageSchema,
});

export const RestrictedFeedbackCheckpointV1Schema = z.object({
  version: z.literal(1),
  strategy: FeedbackStrategyV1Schema,
  writerInput: RestrictedWriterInputV1Schema,
  plannerTrace: restrictedGenerationStageTraceSchema,
});
export type RestrictedFeedbackCheckpointV1 = z.infer<typeof RestrictedFeedbackCheckpointV1Schema>;

export interface GenerationTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface RestrictedGenerationStageTrace {
  model: string;
  attempts: number;
  durationMs: number;
  usage: GenerationTokenUsage;
}

export interface RestrictedFeedbackGenerationResult {
  strategy: FeedbackStrategyV1;
  writerInput: RestrictedWriterInputV1;
  writerOutput: RestrictedWriterOutputV1;
  composition: FeedbackCompositionPlan;
  planner: RestrictedGenerationStageTrace & { reusedCheckpoint: boolean };
  writer: RestrictedGenerationStageTrace;
}

export interface RestrictedFeedbackGenerationInput {
  studentName: string;
  planType: FeedbackPlanType;
  outputRequirement: string;
  evidenceBundle: FeedbackEvidenceBundle;
  style: FeedbackStyle;
  length: FeedbackLength;
  generationPreferences?: FeedbackGenerationPreferences;
  plannerClient: LLMClient;
  plannerModel: string;
  writerClient: LLMClient;
  writerModel: string;
  plannerProfileId?: string;
  writerProfileId?: string;
  referenceDate?: string;
  forbiddenStudentNames?: string[];
  checkpoint?: RestrictedFeedbackCheckpointV1 | null;
  onCheckpoint?: (checkpoint: RestrictedFeedbackCheckpointV1) => Promise<void> | void;
  signal?: AbortSignal;
}

function emptyUsage(): GenerationTokenUsage {
  return { inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeGenerationTokenUsage(value: unknown): GenerationTokenUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  const inputTokens = finiteNumber(usage.prompt_tokens);
  const outputTokens = finiteNumber(usage.completion_tokens);
  const reasoningTokens = finiteNumber(details.reasoning_tokens ?? usage.reasoning_tokens);
  const totalTokens = finiteNumber(usage.total_tokens)
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, reasoningTokens, totalTokens };
}

function mergeUsage(left: GenerationTokenUsage, right: GenerationTokenUsage): GenerationTokenUsage {
  const sum = (a: number | null, b: number | null) => a === null ? b : b === null ? a : a + b;
  return {
    inputTokens: sum(left.inputTokens, right.inputTokens),
    outputTokens: sum(left.outputTokens, right.outputTokens),
    reasoningTokens: sum(left.reasoningTokens, right.reasoningTokens),
    totalTokens: sum(left.totalTokens, right.totalTokens),
  };
}

function cleanJsonText(value: string) {
  let text = value.trim();
  if (text.startsWith("```")) text = text.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function providerCompatibilityError(error: unknown) {
  const candidate = error as { status?: number; message?: string };
  return [400, 404, 422].includes(candidate?.status ?? 0)
    && /response[_ -]?format|json[_ -]?object|reasoning[_ -]?effort|thinking/i.test(candidate?.message ?? "");
}

function withoutReasoning<T extends Record<string, unknown>>(body: T) {
  const { reasoning_effort, ...rest } = body;
  void reasoning_effort;
  return rest;
}

async function createJsonCompletion(input: {
  client: LLMClient;
  role: "feedbackDraft" | "feedbackReview";
  profileId?: string;
  model: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) throw new DOMException("反馈生成已取消", "AbortError");
  const configured = getLLMCompletionOptions(input.role, input.maxTokens, input.role === "feedbackReview", input.profileId);
  const baseBody = {
    model: input.model,
    messages: [{ role: "user" as const, content: input.prompt }],
    max_tokens: Math.max(configured.max_tokens, input.maxTokens),
    ...(configured.reasoning_effort ? { reasoning_effort: configured.reasoning_effort } : {}),
  };
  let response;
  try {
    const body = { ...baseBody, response_format: { type: "json_object" as const } };
    response = input.signal
      ? await input.client.chat.completions.create(body, { signal: input.signal })
      : await input.client.chat.completions.create(body);
  } catch (error) {
    if (!providerCompatibilityError(error)) throw error;
    const body = withoutReasoning(baseBody);
    response = input.signal
      ? await input.client.chat.completions.create(body, { signal: input.signal })
      : await input.client.chat.completions.create(body);
  }
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new ApiError("反馈模型未返回有效 JSON", 502, "llm_schema_invalid", true);
  return { content, usage: normalizeGenerationTokenUsage(response.usage) };
}

function parseJsonObject(value: string, label: string) {
  try {
    const parsed = JSON.parse(cleanJsonText(value)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ApiError(`${label}未返回合法 JSON`, 502, "llm_schema_invalid", true);
  }
}

interface RestrictedDisclosureSource {
  ref: string;
  origin: "teaching_evidence" | "assessment_evidence" | "communication_context" | "teaching_background" | "output_requirement";
  kind: FeedbackStrategyV1["points"][number]["kind"];
  content: string;
  evidenceId: string | null;
  disclosable: boolean;
}

function disclosureSources(input: {
  evidenceBundle: FeedbackEvidenceBundle;
  outputRequirement: string;
  referenceDate?: string;
}): RestrictedDisclosureSource[] {
  const evidence = modelEvidenceBundle(
    sanitizeFeedbackEvidenceBundle(FeedbackEvidenceBundleSchema.parse(input.evidenceBundle)),
    input.referenceDate,
  );
  const fromEvidence = (
    items: FeedbackEvidenceBundle["teachingEvidence"],
    origin: RestrictedDisclosureSource["origin"],
    disclosable: boolean,
  ) => items
    .filter((item) => item.confirmed && item.kind !== "model_candidate")
    .map((item): RestrictedDisclosureSource => ({
      ref: item.id,
      origin,
      kind: item.kind === "fact" ? "fact" : "interpretation",
      content: sanitizeFeedbackPromptText(item.content).trim(),
      evidenceId: item.id,
      disclosable,
    }));
  const sources = [
    ...fromEvidence(evidence.teachingEvidence, "teaching_evidence", true),
    ...fromEvidence(evidence.assessmentEvidence, "assessment_evidence", true),
    // 原始家校沟通只供 Planner 判断，不能进入 Writer 的受限输入。
    ...fromEvidence(evidence.communicationContext, "communication_context", false),
  ];
  if ("teachingBackground" in evidence) {
    evidence.teachingBackground.forEach((value, index) => {
      const content = sanitizeFeedbackPromptText(value).trim();
      if (!content) return;
      sources.push({
        ref: `${TEACHING_BACKGROUND_REF_PREFIX}${index + 1}`,
        origin: "teaching_background",
        kind: "teaching_background",
        content,
        evidenceId: null,
        disclosable: true,
      });
    });
  }
  const outputRequirement = sanitizeFeedbackPromptText(input.outputRequirement).trim();
  if (outputRequirement) {
    sources.push({
      ref: OUTPUT_REQUIREMENT_REF,
      origin: "output_requirement",
      kind: "teacher_instruction",
      content: outputRequirement,
      evidenceId: null,
      disclosable: true,
    });
  }
  return sources;
}

function fixedCommunicationIntent(planType: FeedbackPlanType) {
  return planType === "class_update"
    ? "向家长说明本次课程和班级整体学习情况，只使用本次披露内容，不涉及具体学生。"
    : "向家长清楚说明当前学生已确认的学习情况，只使用本次披露内容。";
}

function assertNoForbiddenStudentNames(value: unknown, forbiddenStudentNames: string[] | undefined, label: string) {
  if (!forbiddenStudentNames?.length) return;
  const text = (typeof value === "string" ? value : JSON.stringify(value)).normalize("NFKC").toLocaleLowerCase();
  const found = forbiddenStudentNames.some((name) => {
    const normalized = name.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.length > 0 && text.includes(normalized);
  });
  if (found) {
    throw new ApiError(`${label}包含未授权学生姓名`, 502, "llm_schema_invalid", true);
  }
}

function allowedModules(input: Pick<RestrictedFeedbackGenerationInput, "planType" | "generationPreferences">) {
  const configured = input.generationPreferences?.moduleKeys;
  return new Set(configured?.length ? configured : FEEDBACK_MODULES[input.planType]);
}

function allowedClosures(input: Pick<RestrictedFeedbackGenerationInput, "planType" | "generationPreferences">) {
  return new Set(input.generationPreferences
    ? [input.generationPreferences.closureType]
    : FEEDBACK_CLOSURES_BY_TYPE[input.planType]);
}

export function validateFeedbackStrategy(input: {
  strategy: unknown;
  evidenceBundle: FeedbackEvidenceBundle;
  outputRequirement: string;
  planType: FeedbackPlanType;
  generationPreferences?: FeedbackGenerationPreferences;
  referenceDate?: string;
}) {
  const strategy = FeedbackStrategyV1Schema.parse(input.strategy);
  const sources = disclosureSources(input);
  const sourcesByRef = new Map(sources.map((source) => [source.ref, source]));
  const modules = allowedModules(input);
  const closures = allowedClosures(input);
  const unknownRefs = [...strategy.points, ...strategy.contextOnly, ...strategy.omit]
    .flatMap((item) => item.evidenceRefs)
    .filter((ref, index, refs) => !sourcesByRef.has(ref) && refs.indexOf(ref) === index);
  if (unknownRefs.length) {
    throw new ApiError(`反馈策略包含未知或未确认证据：${unknownRefs.slice(0, 6).join("、")}`, 502, "llm_schema_invalid", true);
  }
  const undisclosableRef = strategy.points
    .flatMap((point) => point.evidenceRefs)
    .find((ref) => !sourcesByRef.get(ref)?.disclosable);
  if (undisclosableRef) {
    throw new ApiError("反馈策略试图向 Writer 披露原始沟通内容", 502, "llm_schema_invalid", true);
  }
  const bucketByRef = new Map<string, "points" | "contextOnly" | "omit">();
  const registerBucket = (bucket: "points" | "contextOnly" | "omit", refs: string[]) => {
    for (const ref of refs) {
      const existing = bucketByRef.get(ref);
      if (existing && existing !== bucket) {
        throw new ApiError(`反馈策略重复分配证据：${ref}`, 502, "llm_schema_invalid", true);
      }
      bucketByRef.set(ref, bucket);
    }
  };
  registerBucket("points", strategy.points.flatMap((point) => point.evidenceRefs));
  registerBucket("contextOnly", strategy.contextOnly.flatMap((item) => item.evidenceRefs));
  registerBucket("omit", strategy.omit.flatMap((item) => item.evidenceRefs));
  const unsupportedModule = strategy.points.find((point) => !modules.has(point.moduleKey));
  if (unsupportedModule) {
    throw new ApiError(`反馈策略使用了未授权模块：${unsupportedModule.moduleKey}`, 502, "llm_schema_invalid", true);
  }
  if (!closures.has(strategy.closureType)) {
    throw new ApiError(`反馈策略使用了未授权结尾：${strategy.closureType}`, 502, "llm_schema_invalid", true);
  }
  const points = new Map(strategy.points.map((point) => [point.id, point]));
  if (strategy.parentAction) {
    if (!modules.has("parent_action") || strategy.closureType !== "home_cooperation") {
      throw new ApiError("反馈策略的家长动作超出计划权限", 502, "llm_schema_invalid", true);
    }
    const invalidPoint = strategy.parentAction.pointIds.find((id) => points.get(id)?.moduleKey !== "parent_action");
    if (invalidPoint) {
      throw new ApiError("反馈策略的家长动作引用无效内容点", 502, "llm_schema_invalid", true);
    }
  }
  return strategy;
}

function disclosureId(index: number) {
  return `D${index + 1}`;
}

function compiledDisclosureKind(sources: RestrictedDisclosureSource[]): RestrictedDisclosureSource["kind"] {
  const kinds = new Set(sources.map((source) => source.kind));
  if (kinds.size === 1) return sources[0].kind;
  if (kinds.has("teacher_instruction")) return "teacher_instruction";
  if (kinds.has("teaching_background")) return "teaching_background";
  return "interpretation";
}

export function buildRestrictedWriterInput(input: {
  studentName: string;
  planType: FeedbackPlanType;
  outputRequirement: string;
  evidenceBundle: FeedbackEvidenceBundle;
  style: FeedbackStyle;
  length: FeedbackLength;
  strategy: FeedbackStrategyV1;
  referenceDate?: string;
  forbiddenStudentNames?: string[];
}): RestrictedWriterInputV1 {
  const sourcesByRef = new Map(disclosureSources(input).map((source) => [source.ref, source]));
  const pointToDisclosure = new Map(input.strategy.points.map((point, index) => [point.id, disclosureId(index)]));
  const disclosures = input.strategy.points.map((point, index) => {
    const sources = point.evidenceRefs.map((ref) => sourcesByRef.get(ref));
    if (sources.some((source) => !source)) {
      throw new ApiError(`受限反馈内容点 ${point.id} 引用了未知来源`, 502, "llm_schema_invalid", true);
    }
    const selected = sources as RestrictedDisclosureSource[];
    if (selected.some((source) => !source.disclosable)) {
      throw new ApiError("受限反馈不能向 Writer 下发原始沟通内容", 502, "llm_schema_invalid", true);
    }
    return {
      id: disclosureId(index),
      moduleKey: point.moduleKey,
      kind: compiledDisclosureKind(selected),
      content: [...new Set(selected.map((source) => source.content))].join("\n"),
    };
  });
  const writerInput = RestrictedWriterInputV1Schema.parse({
    version: 1,
    studentName: input.studentName,
    recipient: "parent",
    plan: {
      type: input.planType,
      style: input.style,
      length: input.length,
      closureType: input.strategy.closureType,
      communicationIntent: fixedCommunicationIntent(input.planType),
    },
    disclosures,
    parentAction: input.strategy.parentAction ? {
      type: input.strategy.parentAction.type,
      disclosureIds: input.strategy.parentAction.pointIds.map((id) => pointToDisclosure.get(id)).filter((id): id is string => Boolean(id)),
    } : null,
    stableRules: [
      input.planType === "class_update"
        ? "这是班级公共反馈，不得出现任何具体学生姓名或可识别个体的信息。"
        : "默认收件人是家长，谈到学生时使用姓名、孩子或第三人称，不直接对学生说你。",
      "只使用 disclosures 中明确提供的内容，不补充未披露的事实或人物。",
      "自然组织成老师可继续编辑的反馈，不套固定段式，也不提及内部字段或模型。",
      "返回结构化 JSON，并用 disclosureIds 标明正文采用了哪些披露内容。",
    ],
  });
  assertNoForbiddenStudentNames(writerInput, input.forbiddenStudentNames, "受限 Writer 输入");
  return writerInput;
}

function validatedCheckpointWriterInput(input: {
  studentName: string;
  planType: FeedbackPlanType;
  outputRequirement: string;
  evidenceBundle: FeedbackEvidenceBundle;
  style: FeedbackStyle;
  length: FeedbackLength;
  strategy: FeedbackStrategyV1;
  referenceDate?: string;
  forbiddenStudentNames?: string[];
  writerInput: unknown;
}) {
  const saved = RestrictedWriterInputV1Schema.parse(input.writerInput);
  const expected = buildRestrictedWriterInput(input);
  if (JSON.stringify(saved) !== JSON.stringify(expected)) {
    throw new ApiError("受限反馈检查点与当前策略不一致", 409, "conflict", false);
  }
  return saved;
}

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function persistedEvidenceRefs(point: FeedbackStrategyV1["points"][number]) {
  return point.evidenceRefs.filter((ref) => ref !== OUTPUT_REQUIREMENT_REF && !ref.startsWith(TEACHING_BACKGROUND_REF_PREFIX));
}

export function compileRestrictedComposition(input: {
  strategy: FeedbackStrategyV1;
  writerInput: RestrictedWriterInputV1;
  writerOutput: unknown;
  forbiddenStudentNames?: string[];
}) {
  const output = RestrictedWriterOutputV1Schema.parse(input.writerOutput);
  assertNoForbiddenStudentNames(output, input.forbiddenStudentNames, "受限 Writer 输出");
  const disclosures = new Map(input.writerInput.disclosures.map((item, index) => {
    const strategyPoint = input.strategy.points[index];
    if (!strategyPoint) {
      throw new ApiError("受限 Writer 输入与策略内容点不一致", 502, "llm_schema_invalid", true);
    }
    return [item.id, { writer: item, strategy: strategyPoint }] as const;
  }));
  const allowedModuleKeys = new Set(input.writerInput.disclosures.map((item) => item.moduleKey));
  const usedModuleKeys = new Set<string>();
  const usedDisclosureIds = new Set<string>();
  const finalText = normalizedText(output.draftFeedback);
  const modules = output.modules.map((module) => {
    if (usedModuleKeys.has(module.key)) {
      throw new ApiError(`受限 Writer 重复返回模块：${module.key}`, 502, "llm_schema_invalid", true);
    }
    usedModuleKeys.add(module.key);
    if (!allowedModuleKeys.has(module.key)) {
      throw new ApiError(`受限 Writer 返回了未披露模块：${module.key}`, 502, "llm_schema_invalid", true);
    }
    const selected = module.disclosureIds.map((id) => disclosures.get(id));
    if (selected.some((item) => !item) || selected.some((item) => item?.writer.moduleKey !== module.key)) {
      throw new ApiError(`受限 Writer 的模块 ${module.key} 引用了越界内容`, 502, "llm_schema_invalid", true);
    }
    for (const id of module.disclosureIds) {
      if (usedDisclosureIds.has(id)) {
        throw new ApiError(`受限 Writer 重复使用披露内容：${id}`, 502, "llm_schema_invalid", true);
      }
      usedDisclosureIds.add(id);
    }
    const moduleText = normalizedText(module.content);
    if (!moduleText || !finalText.includes(moduleText)) {
      throw new ApiError(`受限 Writer 的模块正文未出现在最终正文中：${module.key}`, 502, "llm_schema_invalid", true);
    }
    return {
      key: module.key,
      content: module.content,
      evidenceRefs: [...new Set(selected.flatMap((item) => item ? persistedEvidenceRefs(item.strategy) : []))],
      status: "included" as const,
      reason: "受限 Writer 依据已披露内容生成",
    };
  });
  const coveredDisclosureIds = new Set<string>();
  const coverage = output.coverage.flatMap((entry) => {
    const selected = disclosures.get(entry.disclosureId);
    if (!selected) {
      throw new ApiError(`受限 Writer 覆盖声明引用了未知内容：${entry.disclosureId}`, 502, "llm_schema_invalid", true);
    }
    if (coveredDisclosureIds.has(entry.disclosureId)) {
      throw new ApiError(`受限 Writer 重复返回覆盖声明：${entry.disclosureId}`, 502, "llm_schema_invalid", true);
    }
    if (!usedDisclosureIds.has(entry.disclosureId)) {
      throw new ApiError(`受限 Writer 返回了未使用内容的覆盖声明：${entry.disclosureId}`, 502, "llm_schema_invalid", true);
    }
    coveredDisclosureIds.add(entry.disclosureId);
    const statement = normalizedText(entry.statement);
    if (!statement || !finalText.includes(statement)) {
      throw new ApiError(`受限 Writer 覆盖声明不在正文中：${entry.disclosureId}`, 502, "llm_schema_invalid", true);
    }
    return persistedEvidenceRefs(selected.strategy).map((evidenceId) => ({ evidenceId, statement: entry.statement }));
  });
  const uncoveredDisclosure = [...usedDisclosureIds].find((id) => !coveredDisclosureIds.has(id));
  if (uncoveredDisclosure) {
    throw new ApiError(`受限 Writer 缺少披露内容的覆盖声明：${uncoveredDisclosure}`, 502, "llm_schema_invalid", true);
  }
  const uniqueCoverage = [...new Map(coverage.map((entry) => [`${entry.evidenceId}:${entry.statement}`, entry])).values()];
  if (input.strategy.needParentAction && !output.parentAction) {
    throw new ApiError("受限 Writer 缺少计划要求的家长动作", 502, "llm_schema_invalid", true);
  }
  if (!input.strategy.needParentAction && output.parentAction) {
    throw new ApiError("受限 Writer 增加了计划外的家长动作", 502, "llm_schema_invalid", true);
  }
  if (input.writerInput.parentAction) {
    const parentActionModule = output.modules.find((module) => module.key === "parent_action");
    const required = new Set(input.writerInput.parentAction.disclosureIds);
    if (!parentActionModule || !parentActionModule.disclosureIds.some((id) => required.has(id))) {
      throw new ApiError("受限 Writer 的家长动作没有使用已披露依据", 502, "llm_schema_invalid", true);
    }
  }
  const composition = sanitizeFeedbackComposition({
    version: 1,
    closureType: input.strategy.closureType,
    needParentAction: input.strategy.needParentAction,
    parentAction: input.strategy.parentAction && output.parentAction ? {
      type: input.strategy.parentAction.type,
      actor: "parent",
      action: output.parentAction.action,
      successCriteria: output.parentAction.successCriteria,
      notNeeded: output.parentAction.notNeeded,
    } : null,
    modules,
    evidenceCoverage: uniqueCoverage,
    draftFeedback: output.draftFeedback,
  });
  return { output, composition };
}

function plannerPrompt(input: RestrictedFeedbackGenerationInput, evidence: FeedbackEvidenceBundle) {
  const modules = [...allowedModules(input)];
  const closures = [...allowedClosures(input)];
  const sourceIndex = disclosureSources(input).map((source) => ({
    ref: source.ref,
    origin: source.origin,
    canDiscloseToWriter: source.disclosable,
  }));
  return `你是 Student Track 的反馈 Planner。你可以读取当前条目的完整冻结输入，但只负责决定本次反馈允许披露什么，不写家长正文。

请把可披露内容放入 points；仅供判断但不下发给 Writer 的内容放入 contextOnly；本次完全不使用的来源放入 omit。三个区域的 evidenceRefs 必须互斥。points 中每项使用唯一短 ID，并绑定允许的 moduleKey 与至少一个 canDiscloseToWriter=true 的引用。原始家校沟通只能放入 contextOnly 或 omit，不能进入 points。point.content 只作为 Planner 审计摘要，Writer 不会读取它；Writer 的实际披露内容由服务端根据 evidenceRefs 编译。不要为了覆盖率强行纳入所有来源。

计划边界：
${JSON.stringify({
    studentName: input.studentName,
    planType: input.planType,
    outputRequirement: sanitizeFeedbackPromptText(input.outputRequirement),
    style: input.style,
    length: input.length,
    generationPreferences: input.generationPreferences ?? null,
    allowedModules: modules,
    allowedClosures: closures,
  })}

冻结证据：
${JSON.stringify(evidence)}

可引用来源索引：
${JSON.stringify(sourceIndex)}

只返回合法 JSON：
{"version":1,"mainFocus":"...","closureType":"...","points":[{"id":"P1","moduleKey":"...","kind":"fact|teaching_background|interpretation|teacher_instruction","content":"...","evidenceRefs":["..."],"confidence":"high|medium|low"}],"contextOnly":[{"content":"...","reason":"...","evidenceRefs":["..."]}],"omit":[{"evidenceRefs":["..."],"reason":"..."}],"communicationIntent":"...","needParentAction":false,"parentAction":null,"unresolved":[]}

需要家长动作时 parentAction 使用 {"type":"remind|confirm|provide_conditions|report_anomaly","actionBrief":"...","successCriteriaBrief":"...","notNeededBrief":"","pointIds":["P1"]}，并且 closureType 必须是 home_cooperation、引用点必须属于 parent_action 模块。不要输出家长正文。`;
}

function writerPrompt(writerInput: RestrictedWriterInputV1) {
  return `你是 Student Track 的反馈 Writer。你只能读取下面的受限输入，并把允许披露的内容写成自然、像老师真实发给家长的反馈。不得猜测或补充未提供的事实，不得提及 Planner、模型、disclosures 或内部字段。

受限输入：
${JSON.stringify(writerInput)}

只返回合法 JSON：
{"version":1,"modules":[{"key":"...","content":"...","disclosureIds":["D1"]}],"coverage":[{"disclosureId":"D1","statement":"正文中逐字存在的对应短句"}],"parentAction":null,"draftFeedback":"..."}

modules 只能使用受限输入中出现的 moduleKey；每个被模块采用的 disclosureId 只能来自受限输入、只能放入同 moduleKey，并且只能使用一次。每个被采用的 disclosureId 必须恰好有一条 coverage，coverage 不能引用未采用的内容。module.content 和每条 coverage.statement 都必须逐字出现在 draftFeedback 中。没有计划家长动作时 parentAction 必须为 null。`;
}

export async function planRestrictedFeedback(input: RestrictedFeedbackGenerationInput) {
  const evidence = sanitizeFeedbackEvidenceBundle(FeedbackEvidenceBundleSchema.parse(input.evidenceBundle));
  const plannerEvidence = modelEvidenceBundle(evidence, input.referenceDate);
  let usage = emptyUsage();
  const startedAt = performance.now();
  let failure: unknown = new ApiError("反馈策略无效", 502, "llm_schema_invalid", true);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const basePrompt = plannerPrompt(input, plannerEvidence);
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\n上一轮策略无效：${failure instanceof Error ? failure.message : "字段不符合协议"}。请从同一冻结输入返回修正后的完整 JSON，不要静默删除未知引用。`;
    const response = await createJsonCompletion({
      client: input.plannerClient,
      role: "feedbackDraft",
      profileId: input.plannerProfileId,
      model: input.plannerModel,
      prompt,
      maxTokens: STRATEGY_MAX_TOKENS,
      signal: input.signal,
    });
    usage = mergeUsage(usage, response.usage);
    try {
      const strategy = validateFeedbackStrategy({
        strategy: parseJsonObject(response.content, "反馈 Planner"),
        evidenceBundle: evidence,
        outputRequirement: input.outputRequirement,
        planType: input.planType,
        generationPreferences: input.generationPreferences,
        referenceDate: input.referenceDate,
      });
      const writerInput = buildRestrictedWriterInput({
        studentName: input.studentName,
        planType: input.planType,
        outputRequirement: input.outputRequirement,
        evidenceBundle: evidence,
        style: input.style,
        length: input.length,
        strategy,
        referenceDate: input.referenceDate,
        forbiddenStudentNames: input.forbiddenStudentNames,
      });
      const plannerTrace = restrictedGenerationStageTraceSchema.parse({
        model: input.plannerModel,
        attempts: attempt,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        usage,
      });
      const checkpoint = RestrictedFeedbackCheckpointV1Schema.parse({
        version: 1,
        strategy,
        writerInput,
        plannerTrace,
      });
      return {
        checkpoint,
        trace: {
          ...plannerTrace,
          reusedCheckpoint: false,
        },
      };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export async function writeRestrictedFeedback(input: RestrictedFeedbackGenerationInput, checkpoint: RestrictedFeedbackCheckpointV1) {
  const strategy = validateFeedbackStrategy({
    strategy: checkpoint.strategy,
    evidenceBundle: input.evidenceBundle,
    outputRequirement: input.outputRequirement,
    planType: input.planType,
    generationPreferences: input.generationPreferences,
    referenceDate: input.referenceDate,
  });
  const writerInput = validatedCheckpointWriterInput({
    studentName: input.studentName,
    planType: input.planType,
    outputRequirement: input.outputRequirement,
    evidenceBundle: input.evidenceBundle,
    style: input.style,
    length: input.length,
    strategy,
    referenceDate: input.referenceDate,
    forbiddenStudentNames: input.forbiddenStudentNames,
    writerInput: checkpoint.writerInput,
  });
  let usage = emptyUsage();
  const startedAt = performance.now();
  let failure: unknown = new ApiError("受限 Writer 输出无效", 502, "llm_schema_invalid", true);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const basePrompt = writerPrompt(writerInput);
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\n上一轮输出无效：${failure instanceof Error ? failure.message : "字段不符合协议"}。请只依据同一份受限输入返回修正后的完整 JSON。`;
    const response = await createJsonCompletion({
      client: input.writerClient,
      role: "feedbackReview",
      profileId: input.writerProfileId,
      model: input.writerModel,
      prompt,
      maxTokens: WRITER_MAX_TOKENS,
      signal: input.signal,
    });
    usage = mergeUsage(usage, response.usage);
    try {
      const compiled = compileRestrictedComposition({
        strategy,
        writerInput,
        writerOutput: parseJsonObject(response.content, "受限 Writer"),
        forbiddenStudentNames: input.forbiddenStudentNames,
      });
      return {
        ...compiled,
        composition: normalizeCompositionDates(compiled.composition, input.referenceDate),
        trace: {
          model: input.writerModel,
          attempts: attempt,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          usage,
        },
      };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export async function generateRestrictedFeedback(input: RestrictedFeedbackGenerationInput): Promise<RestrictedFeedbackGenerationResult> {
  let checkpoint: RestrictedFeedbackCheckpointV1;
  let planner: RestrictedFeedbackGenerationResult["planner"];
  if (input.checkpoint) {
    const savedCheckpoint = RestrictedFeedbackCheckpointV1Schema.parse(input.checkpoint);
    const strategy = validateFeedbackStrategy({
      strategy: savedCheckpoint.strategy,
      evidenceBundle: input.evidenceBundle,
      outputRequirement: input.outputRequirement,
      planType: input.planType,
      generationPreferences: input.generationPreferences,
      referenceDate: input.referenceDate,
    });
    const writerInput = validatedCheckpointWriterInput({
      studentName: input.studentName,
      planType: input.planType,
      outputRequirement: input.outputRequirement,
      evidenceBundle: input.evidenceBundle,
      style: input.style,
      length: input.length,
      strategy,
      referenceDate: input.referenceDate,
      forbiddenStudentNames: input.forbiddenStudentNames,
      writerInput: savedCheckpoint.writerInput,
    });
    checkpoint = {
      version: 1,
      strategy,
      writerInput,
      plannerTrace: savedCheckpoint.plannerTrace,
    };
    planner = { ...savedCheckpoint.plannerTrace, reusedCheckpoint: true };
  } else {
    const planned = await planRestrictedFeedback(input);
    checkpoint = planned.checkpoint;
    planner = planned.trace;
    await input.onCheckpoint?.(checkpoint);
  }
  const written = await writeRestrictedFeedback(input, checkpoint);
  return {
    strategy: checkpoint.strategy,
    writerInput: checkpoint.writerInput,
    writerOutput: written.output,
    composition: written.composition,
    planner,
    writer: written.trace,
  };
}
