import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import {
  type StoredFeedbackGenerationApproach
} from "@/lib/feedback-generation-approach";
import {
  FEEDBACK_PLAN_TYPES,
  FeedbackAuditSnapshotSchema,
  FeedbackCompositionPlanSchema,
  FeedbackPlanInputSnapshotSchema,
  FeedbackPlanItemGenerationConfigSchema,
  normalizeFeedbackGenerationPreferences,
  RESTRICTED_WRITER_OUTPUT_INVALID_CODE,
  sanitizeFeedbackComposition,
  STUDENT_FEEDBACK_PLAN_TYPES,
  type FeedbackEvidenceBundle,
  type FeedbackGenerationPreferences,
  type FeedbackPlanCreateInput,
  type FeedbackPlanInputSnapshot,
  type FeedbackPlanItemGenerationConfig,
  type FeedbackPlanStudentOverride
} from "@/lib/feedback-plan";
import { feedbackPlanItemStatusCounts } from "@/lib/feedback-plan-summary";
import { sha256 } from "@/services/feedback-plan-audit";
const FEEDBACK_PLAN_GENERATED_STATUSES = new Set([
  "queued",
  "generating",
  "pause_requested",
  "paused",
  "generation_failed",
  "in_review",
  "partially_approved",
  "approved",
  "partially_exported",
  "exported",
]);

export function feedbackPlanItemHasGeneratedResult(item: {
  status: string;
  finalText: string | null;
  selectedGenerationId: string | null;
  approvedAt: Date | null;
  exportedAt: Date | null;
}) {
  return Boolean(item.finalText || item.selectedGenerationId || item.approvedAt || item.exportedAt)
    || ["needs_review", "approved", "exported"].includes(item.status);
}

export function feedbackPlanHasGenerationTrace(plan: {
  status: string;
  generationStartedAt: Date | null;
  generationCompletedAt: Date | null;
  items: Array<{
    status: string;
    finalText: string | null;
    selectedGenerationId: string | null;
    approvedAt: Date | null;
    exportedAt: Date | null;
  }>;
}) {
  return Boolean(plan.generationStartedAt || plan.generationCompletedAt)
    || FEEDBACK_PLAN_GENERATED_STATUSES.has(plan.status)
    || plan.items.some((item) => (
      feedbackPlanItemHasGeneratedResult(item)
      || ["queued", "generating", "pause_requested", "paused", "generation_failed"].includes(item.status)
    ));
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function json(value: unknown) {
  return JSON.stringify(value);
}

export function restrictedWriterBlockerFromAuditSnapshot(value: string | null | undefined) {
  const parsed = FeedbackAuditSnapshotSchema.safeParse(parseJson(value, null));
  return parsed.success
    ? parsed.data.items.find((issue) => issue.code === RESTRICTED_WRITER_OUTPUT_INVALID_CODE) ?? null
    : null;
}

export function feedbackPlanDraftFingerprint(input: {
  snapshot: Extract<FeedbackPlanInputSnapshot, { version: 2 }>;
  type: FeedbackPlanCreateInput["type"];
  outputRequirement: string;
  generationApproach: StoredFeedbackGenerationApproach;
  generationPreferences: FeedbackGenerationPreferences;
  selectedStudentIds: Array<string | null>;
  studentOverrides: Map<string, FeedbackPlanItemGenerationConfig>;
}) {
  const factSourceFingerprint = input.snapshot.sourceFingerprint || sha256(JSON.stringify({
    scope: {
      semesterId: input.snapshot.semesterId,
      classId: input.snapshot.classId,
      sessionId: input.snapshot.sessionId,
      rangeStartSessionId: input.snapshot.rangeStartSessionId,
      rangeEndSessionId: input.snapshot.rangeEndSessionId,
    },
    lessonMaterial: input.snapshot.lessonMaterial,
    factItems: input.snapshot.factSnapshot.items,
    intakeSources: input.snapshot.intakeSources,
  }));
  return sha256(JSON.stringify({
    factSourceFingerprint,
    type: input.type,
    outputRequirement: input.outputRequirement,
    generationApproach: input.generationApproach,
    generationPreferences: input.generationPreferences,
    selectedStudentIds: [...input.selectedStudentIds].sort((left, right) => String(left).localeCompare(String(right))),
    studentOverrides: [...input.studentOverrides.entries()].sort(([left], [right]) => left.localeCompare(right)),
  }));
}

export function generationPreferencesFromSnapshot(planType: string, inputSnapshot: string): FeedbackGenerationPreferences | undefined {
  if (!FEEDBACK_PLAN_TYPES.includes(planType as typeof FEEDBACK_PLAN_TYPES[number])) return undefined;
  const parsed = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(inputSnapshot, null));
  if (!parsed.success || !parsed.data.generationPreferences) return undefined;
  return normalizeFeedbackGenerationPreferences(
    planType as typeof FEEDBACK_PLAN_TYPES[number],
    parsed.data.generationPreferences,
  );
}

export function parseGenerationConfigSnapshot(value: string | null | undefined): FeedbackPlanItemGenerationConfig | null {
  if (!value) return null;
  const raw = parseJson(value, null);
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return null;
  const parsed = FeedbackPlanItemGenerationConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function normalizeStudentGenerationConfig(value: unknown): FeedbackPlanItemGenerationConfig {
  const parsed = FeedbackPlanItemGenerationConfigSchema.parse(value);
  if (!STUDENT_FEEDBACK_PLAN_TYPES.includes(parsed.type as typeof STUDENT_FEEDBACK_PLAN_TYPES[number])) {
    throw new ApiError("学生独立计划不能使用班级公共反馈类型", 400, "invalid_request", false);
  }
  try {
    return {
      ...parsed,
      generationPreferences: normalizeFeedbackGenerationPreferences(parsed.type, parsed.generationPreferences),
    };
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "学生独立计划结构无效", 400, "invalid_request", false);
  }
}

type EffectiveFeedbackPlanConfig = {
  type: typeof FEEDBACK_PLAN_TYPES[number];
  outputRequirement: string;
  generationPreferences?: FeedbackGenerationPreferences;
  independent: boolean;
};

export function effectiveFeedbackPlanConfig(plan: { type: string; outputRequirement: string; inputSnapshot: string }, item: { studentId: string | null; generationConfigSnapshot?: string | null }): EffectiveFeedbackPlanConfig {
  const baseType = plan.type as typeof FEEDBACK_PLAN_TYPES[number];
  const override = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
  if (!override) {
    return {
      type: baseType,
      outputRequirement: plan.outputRequirement,
      generationPreferences: generationPreferencesFromSnapshot(baseType, plan.inputSnapshot),
      independent: false,
    };
  }
  if (!item.studentId) throw new ApiError("班级公共反馈条目不能使用学生独立计划", 400, "invalid_request", false);
  return {
    type: override.type,
    outputRequirement: override.outputRequirement,
    generationPreferences: override.generationPreferences,
    independent: true,
  };
}

export function bundleForPlanConfig(bundle: FeedbackEvidenceBundle, config: EffectiveFeedbackPlanConfig): FeedbackEvidenceBundle {
  return bundle.planType === config.type ? bundle : { ...bundle, planType: config.type } as FeedbackEvidenceBundle;
}

export function normalizedStudentOverrides(input: {
  overrides?: FeedbackPlanStudentOverride[];
  selectedIds: Array<string | null>;
  contextStudentIds: Set<string>;
}) {
  const selectedStudentIds = new Set(input.selectedIds.filter((studentId): studentId is string => Boolean(studentId)));
  const result = new Map<string, FeedbackPlanItemGenerationConfig>();
  for (const override of input.overrides ?? []) {
    if (!selectedStudentIds.has(override.studentId)) {
      throw new ApiError(`学生 ${override.studentId} 不属于本次反馈对象`, 400, "invalid_request", false);
    }
    if (!input.contextStudentIds.has(override.studentId)) {
      throw new ApiError(`学生 ${override.studentId} 不属于当前课次上下文`, 400, "invalid_request", false);
    }
    result.set(override.studentId, normalizeStudentGenerationConfig(override.generationConfig));
  }
  return result;
}

export function normalizedCoverageText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

export type FeedbackPlanDb = PrismaClient | Prisma.TransactionClient;

export function derivePlanStatus(items: Array<{ status: string }>) {
  if (!items.length) return "draft";
  if (items.some((item) => item.status === "stale")) return "stale";
  if (items.some((item) => item.status === "generating")) return "generating";
  if (items.some((item) => item.status === "queued")) return "queued";
  if (items.some((item) => item.status === "generation_failed")) return "generation_failed";
  if (items.every((item) => item.status === "exported")) return "exported";
  if (items.some((item) => item.status === "exported")) return "partially_exported";
  if (items.every((item) => item.status === "approved")) return "approved";
  if (items.some((item) => item.status === "approved")) return "partially_approved";
  if (items.some((item) => item.status === "needs_review")) return "in_review";
  return "draft";
}

export function generationProgress(items: Array<{ status: string }>) {
  return feedbackPlanItemStatusCounts(items);
}

export function assertLegacyFeedbackGenerationAvailable(generationApproach: unknown) {
  if (generationApproach === "legacy") {
    throw new ApiError(
      "旧生成方式已退役；请另存为新计划并选择受限反馈或自由反馈",
      409,
      "legacy_generation_retired",
      false,
    );
  }
}

export function parseCompositionSnapshot(value: string | null | undefined, planType: string, draftFeedback = "") {
  const parsed = FeedbackCompositionPlanSchema.safeParse(parseJson(value, null));
  if (parsed.success) return sanitizeFeedbackComposition(parsed.data);
  const fallback = FeedbackCompositionPlanSchema.parse({
    version: 1,
    closureType: planType === "class_update" ? "informational" : "positive_recognition",
    needParentAction: false,
    parentAction: null,
    modules: [],
    evidenceCoverage: [],
    draftFeedback,
  });
  return sanitizeFeedbackComposition(fallback);
}

export type StoredFeedbackPlanDraft = {
  id: string;
  displayName: string | null;
  basedOnPlanId: string | null;
  type: string;
  outputRequirement: string;
  status: string;
  semesterId: string;
  classId: string;
  sessionId: string | null;
  rangeStartSessionId: string | null;
  rangeEndSessionId: string | null;
  inputFingerprint: string;
  inputSnapshot: string;
  generationMode: string;
  generationApproach: string;
  generationStartedAt: Date | null;
  generationCompletedAt: Date | null;
  planRevision: number;
  archivedAt: Date | null;
  createdAt: Date;
  batchId: string | null;
  batch?: { status: string; archivedAt: Date | null } | null;
  items: Array<{
    id: string;
    studentId: string | null;
    status: string;
    evidenceSnapshot: string;
    generationConfigSnapshot: string;
    finalText: string | null;
    selectedGenerationId: string | null;
    approvedAt: Date | null;
    exportedAt: Date | null;
    student?: {
      name: string;
      studentId: string;
      communicationPreference: { preferenceSnapshot: string } | null;
    } | null;
  }>;
  session?: { code: string; date: string } | null;
  rangeEndSession?: { date: string } | null;
};
