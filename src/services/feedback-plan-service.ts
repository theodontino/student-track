import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertClassAvailable,
  assertFeedbackPlanAvailable,
  assertSemesterAvailable,
} from "@/services/academic-scope-recycle-service";
import { ApiError } from "@/lib/api-errors";
import {
  createFeedbackGenerationExecutionSnapshot,
  feedbackGenerationApproachForDerivedPlan,
  feedbackGenerationApproachForNewPlan,
  feedbackGenerationApproachLabel,
  feedbackGenerationExecutionPublicView,
  normalizeStoredFeedbackGenerationApproach,
  parseFeedbackGenerationExecutionSnapshot,
  serializeFeedbackGenerationExecutionSnapshot,
  withExplicitFreeFeedbackFallback,
  type FeedbackGenerationApproach,
  type FeedbackGenerationExecutionSnapshotV1,
  type StoredFeedbackGenerationApproach,
} from "@/lib/feedback-generation-approach";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommunicationPreferenceSchema,
  FEEDBACK_PLAN_TYPES,
  STUDENT_FEEDBACK_PLAN_TYPES,
  FeedbackAuditSnapshotSchema,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  FeedbackHistorySnapshotSchema,
  FeedbackPlanCloneDraftSchema,
  FeedbackPlanInputSnapshotSchema,
  FeedbackPlanInputSnapshotV2Schema,
  FeedbackPlanDraftPatchSchema,
  FeedbackPlanItemGenerationConfigSchema,
  FeedbackPlanCreateSchema,
  FeedbackPlanItemPatchSchema,
  FeedbackPlanRenameSchema,
  RESTRICTED_WRITER_OUTPUT_INVALID_CODE,
  isHardFeedbackAuditIssue,
  normalizeFeedbackGenerationPreferences,
  sanitizeFeedbackComposition,
  sanitizeFeedbackEvidenceBundle,
  type CommunicationPreference,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackGenerationPreferences,
  type FeedbackHistorySnapshot,
  type FeedbackPlanCloneDraftInput,
  type FeedbackPlanDraftPatch,
  type FeedbackPlanInputSnapshot,
  type FeedbackPlanIntakeSourceSummary,
  type FeedbackPlanAssessmentEvidenceInput,
  type FeedbackPlanCreateInput,
  type FeedbackPlanItemGenerationConfig,
  type FeedbackPlanStudentOverride,
  type FeedbackPlanItemPatch,
  type FeedbackPlanRenameInput,
} from "@/lib/feedback-plan";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import type { LessonFeedbackMaterial, StudentAssessmentEvidence } from "@/lib/feedback-materials";
import { stripFeedbackInternalBoundary } from "@/lib/feedback-text-safety";
import { resolveStudentTrackRuntimePath } from "@/lib/runtime-paths";
import { feedbackPlanActionBucket, feedbackPlanItemStatusCounts } from "@/lib/feedback-plan-summary";
import { blockAuditForRestrictedWriter, createAuditSnapshot, sha256 } from "@/services/feedback-plan-audit";
import { buildFeedbackContext, type FeedbackContextStudent } from "@/services/feedback-context-service";
import { generateFreeFeedbackPlanComposition } from "@/services/feedback-generation-service";
import {
  generateRestrictedFeedback,
  RestrictedFeedbackCheckpointV1Schema,
  type RestrictedFeedbackGenerationResult,
} from "@/services/restricted-feedback-generation-service";
import { recordSuccessfulGeneration } from "@/services/generation-memory-service";
import { semesterStudentWhere } from "@/services/student-enrollment-service";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function restrictedWriterBlockerFromAuditSnapshot(value: string | null | undefined) {
  const parsed = FeedbackAuditSnapshotSchema.safeParse(parseJson(value, null));
  return parsed.success
    ? parsed.data.items.find((issue) => issue.code === RESTRICTED_WRITER_OUTPUT_INVALID_CODE) ?? null
    : null;
}

function feedbackPlanDraftFingerprint(input: {
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

function beginFeedbackGenerationExecution(
  value: string | null | undefined,
  requestedApproach: FeedbackGenerationApproach,
  now = new Date(),
) {
  const parsed = parseFeedbackGenerationExecutionSnapshot(value);
  if (parsed && parsed.requestedApproach !== requestedApproach) {
    throw new ApiError("反馈生成方式已经冻结，请另存为新计划后修改", 409, "conflict", false);
  }
  const snapshot = parsed ?? createFeedbackGenerationExecutionSnapshot(requestedApproach);
  const timestamp = now.toISOString();
  const attempts = snapshot.attempts.map((attempt) => attempt.status === "running"
    ? { ...attempt, status: "interrupted" as const, completedAt: timestamp }
    : attempt);
  const actualApproach = snapshot.nextApproach;
  const trigger = attempts.length === 0
    ? "initial" as const
    : actualApproach !== snapshot.requestedApproach
      ? "explicit_fallback" as const
      : "retry" as const;
  const attempt = (attempts.at(-1)?.attempt ?? 0) + 1;
  const stage = actualApproach === "free"
    ? "free" as const
    : snapshot.restrictedCheckpoint
      ? "writer" as const
      : "planner" as const;
  const next: FeedbackGenerationExecutionSnapshotV1 = {
    ...snapshot,
    attempts: [...attempts, {
      attempt,
      trigger,
      actualApproach,
      stage,
      status: "running",
      startedAt: timestamp,
    }],
  };
  return { snapshot: next, attempt, actualApproach };
}

function generationErrorKind(error: unknown): "schema" | "timeout" | "connection" | "aborted" | "service" {
  if ((error instanceof DOMException && error.name === "AbortError")
    || (error instanceof ApiError && error.code === "cancelled")) return "aborted";
  if (error instanceof ApiError && error.code === "llm_schema_invalid") return "schema";
  const summary = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  if (/timeout|timed out|ETIMEDOUT|APIConnectionTimeout/i.test(summary)) return "timeout";
  if (/fetch failed|connection|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(summary)) return "connection";
  return "service";
}

function updateFeedbackGenerationExecutionStage(
  snapshot: FeedbackGenerationExecutionSnapshotV1,
  attemptNumber: number,
  stage: "planner" | "writer" | "free" | "deterministic_check",
) {
  return {
    ...snapshot,
    attempts: snapshot.attempts.map((attempt) => attempt.attempt === attemptNumber && attempt.status === "running"
      ? { ...attempt, stage }
      : attempt),
  } satisfies FeedbackGenerationExecutionSnapshotV1;
}

function completeFeedbackGenerationExecution(input: {
  snapshot: FeedbackGenerationExecutionSnapshotV1;
  attempt: number;
  status: "failed" | "succeeded" | "interrupted";
  completedAt?: Date;
  error?: unknown;
  generationRecordId?: string;
}) {
  const completedAt = (input.completedAt ?? new Date()).toISOString();
  const attempts = input.snapshot.attempts.map((attempt) => attempt.attempt === input.attempt
    ? {
        ...attempt,
        status: input.status,
        completedAt,
        ...(input.error ? {
          error: {
            code: input.error instanceof ApiError ? input.error.code : "llm_service_error",
            message: messageForGenerationError(input.error).slice(0, 500),
            retryable: input.error instanceof ApiError ? input.error.retryable : true,
            kind: generationErrorKind(input.error),
          },
        } : {}),
        ...(input.generationRecordId ? { generationRecordId: input.generationRecordId } : {}),
      }
    : attempt);
  return {
    ...input.snapshot,
    attempts,
    ...(input.status === "succeeded" ? { restrictedCheckpoint: undefined } : {}),
  } satisfies FeedbackGenerationExecutionSnapshotV1;
}

function generationPreferencesFromSnapshot(planType: string, inputSnapshot: string): FeedbackGenerationPreferences | undefined {
  if (!FEEDBACK_PLAN_TYPES.includes(planType as typeof FEEDBACK_PLAN_TYPES[number])) return undefined;
  const parsed = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(inputSnapshot, null));
  if (!parsed.success || !parsed.data.generationPreferences) return undefined;
  return normalizeFeedbackGenerationPreferences(
    planType as typeof FEEDBACK_PLAN_TYPES[number],
    parsed.data.generationPreferences,
  );
}

function parseGenerationConfigSnapshot(value: string | null | undefined): FeedbackPlanItemGenerationConfig | null {
  if (!value) return null;
  const raw = parseJson(value, null);
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return null;
  const parsed = FeedbackPlanItemGenerationConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function normalizeStudentGenerationConfig(value: unknown): FeedbackPlanItemGenerationConfig {
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

function effectiveFeedbackPlanConfig(plan: { type: string; outputRequirement: string; inputSnapshot: string }, item: { studentId: string | null; generationConfigSnapshot?: string | null }): EffectiveFeedbackPlanConfig {
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

function bundleForPlanConfig(bundle: FeedbackEvidenceBundle, config: EffectiveFeedbackPlanConfig): FeedbackEvidenceBundle {
  return bundle.planType === config.type ? bundle : { ...bundle, planType: config.type } as FeedbackEvidenceBundle;
}

function normalizedStudentOverrides(input: {
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

function normalizedCoverageText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

type FeedbackPlanDb = PrismaClient | Prisma.TransactionClient;
type NormalizedPlanAssessmentEvidence = Record<string, StudentAssessmentEvidence[]>;

function normalizePlanAssessmentEvidence(input: {
  assessmentEvidence?: FeedbackPlanAssessmentEvidenceInput;
  sessionCode: string;
  allowedStudentIds: string[];
}): NormalizedPlanAssessmentEvidence {
  const allowedStudentIds = new Set(input.allowedStudentIds);
  const normalized: NormalizedPlanAssessmentEvidence = {};
  for (const [studentId, value] of Object.entries(input.assessmentEvidence ?? {})) {
    if (!allowedStudentIds.has(studentId)) {
      throw new ApiError(`学生 ${studentId} 的测评证据不属于本次反馈对象`, 400, "invalid_request", false);
    }
    const evidenceItems = Array.isArray(value) ? value : [value];
    normalized[studentId] = evidenceItems.map((evidence) => {
      if (evidence.sessionCode && evidence.sessionCode !== input.sessionCode) {
        throw new ApiError(`学生 ${studentId} 的测评证据属于课次 ${evidence.sessionCode}`, 400, "invalid_request", false);
      }
      if (evidence.studentId && evidence.studentId !== studentId) {
        throw new ApiError(`测评证据绑定学生与提交学生 ${studentId} 不一致`, 400, "invalid_request", false);
      }
      return {
        ...evidence,
        sourceType: evidence.sourceType ?? "assessment_pdf",
        sessionCode: input.sessionCode,
        studentId,
      };
    });
  }
  return normalized;
}

function assessmentEvidenceItems(items: StudentAssessmentEvidence[]): FeedbackEvidenceBundle["assessmentEvidence"] {
  return items.map((evidence) => {
    const sourceType = evidence.sourceType ?? "assessment_pdf";
    const sourceLabel = sourceType === "classroom_practice" ? "课堂练习" : "出门测 PDF";
    const evidenceHash = sha256(JSON.stringify(evidence)).slice(0, 16);
    const knowledgePoints = evidence.knowledgePoints.slice(0, 20).map((item) => (
      `${item.name}：${item.questionCount}题，正确率${item.correctRate}%${item.cohortAverageRate === null ? "" : `，同期均值${item.cohortAverageRate}%`}`
    ));
    const wrongItems = evidence.wrongItems.slice(0, 20).map((item) => (
      `第${item.questionNumber}题本人答${item.studentAnswer || "未提取"}，正确答案${item.correctAnswer || "未提取"}${item.knowledgePoints.length ? `，涉及${item.knowledgePoints.join("、")}` : ""}`
    ));
    const content = [
      `${evidence.reportDate || "日期未知"} ${evidence.reportTitle || sourceLabel}：共${evidence.totalQuestions}题，正确率${evidence.correctRate}%${evidence.cohortAverageRate === null ? "" : `，同期均值${evidence.cohortAverageRate}%`}`,
      knowledgePoints.length ? `知识点结果：${knowledgePoints.join("；")}` : "",
      wrongItems.length ? `错题明细：${wrongItems.join("；")}` : "报告未列出错题",
      evidence.similarPracticeCount > 0 ? `报告附带${evidence.similarPracticeCount}道相似练习` : "",
    ].filter(Boolean).join("。").slice(0, 3000);
    return {
      id: `assessment-${sourceType}-${evidenceHash}`,
      kind: "fact" as const,
      content,
      sourceRefs: [{
        type: sourceType === "classroom_practice" ? "classroom-practice" : "assessment-pdf",
        id: `${sourceType}:${evidenceHash}`,
        label: sourceLabel,
      }],
      occurredAt: evidence.reportDate ? evidence.reportDate.slice(0, 64) : undefined,
      confirmed: true,
    };
  });
}

function persistedAssessmentEvidence(snapshot: string): FeedbackEvidenceBundle["assessmentEvidence"] {
  const parsed = FeedbackEvidenceBundleSchema.safeParse(parseJson(snapshot, null));
  return parsed.success ? sanitizeFeedbackEvidenceBundle(parsed.data).assessmentEvidence : [];
}

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

function generationProgress(items: Array<{ status: string }>) {
  return feedbackPlanItemStatusCounts(items);
}

function assertLegacyFeedbackGenerationAvailable(generationApproach: unknown) {
  if (generationApproach === "legacy") {
    throw new ApiError(
      "旧生成方式已退役；请另存为新计划并选择受限反馈或自由反馈",
      409,
      "legacy_generation_retired",
      false,
    );
  }
}

function generationTiming(plan: {
  generationElapsedMs?: number;
  generationRunStartedAt?: Date | null;
  generationStartedAt?: Date | null;
  generationCompletedAt?: Date | null;
  items: Array<{ status: string; generationDurationMs?: number | null }>;
}) {
  const now = new Date();
  const elapsedMs = Math.max(0, (plan.generationElapsedMs ?? 0) + (
    plan.generationRunStartedAt ? now.getTime() - plan.generationRunStartedAt.getTime() : 0
  ));
  const durations = plan.items.flatMap((item) => (
    item.status !== "generation_failed" && typeof item.generationDurationMs === "number"
      ? [item.generationDurationMs]
      : []
  ));
  return {
    startedAt: plan.generationStartedAt ?? null,
    completedAt: plan.generationCompletedAt ?? null,
    elapsedMs,
    completedItems: durations.length,
    averageItemMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    itemsPerMinute: elapsedMs > 0 && durations.length ? Number((durations.length / (elapsedMs / 60000)).toFixed(2)) : null,
    asOf: now,
  };
}

async function closeGenerationClock(
  planId: string,
  completed: boolean,
  db: FeedbackPlanDb,
  options: { status?: string; incrementPlanRevision?: boolean; expectedStatuses?: string[] } = {},
) {
  const now = new Date();
  const plan = await db.feedbackPlan.findUnique({
    where: { id: planId },
    select: { generationElapsedMs: true, generationRunStartedAt: true },
  });
  if (!plan) return 0;
  const elapsedMs = plan.generationElapsedMs + (
    plan.generationRunStartedAt ? Math.max(0, now.getTime() - plan.generationRunStartedAt.getTime()) : 0
  );
  const updated = await db.feedbackPlan.updateMany({
    where: {
      id: planId,
      ...(options.expectedStatuses ? { status: { in: options.expectedStatuses } } : {}),
    },
    data: {
      generationElapsedMs: elapsedMs,
      generationRunStartedAt: null,
      ...(completed ? { generationCompletedAt: now } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.incrementPlanRevision ? { planRevision: { increment: 1 } } : {}),
    },
  });
  return updated.count;
}

function messageForGenerationError(error: unknown) {
  const raw = error instanceof ApiError
    ? error.message
    : error instanceof Error && /LLM API Key|LLM.*配置|模型配置/i.test(error.message)
      ? error.message
    : error instanceof SyntaxError
      ? "模型返回的结构不完整，本条可单独重试"
      : "本条反馈生成失败，可单独重试";
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function activeTaskIds(tasks: Array<{ id: string; status: string }>) {
  return new Set(tasks.filter((task) => task.status !== "cancelled").map((task) => task.id));
}

function auditTaskIdsForBundle(
  bundle: FeedbackEvidenceBundle,
  tasks: Array<{ id: string; status: string }>,
) {
  return new Set([
    ...bundle.executionConstraints.existingTaskIds,
    ...activeTaskIds(tasks),
  ]);
}

function auditIdentityForPlanItem(
  plan: {
    inputSnapshot: string;
    items: Array<{
      id: string;
      studentId: string | null;
      student?: { name: string } | null;
    }>;
  },
  item: { id: string; studentId: string | null; student?: { name: string } | null },
) {
  const snapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
  if (snapshot.success && snapshot.data.version === 2) {
    const target = snapshot.data.factSnapshot.items.find((entry) => entry.studentId === item.studentId);
    return {
      studentName: item.studentId
        ? target?.studentName ?? target?.studentNumber ?? item.student?.name
        : undefined,
      otherStudentNames: snapshot.data.factSnapshot.items.flatMap((entry) => (
        entry.studentId && entry.studentId !== item.studentId && entry.studentName ? [entry.studentName] : []
      )),
    };
  }
  return {
    studentName: item.student?.name,
    otherStudentNames: plan.items.flatMap((entry) => (
      entry.id !== item.id && entry.student?.name ? [entry.student.name] : []
    )),
  };
}

function parseCompositionSnapshot(value: string | null | undefined, planType: string, draftFeedback = "") {
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

/**
 * Routes keep the pre-beta.3 legacy snapshot columns for historical readers.
 * The execution checkpoint is internal: only its public, version-checked
 * progress view may leave the service boundary.
 */
export function toFeedbackPlanItemView<T extends {
  evidenceSnapshot: string;
  compositionSnapshot: string;
  auditSnapshot: string;
  finalText?: string | null;
  generationConfigSnapshot?: string | null;
  generationExecutionSnapshot?: string | null;
}>(item: T, planType: string) {
  const evidence = FeedbackEvidenceBundleSchema.safeParse(parseJson(item.evidenceSnapshot, null));
  const composition = FeedbackCompositionPlanSchema.safeParse(parseJson(item.compositionSnapshot, null));
  const audit = FeedbackAuditSnapshotSchema.safeParse(parseJson(item.auditSnapshot, null));
  const { generationExecutionSnapshot, ...publicItem } = item;
  return {
    ...publicItem,
    finalText: typeof item.finalText === "string" ? stripFeedbackInternalBoundary(item.finalText) : item.finalText,
    evidence: evidence.success ? sanitizeFeedbackEvidenceBundle(evidence.data) : null,
    composition: composition.success ? sanitizeFeedbackComposition(composition.data) : parseCompositionSnapshot(item.compositionSnapshot, planType, item.finalText ?? ""),
    audit: audit.success ? audit.data : null,
    generationConfig: parseGenerationConfigSnapshot(item.generationConfigSnapshot),
    generationExecution: feedbackGenerationExecutionPublicView(generationExecutionSnapshot ?? null),
  };
}

export function toFeedbackPlanDetail<T extends {
  type: string;
  items: Array<{
    status: string;
    evidenceSnapshot: string;
    compositionSnapshot: string;
    auditSnapshot: string;
    finalText?: string | null;
    generationConfigSnapshot?: string | null;
    generationExecutionSnapshot?: string | null;
    generationDurationMs?: number | null;
  }>;
  generationElapsedMs?: number;
  generationRunStartedAt?: Date | null;
  generationStartedAt?: Date | null;
  generationCompletedAt?: Date | null;
  }>(plan: T) {
  const storedGenerationApproach = normalizeStoredFeedbackGenerationApproach(
    (plan as { generationApproach?: unknown }).generationApproach,
  );
  const legacyReadonly = (plan as { generationApproach?: unknown }).generationApproach === "legacy";
  const itemStatusCounts = generationProgress(plan.items);
  return {
    ...plan,
    generationApproach: storedGenerationApproach === "legacy" ? null : storedGenerationApproach,
    generationApproachLabel: feedbackGenerationApproachLabel(storedGenerationApproach),
    legacyReadonly,
    items: plan.items.map((item) => toFeedbackPlanItemView(item, plan.type)),
    input: FeedbackPlanInputSnapshotSchema.safeParse(parseJson((plan as { inputSnapshot?: string }).inputSnapshot, null)).success
      ? FeedbackPlanInputSnapshotSchema.parse(parseJson((plan as { inputSnapshot?: string }).inputSnapshot, null))
      : null,
    itemStatusCounts,
    actionBucket: feedbackPlanActionBucket((plan as { status?: string }).status ?? "draft", itemStatusCounts),
    generationProgress: itemStatusCounts,
    generationTiming: generationTiming(plan),
  };
}

function defaultLessonMaterial(): LessonFeedbackMaterial {
  return LessonFeedbackMaterialSchema.parse({
    version: 1,
    groupFeedbackRaw: "",
    assessmentBriefRaw: "",
    lessonTitle: "",
    classroomContent: [],
    classroomFocus: [],
    classroomExplanation: [],
    homework: [],
    assessmentFocus: [],
    correctionAdvice: [],
    otherNotes: [],
  });
}

function lessonMaterialBackground(material: LessonFeedbackMaterial | undefined) {
  if (!material) return [];
  return [
    material.lessonTitle ? `课程标题：${material.lessonTitle}` : "",
    material.lessonSummary ? `课程摘要：${material.lessonSummary}` : "",
    ...material.classroomContent.map((value) => `课堂内容：${value}`),
    ...material.classroomFocus.map((value) => `课堂重点：${value}`),
    ...material.classroomExplanation.map((value) => `课堂讲解：${value}`),
    ...material.homework.map((value) => `统一课后任务：${value}`),
    ...material.assessmentFocus.map((value) => `测评范围：${value}`),
    ...material.correctionAdvice.map((value) => `统一订正建议：${value}`),
    ...material.otherNotes.map((value) => `课程备注：${value}`),
  ].filter(Boolean).slice(0, 100);
}

function historySnapshot(student: FeedbackContextStudent | null): FeedbackHistorySnapshot | null {
  if (!student) return null;
  const current = student.rawMetrics.current;
  const recent = student.rawMetrics.recent.filter((metric) => metric.sessionId !== current.sessionId).slice(0, 5).map((metric) => ({
    metricId: metric.metricId,
    sessionId: metric.sessionId,
    date: metric.date,
    semesterNumber: metric.semesterNumber,
    scoreA: metric.scoreA,
    scoreB: metric.scoreB,
    scoreC: metric.scoreC,
    scoreD: metric.scoreD,
  }));
  const currentMetric = current.metricId || [current.scoreA, current.scoreB, current.scoreC, current.scoreD].some((value) => value !== null)
    ? {
      metricId: current.metricId,
      sessionId: current.sessionId,
      date: current.date,
      semesterNumber: current.semesterNumber,
      scoreA: current.scoreA,
      scoreB: current.scoreB,
      scoreC: current.scoreC,
      scoreD: current.scoreD,
      present: current.present,
    }
    : null;
  const previous = recent.find((metric) => metric.sessionId !== currentMetric?.sessionId) ?? null;
  return FeedbackHistorySnapshotSchema.parse({
    version: 1,
    current: currentMetric,
    previous,
    recent,
    semesterAverage: {
      A: student.rawMetrics.performanceBaseline.semesterAverageA,
      B: student.rawMetrics.performanceBaseline.semesterAverageB,
      C: student.rawMetrics.performanceBaseline.semesterAverageC,
      D: student.rawMetrics.performanceBaseline.semesterAverageD,
    },
  });
}

function planAnchorSession(input: FeedbackPlanCreateInput) {
  return input.type === "stage_trend" || input.type === "course_end"
    ? input.rangeEndSessionId ?? input.sessionId ?? input.rangeStartSessionId
    : input.sessionId ?? input.rangeEndSessionId ?? input.rangeStartSessionId;
}

async function resolveSession(db: FeedbackPlanDb, value: string | undefined) {
  if (!value) return null;
  const byId = await db.classSession.findUnique({
    where: { id: value },
    select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true },
  });
  return byId ?? db.classSession.findUnique({
    where: { code: value },
    select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true },
  });
}

async function assertPlanScope(db: FeedbackPlanDb, input: FeedbackPlanCreateInput) {
  if (!planAnchorSession(input)) throw new ApiError("反馈计划必须关联课次或阶段范围", 400, "invalid_request", false);
  const values = [input.sessionId, input.rangeStartSessionId, input.rangeEndSessionId].filter((value): value is string => Boolean(value));
  if (values.length) {
    const sessions = await Promise.all(values.map((value) => resolveSession(db, value)));
    if (sessions.some((session) => !session)) throw new ApiError("反馈计划引用的课次不存在", 404, "not_found", false);
    if (sessions.some((session) => session && (session.classId !== input.classId || session.semesterId !== input.semesterId))) {
      throw new ApiError("反馈计划引用的课次必须属于同一班级和学期", 400, "invalid_request", false);
    }
  }
  if (input.studentIds?.length) {
    const studentIds = [...new Set(input.studentIds)];
    const anchor = await resolveSession(db, planAnchorSession(input));
    const students = await db.student.findMany({
      where: {
        id: { in: studentIds },
        OR: [
          semesterStudentWhere({ semesterId: input.semesterId, classId: input.classId, studentIds }),
          ...(anchor ? [
            { sessionMetrics: { some: { sessionId: anchor.id } } },
            { attendances: { some: { sessionId: anchor.id } } },
            { events: { some: { sessionId: anchor.id } } },
            { communications: { some: { sessionId: anchor.id } } },
          ] : []),
        ],
      },
      select: { id: true },
    });
    if (students.length !== studentIds.length) throw new ApiError("反馈计划包含不属于当前班级的学生", 400, "invalid_request", false);
  }
}

function evidenceFromStudent(input: {
  planType: FeedbackPlanCreateInput["type"];
  student: FeedbackContextStudent | null;
  sourceFingerprint: string;
  existingTaskIds?: string[];
  assessmentEvidence?: StudentAssessmentEvidence[];
  preservedAssessmentEvidence?: FeedbackEvidenceBundle["assessmentEvidence"];
  lessonMaterial?: LessonFeedbackMaterial;
}): FeedbackEvidenceBundle {
  const student = input.student;
  const current = student?.rawMetrics.current;
  const currentEvents = current?.events ?? [];
  const currentEventRefs = current?.eventRefs ?? [];
  const currentEventIds = new Set(currentEventRefs.map((event) => event.id));
  const rangeEvents = (input.planType === "stage_trend" || input.planType === "course_end")
    ? (student?.rawMetrics.recentEventRefs ?? []).filter((event) => !currentEventIds.has(event.id))
    : [];
  const teacherInterventionEvents = currentEventRefs.concat(rangeEvents).filter((event) => event.type === "教师处理" || (event.description.startsWith("观察问题：") && event.description.includes("教师处理：")));
  const isTeacherIntervention = (content: string, index: number) => Boolean(currentEventRefs[index]?.type === "教师处理" || teacherInterventionEvents.some((event) => event.description === content));
  const teachingEvidence = student
    ? [
      ...currentEvents.map((content, index) => ({
        id: isTeacherIntervention(content, index) ? `teacher-intervention-${index}` : `current-event-${index}`,
        kind: isTeacherIntervention(content, index) ? "teacher_judgment" as const : "fact" as const,
        content,
        sourceRefs: [{ type: isTeacherIntervention(content, index) ? "teacher-intervention" : "session-event", id: currentEventRefs[index]!.id, label: isTeacherIntervention(content, index) ? "已确认教师处理" : "本次课堂记录" }],
        confirmed: true,
      })),
      ...rangeEvents.map((event, index) => ({
        id: `range-event-${index}`,
        kind: event.type === "教师处理" || (event.description.startsWith("观察问题：") && event.description.includes("教师处理："))
          ? "teacher_judgment" as const
          : "fact" as const,
        content: `${event.date ? `${event.date}：` : ""}${event.description}`,
        sourceRefs: [{ type: event.type === "教师处理" ? "teacher-intervention" : "session-event", id: event.id, label: event.type === "教师处理" ? "已确认教师处理" : "阶段课堂记录" }],
        occurredAt: event.date,
        confirmed: true,
      })),
      ...(current?.scoreA !== null && current?.scoreA !== undefined ? [{
        id: "current-score-a",
        kind: "fact" as const,
        content: `本次学习测验 ${current.scoreA} 分`,
        sourceRefs: [{ type: "session-metric", id: current.metricId!, label: "本次学习评价" }],
        confirmed: true,
      }] : []),
      ...(current?.scoreB !== null && current?.scoreB !== undefined ? [{
        id: "current-score-b",
        kind: "fact" as const,
        content: `本次课堂状态 ${current.scoreB} 分`,
        sourceRefs: [{ type: "session-metric", id: current.metricId!, label: "本次课堂评价" }],
        confirmed: true,
      }] : []),
      ...(input.planType === "stage_trend" || input.planType === "course_end"
        ? student.rawMetrics.recent.map((metric) => ({
          id: `recent-metric-${metric.metricId}`,
          kind: "fact" as const,
          content: `${metric.date} 第${metric.semesterNumber}次课：学习测验 ${metric.scoreA} 分，课堂状态 ${metric.scoreB} 分，课后任务 ${metric.scoreC} 分`,
          sourceRefs: [{ type: "session-metric", id: metric.metricId!, label: "近期评价趋势" }],
          occurredAt: metric.date,
          confirmed: true,
        }))
        : []),
      ...((input.planType === "stage_trend" || input.planType === "course_end") && student.rawMetrics.performanceBaseline.semesterValidCount > 0 ? [{
        id: "performance-baseline",
        kind: "fact" as const,
        content: `学期已有 ${student.rawMetrics.performanceBaseline.semesterValidCount} 次有效学习评价，近期两次 ${student.rawMetrics.performanceBaseline.recentAverageA ?? "暂无"} 分，学期平均 ${student.rawMetrics.performanceBaseline.semesterAverageA ?? "暂无"} 分`,
        sourceRefs: [{ type: "derived-baseline", id: student.id, label: "确定性趋势基线" }],
        confirmed: true,
      }] : []),
    ]
    : [];
  const communicationContext = student?.rawMetrics.communications.map((item) => ({
    id: `communication-${item.id}`,
    kind: "fact" as const,
    content: `${item.occurredAt || item.date} 与${item.target}：${item.summary}`,
    sourceRefs: [{ type: "communication", id: item.id!, label: "近期家校沟通" }],
    occurredAt: item.occurredAt || item.date,
    confirmed: true,
  })) ?? [];
  const assessmentEvidence = input.assessmentEvidence
    ? assessmentEvidenceItems(input.assessmentEvidence)
    : input.preservedAssessmentEvidence ?? [];
  const allEvidence: FeedbackEvidenceBundle["teachingEvidence"] = [
    ...teachingEvidence,
    ...assessmentEvidence,
    ...communicationContext,
  ];
  return FeedbackEvidenceBundleSchema.parse({
    version: 2,
    planType: input.planType,
    studentId: student?.id ?? null,
    teachingEvidence,
    assessmentEvidence,
    communicationContext,
    executionConstraints: {
      existingTaskIds: input.existingTaskIds ?? [],
      fixedArrangementRefs: [],
      teacherInterventionPresent: teacherInterventionEvents.length > 0,
    },
    sourceRefs: [
      ...(student ? [{ type: "student", id: student.id, label: student.name }] : []),
      ...allEvidence.flatMap((entry) => entry.sourceRefs),
    ],
    sourceFingerprint: input.sourceFingerprint,
    teachingBackground: lessonMaterialBackground(input.lessonMaterial),
    historySnapshot: historySnapshot(student),
  });
}

function evidenceFromClassContext(input: {
  planType: FeedbackPlanCreateInput["type"];
  students: FeedbackContextStudent[];
  sessionId?: string;
  sourceFingerprint: string;
  existingTaskIds?: string[];
  lessonMaterial?: LessonFeedbackMaterial;
}) : FeedbackEvidenceBundle {
  const evidence = input.students.flatMap((student) => [
    ...student.rawMetrics.current.events.slice(0, 4).map((content, index) => ({
      id: `class-event-${student.id}-${index}`,
      kind: content.startsWith("观察问题：") && content.includes("教师处理：") ? "teacher_judgment" as const : "fact" as const,
      content: `${student.name}：${content}`,
      sourceRefs: [{ type: "session-event", id: student.rawMetrics.current.eventRefs![index]!.id, label: "本次班级课堂记录" }],
      confirmed: true,
    })),
    ...(student.rawMetrics.current.scoreA !== null ? [{
      id: `class-score-a-${student.id}`,
      kind: "fact" as const,
      content: `${student.name} 本次学习测验 ${student.rawMetrics.current.scoreA} 分`,
      sourceRefs: [{ type: "session-metric", id: student.rawMetrics.current.metricId!, label: "本次班级评价" }],
      confirmed: true,
    }] : []),
  ]);
  return FeedbackEvidenceBundleSchema.parse({
    version: 2,
    planType: input.planType,
    studentId: null,
    teachingEvidence: evidence.slice(0, 100),
    assessmentEvidence: [],
    communicationContext: [],
    executionConstraints: {
      existingTaskIds: input.existingTaskIds ?? [],
      fixedArrangementRefs: [],
      teacherInterventionPresent: evidence.some((item) => item.kind === "teacher_judgment"),
    },
    sourceRefs: [
      { type: "class-session", id: input.sessionId!, label: "本次班级课堂记录" },
      ...evidence.flatMap((entry) => entry.sourceRefs),
    ],
    sourceFingerprint: input.sourceFingerprint,
    teachingBackground: lessonMaterialBackground(input.lessonMaterial),
    historySnapshot: null,
  });
}

async function findContextForPlan(db: FeedbackPlanDb, input: FeedbackPlanCreateInput) {
  const anchor = planAnchorSession(input);
  if (!anchor) return null;
  const session = await db.classSession.findUnique({ where: { id: anchor }, select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true } })
    ?? await db.classSession.findUnique({ where: { code: anchor }, select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true } });
  if (!session) throw new ApiError("课次不存在", 404, "not_found", false);
  const sessions = await db.classSession.findMany({
    where: { classId: input.classId, semesterId: input.semesterId },
    select: { id: true, date: true, semesterNumber: true },
    orderBy: [{ date: "asc" }, { semesterNumber: "asc" }, { createdAt: "asc" }],
  });
  const startIndex = input.rangeStartSessionId ? sessions.findIndex((item) => item.id === input.rangeStartSessionId) : -1;
  const endIndex = input.rangeEndSessionId ? sessions.findIndex((item) => item.id === input.rangeEndSessionId) : -1;
  if (startIndex >= 0 && endIndex >= 0 && startIndex > endIndex) {
    throw new ApiError("反馈计划起始课次不能晚于截止课次", 400, "invalid_request", false);
  }
  const rangeSessionIds = startIndex >= 0 && endIndex >= 0
    ? sessions.slice(startIndex, endIndex + 1).map((item) => item.id)
    : input.type === "stage_trend" || input.type === "course_end"
      ? sessions.filter((item) => item.id === session.id || (item.date < session.date || (item.date === session.date && item.semesterNumber <= session.semesterNumber))).slice(-(input.type === "stage_trend" ? 4 : sessions.length)).map((item) => item.id)
      : undefined;
  return buildFeedbackContext(db, session.code, {
    ...(rangeSessionIds?.length ? { sessionIds: rangeSessionIds } : {}),
    ...(input.studentIds?.length ? { includeStudentIds: input.studentIds } : {}),
  });
}

function candidateStudentIds(input: FeedbackPlanCreateInput, context: Awaited<ReturnType<typeof buildFeedbackContext>> | null) {
  if (input.type === "class_update") return [null];
  if (input.studentIds) return [...new Set(input.studentIds)];
  return context?.students
    .filter((student) => input.type === "event_micro"
      ? student.feedbackRecommendationReasons.length > 0
      : student.rawMetrics.recent.length > 0 || student.rawMetrics.current.events.length > 0)
    .map((student) => student.id) ?? [];
}

type FeedbackPlanNameScope = {
  semesterId: string;
  classId: string;
  sessionId?: string | null;
  rangeStartSessionId?: string | null;
  rangeEndSessionId?: string | null;
};

async function allocateFeedbackPlanDisplayName(
  db: FeedbackPlanDb,
  scope: FeedbackPlanNameScope,
  requestedName: string,
  excludePlanId?: string,
) {
  const baseName = requestedName.trim();
  const plans = await db.feedbackPlan.findMany({
    where: {
      semesterId: scope.semesterId,
      classId: scope.classId,
      sessionId: scope.sessionId ?? null,
      rangeStartSessionId: scope.rangeStartSessionId ?? null,
      rangeEndSessionId: scope.rangeEndSessionId ?? null,
      ...(excludePlanId ? { id: { not: excludePlanId } } : {}),
      displayName: { not: null },
    },
    select: { displayName: true },
  });
  const names = new Set(plans.flatMap((plan) => plan.displayName ? [plan.displayName] : []));
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName} ${suffix}`)) suffix += 1;
  return `${baseName} ${suffix}`;
}

function numberFromSnapshot(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

async function feedbackPlanIntakeSources(
  db: FeedbackPlanDb,
  intakeRunIds: string[] | undefined,
  expectedSessionCode: string | undefined,
): Promise<FeedbackPlanIntakeSourceSummary[]> {
  const ids = [...new Set(intakeRunIds ?? [])];
  if (!ids.length) return [];
  const runs = await db.feedbackIntakeRun.findMany({ where: { id: { in: ids } } });
  if (runs.length !== ids.length) throw new ApiError("反馈计划引用的材料运行不存在", 404, "not_found", false);
  const byId = new Map(runs.map((run) => [run.id, run]));
  return ids.map((id) => {
    const run = byId.get(id)!;
    if (run.status !== "applied") throw new ApiError("反馈计划只能使用已经确认的材料运行", 409, "conflict", false);
    if (expectedSessionCode && run.sessionCode !== expectedSessionCode) {
      throw new ApiError("反馈计划材料运行与目标课次不一致", 409, "conflict", false);
    }
    const applied = parseJson<Record<string, unknown>>(run.appliedSummary, {});
    const scopeConfirmation = applied.scopeConfirmation && typeof applied.scopeConfirmation === "object"
      ? applied.scopeConfirmation as Record<string, unknown>
      : null;
    const manifest = parseJson<Array<Record<string, unknown>>>(run.sourceManifest, []);
    const issues = parseJson<unknown[]>(run.issues, []);
    const decisions = Array.isArray(applied.decisions)
      ? applied.decisions.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const decision = value as Record<string, unknown>;
        if (typeof decision.action !== "string" || !decision.action.trim()) return [];
        return [{
          action: decision.action.slice(0, 80),
          ...(typeof decision.sourceName === "string" && decision.sourceName.trim()
            ? { sourceName: decision.sourceName.slice(0, 500) }
            : {}),
          ...(typeof decision.text === "string" && decision.text.trim()
            ? { detail: decision.text.slice(0, 500) }
            : {}),
        }];
      })
      : [];
    return {
      intakeRunId: run.id,
      sessionCode: run.sessionCode,
      status: run.status,
      confirmedAt: typeof scopeConfirmation?.confirmedAt === "string" ? scopeConfirmation.confirmedAt : null,
      sourceCount: numberFromSnapshot(applied.sourceCount) || manifest.length,
      recognizedCount: numberFromSnapshot(applied.recognizedCount),
      ignoredCount: numberFromSnapshot(applied.ignoredCount),
      issueCount: numberFromSnapshot(applied.issueCount) || issues.length,
      resolvedDecisionCount: decisions.length,
      resolutions: decisions,
      sources: manifest.map((source) => ({
        name: typeof source.name === "string" ? source.name : "未命名材料",
        kind: typeof source.kind === "string" ? source.kind : "unknown",
        source: typeof source.source === "string" ? source.source : "upload",
      })),
    };
  });
}

export async function createFeedbackPlan(
  rawInput: FeedbackPlanCreateInput,
  db: FeedbackPlanDb = prisma,
  options: { withinTransaction?: boolean } = {},
): Promise<NonNullable<Awaited<ReturnType<typeof getFeedbackPlan>>>> {
  const parsedInput = FeedbackPlanCreateSchema.parse(rawInput);
  await assertSemesterAvailable(parsedInput.semesterId, db);
  await assertClassAvailable(parsedInput.classId, db);
  if (parsedInput.requestKey && !options.withinTransaction && "$transaction" in db) {
    return (db as PrismaClient).$transaction((tx) => createFeedbackPlan(parsedInput, tx, { withinTransaction: true }));
  }
  let generationPreferences: FeedbackGenerationPreferences;
  try {
    generationPreferences = normalizeFeedbackGenerationPreferences(parsedInput.type, parsedInput.generationPreferences);
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "生成结构设置无效", 400, "invalid_request", false);
  }
  await assertPlanScope(db, parsedInput);
  const lessonMaterial = parsedInput.lessonMaterial ?? defaultLessonMaterial();
  const input = {
    ...parsedInput,
    generationPreferences,
    generationApproach: feedbackGenerationApproachForNewPlan(parsedInput.generationApproach),
    lessonMaterial,
    sessionId: (await resolveSession(db, parsedInput.sessionId))?.id ?? parsedInput.sessionId,
    rangeStartSessionId: (await resolveSession(db, parsedInput.rangeStartSessionId))?.id ?? parsedInput.rangeStartSessionId,
    rangeEndSessionId: (await resolveSession(db, parsedInput.rangeEndSessionId))?.id ?? parsedInput.rangeEndSessionId,
  } satisfies FeedbackPlanCreateInput;
  if (input.basedOnPlanId) {
    const source = await db.feedbackPlan.findUnique({
      where: { id: input.basedOnPlanId },
      select: { id: true, batchId: true, semesterId: true, classId: true, type: true },
    });
    if (!source) throw new ApiError("来源反馈计划不存在", 404, "not_found", false);
    if (source.batchId) throw new ApiError("班级组计划必须从班级组整体建立当前事实修订", 409, "conflict", false);
    if (source.semesterId !== input.semesterId || source.classId !== input.classId || source.type !== input.type) {
      throw new ApiError("来源反馈计划与当前学期、班级或反馈类型不一致", 409, "conflict", false);
    }
  }
  let context = await findContextForPlan(db, input);
  let rangeStartSessionId = input.rangeStartSessionId;
  const rangeEndSessionId = input.rangeEndSessionId ?? ((input.type === "stage_trend" || input.type === "course_end") ? input.sessionId : undefined);
  const anchorId = rangeEndSessionId ?? input.sessionId;
  const anchorSession = anchorId
    ? await db.classSession.findUnique({ where: { id: anchorId }, select: { id: true, date: true, semesterNumber: true } })
    : null;
  if (input.type === "stage_trend" && !rangeStartSessionId) {
    const previous = await db.feedbackPlan.findFirst({
      where: { classId: input.classId, semesterId: input.semesterId, type: "stage_trend", status: { in: ["approved", "partially_exported", "exported"] } },
      orderBy: { updatedAt: "desc" },
      select: { rangeEndSessionId: true },
    });
    if (previous?.rangeEndSessionId) {
      const previousEnd = await db.classSession.findUnique({ where: { id: previous.rangeEndSessionId }, select: { date: true, semesterNumber: true } });
      const next = await db.classSession.findFirst({
        where: {
          classId: input.classId,
          semesterId: input.semesterId,
          ...(previousEnd ? { OR: [{ date: { gt: previousEnd.date } }, { date: previousEnd.date, semesterNumber: { gt: previousEnd.semesterNumber } }] } : {}),
          ...(anchorSession ? { AND: [{ OR: [{ date: { lt: anchorSession.date } }, { date: anchorSession.date, semesterNumber: { lte: anchorSession.semesterNumber } }] }] } : {}),
        },
        orderBy: [{ date: "asc" }, { semesterNumber: "asc" }],
        select: { id: true },
      });
      if (!next) throw new ApiError("上一份阶段反馈之后没有新的课次，请调整阶段范围", 409, "conflict", false);
      rangeStartSessionId = next.id;
    } else {
      const sessions = await db.classSession.findMany({
        where: {
          classId: input.classId,
          semesterId: input.semesterId,
          ...(anchorSession ? { OR: [{ date: { lt: anchorSession.date } }, { date: anchorSession.date, semesterNumber: { lte: anchorSession.semesterNumber } }] } : {}),
        },
        orderBy: [{ date: "desc" }, { semesterNumber: "desc" }],
        take: 4,
        select: { id: true },
      });
      rangeStartSessionId = sessions.at(-1)?.id;
    }
  }
  if (input.type === "course_end" && !rangeStartSessionId) {
    rangeStartSessionId = (await db.classSession.findFirst({
      where: { classId: input.classId, semesterId: input.semesterId },
      orderBy: [{ date: "asc" }, { semesterNumber: "asc" }],
      select: { id: true },
    }))?.id;
  }

  if (input.requestKey) {
    const candidates = await db.feedbackPlan.findMany({
      where: { semesterId: input.semesterId, archivedAt: null },
      select: {
        id: true,
        classId: true,
        sessionId: true,
        rangeStartSessionId: true,
        rangeEndSessionId: true,
        basedOnPlanId: true,
        inputSnapshot: true,
      },
    });
    const existing = candidates.find((candidate) => {
      const snapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(candidate.inputSnapshot, null));
      return snapshot.success && snapshot.data.version === 2 && snapshot.data.draftRequestKey === input.requestKey;
    });
    if (existing) {
      const sameScope = existing.classId === input.classId
        && existing.sessionId === (input.sessionId ?? null)
        && existing.rangeStartSessionId === (rangeStartSessionId ?? null)
        && existing.rangeEndSessionId === (rangeEndSessionId ?? null)
        && existing.basedOnPlanId === (input.basedOnPlanId ?? null);
      if (!sameScope) throw new ApiError("反馈计划请求标识已用于另一个班级或课次", 409, "conflict", false);
      const detail = await getFeedbackPlan(existing.id, db);
      if (!detail) throw new Error("反馈计划幂等恢复后无法读取");
      return detail;
    }
  }

  // 先确定真实范围，再组装证据；否则阶段/结课计划会错误地复用当前课次的五次近期上下文。
  context = await findContextForPlan(db, {
    ...input,
    rangeStartSessionId,
    rangeEndSessionId,
    studentIds: undefined,
  });
  const selectedIds = candidateStudentIds(input, context);
  if (!selectedIds.length) throw new ApiError("没有可加入反馈计划的学生", 400, "invalid_request", false);
  const contextStudentIds = context?.students.map((student) => student.id) ?? [];
  const missingSelectedStudent = selectedIds.find((studentId) => studentId !== null && !contextStudentIds.includes(studentId));
  if (missingSelectedStudent) throw new ApiError("反馈计划包含不属于当前课次上下文的学生", 400, "invalid_request", false);
  const assessmentByStudent = normalizePlanAssessmentEvidence({
    assessmentEvidence: input.assessmentEvidence,
    sessionCode: context?.session.code ?? "",
    allowedStudentIds: contextStudentIds,
  });
  const contextByStudent = new Map(context?.students.map((student) => [student.id, student]) ?? []);
  const studentOverridesById = normalizedStudentOverrides({
    overrides: input.studentOverrides,
    selectedIds,
    contextStudentIds: new Set(contextStudentIds),
  });
  const existingTasks = await db.teacherTask.findMany({
    where: {
      classId: input.classId,
      status: "pending",
      ...(input.type === "class_update"
        ? {}
        : { studentId: { in: contextStudentIds } }),
    },
    select: { id: true, studentId: true },
  });
  const taskIdsByStudent = new Map<string | null, string[]>();
  for (const task of existingTasks) {
    const key = task.studentId ?? null;
    taskIdsByStudent.set(key, [...(taskIdsByStudent.get(key) ?? []), task.id]);
  }

  const sourceFingerprint = sha256(JSON.stringify({
    input: {
      type: input.type,
      outputRequirement: input.outputRequirement,
      generationApproach: input.generationApproach,
      semesterId: input.semesterId,
      classId: input.classId,
      sessionId: input.sessionId,
      rangeStartSessionId,
      rangeEndSessionId,
      studentIds: selectedIds,
      generationPreferences,
    },
    rangeStartSessionId,
    rangeEndSessionId,
    context: context?.students.map((student) => ({
      id: student.id,
      promptContext: student.promptContext,
      communicationPreference: student.communicationPreference ?? null,
    })) ?? [],
    executionConstraints: {
      existingTaskIds: existingTasks.map((task) => task.id).sort(),
      fixedArrangementRefs: [],
    },
    assessmentEvidence: assessmentByStudent,
    lessonMaterial,
    studentOverrides: Object.fromEntries(studentOverridesById),
  }));

  const factStudentIds: Array<string | null> = input.type === "class_update" ? [null] : contextStudentIds;
  const frozenFacts = factStudentIds.map((studentId) => {
    const student = studentId ? contextByStudent.get(studentId) ?? null : null;
    const evidence = input.type === "class_update"
      ? evidenceFromClassContext({
        planType: input.type,
        students: context?.students ?? [],
        sessionId: input.sessionId ?? rangeEndSessionId,
        sourceFingerprint,
        existingTaskIds: taskIdsByStudent.get(null),
        lessonMaterial,
      })
      : evidenceFromStudent({
        planType: input.type,
        student,
        sourceFingerprint,
        existingTaskIds: taskIdsByStudent.get(studentId),
        assessmentEvidence: studentId ? assessmentByStudent[studentId] : undefined,
        lessonMaterial,
      });
    return {
      studentId,
      ...(student ? {
        studentName: student.name,
        studentNumber: student.studentId,
        communicationPreference: student.communicationPreference ?? null,
      } : {}),
      ...(context?.session.date ? { referenceDate: context.session.date } : {}),
      evidence,
    };
  });
  const intakeSources = await feedbackPlanIntakeSources(db, input.intakeRunIds, context?.session.code);
  const inputSnapshot: FeedbackPlanInputSnapshot = {
    version: 2,
    ...(input.requestKey ? { draftRequestKey: input.requestKey } : {}),
    semesterId: input.semesterId,
    classId: input.classId,
    sessionId: input.sessionId,
    rangeStartSessionId,
    rangeEndSessionId,
    sessionCode: context?.session.code,
    sourceFingerprint,
    lessonMaterial,
    generationPreferences,
    selectedStudentIds: selectedIds.filter((studentId): studentId is string => Boolean(studentId)),
    studentOverrides: [...studentOverridesById.entries()].map(([studentId, generationConfig]) => ({ studentId, generationConfig })),
    factSnapshot: {
      capturedAt: new Date().toISOString(),
      items: frozenFacts,
    },
    intakeSources,
  };
  const inputFingerprint = feedbackPlanDraftFingerprint({
    snapshot: inputSnapshot,
    type: input.type,
    outputRequirement: input.outputRequirement,
    generationApproach: input.generationApproach,
    generationPreferences,
    selectedStudentIds: selectedIds,
    studentOverrides: studentOverridesById,
  });

  const frozenFactsByStudent = new Map(frozenFacts.map((fact) => [fact.studentId, fact.evidence]));

  const createInDb = async (tx: FeedbackPlanDb) => {
    const displayName = parsedInput.displayName === null
      || (input.basedOnPlanId !== undefined && parsedInput.displayName === undefined)
      ? null
      : await allocateFeedbackPlanDisplayName(tx, {
        semesterId: input.semesterId,
        classId: input.classId,
        sessionId: input.sessionId,
        rangeStartSessionId,
        rangeEndSessionId,
      }, parsedInput.displayName ?? "初版计划");
    const plan = await tx.feedbackPlan.create({
      data: {
        displayName,
        basedOnPlanId: input.basedOnPlanId,
        type: input.type,
        outputRequirement: input.outputRequirement,
        semesterId: input.semesterId,
        classId: input.classId,
        sessionId: input.sessionId,
        rangeStartSessionId,
        rangeEndSessionId,
        inputFingerprint,
        inputSnapshot: json(inputSnapshot),
        generationApproach: input.generationApproach,
        items: {
          create: selectedIds.map((studentId) => {
            const bundle = frozenFactsByStudent.get(studentId);
            if (!bundle) throw new ApiError("反馈计划冻结事实缺少所选学生", 409, "conflict", false);
            return {
              studentId,
              evidenceSnapshot: json(bundle),
              generationConfigSnapshot: studentId && studentOverridesById.has(studentId)
                ? json({ ...studentOverridesById.get(studentId), version: 1 })
                : "{}",
            };
          }),
        },
      },
      include: { items: true },
    });
    return plan;
  };
  // Batch/intake callers explicitly mark their existing transaction. Standalone
  // creation owns this final write transaction itself.
  const created = options.withinTransaction
    ? await createInDb(db)
    : "$transaction" in db
      ? await (db as PrismaClient).$transaction((tx) => createInDb(tx))
    : await createInDb(db);
  const detail = await getFeedbackPlan(created.id, db);
  if (!detail) throw new Error("反馈计划创建后无法读取");
  return detail;
}

export async function getFeedbackPlan(id: string, db: FeedbackPlanDb = prisma) {
  const plan = await db.feedbackPlan.findUnique({
    where: { id },
    include: {
      items: { include: { student: { include: { communicationPreference: true, communicationPreferenceCandidates: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } } }, tasks: true, attachments: true, selectedGeneration: true } },
      tasks: true,
      attachments: true,
      exportRuns: { orderBy: { createdAt: "desc" } },
      session: { select: { id: true, code: true, date: true, semesterNumber: true } },
      rangeStartSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
      rangeEndSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
      class: { select: { id: true, code: true, name: true } },
      semester: { select: { id: true, name: true } },
    },
  });
  if (!plan) return null;
  await assertFeedbackPlanAvailable(id, db);
  const checked = await validateFeedbackPlanAttachments(id, db);
  if (checked.some((entry) => plan.attachments.some((attachment) => attachment.id === entry.id && attachment.status !== entry.status))) {
    return db.feedbackPlan.findUnique({
      where: { id },
      include: { items: { include: { student: { include: { communicationPreference: true, communicationPreferenceCandidates: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } } }, tasks: true, attachments: true, selectedGeneration: true } }, tasks: true, attachments: true, exportRuns: { orderBy: { createdAt: "desc" } }, session: { select: { id: true, code: true, date: true, semesterNumber: true } }, rangeStartSession: { select: { id: true, code: true, date: true, semesterNumber: true } }, rangeEndSession: { select: { id: true, code: true, date: true, semesterNumber: true } }, class: { select: { id: true, code: true, name: true } }, semester: { select: { id: true, name: true } } },
    });
  }
  return plan;
}

export async function listFeedbackPlans(input: {
  classId?: string;
  semesterId?: string;
  sessionId?: string;
  studentId?: string;
  date?: string;
  status?: string;
  archived?: boolean;
  type?: string;
}, db: PrismaClient = prisma) {
  const relationFilters = [
    ...(input.sessionId ? [{ OR: [
      { type: { in: ["stage_trend", "course_end"] }, rangeEndSessionId: input.sessionId },
      { type: { notIn: ["stage_trend", "course_end"] }, sessionId: input.sessionId },
    ] }] : []),
    ...(input.date ? [{ OR: [
      { type: { in: ["stage_trend", "course_end"] }, rangeEndSession: { is: { date: input.date } } },
      { type: { notIn: ["stage_trend", "course_end"] }, session: { is: { date: input.date } } },
    ] }] : []),
  ];
  const plans = await db.feedbackPlan.findMany({
    where: {
      semester: { deletedAt: null },
      class: { deletedAt: null },
      OR: [
        { batchId: null },
        { batch: { is: { plans: { none: { class: { deletedAt: { not: null } } } } } } },
      ],
      ...(input.classId ? { classId: input.classId } : {}),
      ...(input.semesterId ? { semesterId: input.semesterId } : {}),
      ...(input.studentId ? { items: { some: { studentId: input.studentId } } } : {}),
      ...(relationFilters.length ? { AND: relationFilters } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.archived === true ? { archivedAt: { not: null } } : input.archived === false ? { archivedAt: null } : {}),
      ...(input.type ? { type: input.type } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: {
      session: { select: { id: true, code: true, date: true, semesterNumber: true } },
      rangeEndSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
      class: { select: { id: true, code: true, name: true } },
      semester: { select: { id: true, name: true } },
      items: { select: { id: true, studentId: true, status: true, finalTextHash: true, updatedAt: true, student: { select: { id: true, name: true, studentId: true } } } },
    },
  });
  return plans.map((plan) => ({
    ...plan,
    generationApproach: normalizeStoredFeedbackGenerationApproach(plan.generationApproach) === "legacy"
      ? null
      : normalizeStoredFeedbackGenerationApproach(plan.generationApproach),
    generationApproachLabel: feedbackGenerationApproachLabel(plan.generationApproach),
    legacyReadonly: plan.generationApproach === "legacy",
    itemStatusCounts: generationProgress(plan.items),
    actionBucket: feedbackPlanActionBucket(plan.status, generationProgress(plan.items)),
    studentSummaries: plan.items.filter((item) => item.student).map((item) => ({ id: item.student!.id, name: item.student!.name, studentId: item.student!.studentId })),
  }));
}

type StoredFeedbackPlanDraft = {
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

function feedbackPlanSnapshotV2(plan: StoredFeedbackPlanDraft) {
  const parsed = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
  if (parsed.success && parsed.data.version === 2) return parsed.data;
  const legacy = parsed.success ? parsed.data : null;
  const factItems = plan.items.flatMap((item) => {
    const evidence = FeedbackEvidenceBundleSchema.safeParse(parseJson(item.evidenceSnapshot, null));
    if (!evidence.success) return [];
    const communicationPreference = item.student?.communicationPreference
      ? CommunicationPreferenceSchema.safeParse(parseJson(item.student.communicationPreference.preferenceSnapshot, null))
      : null;
    return [{
      studentId: item.studentId,
      ...(item.student ? { studentName: item.student.name, studentNumber: item.student.studentId } : {}),
      ...(communicationPreference?.success ? { communicationPreference: communicationPreference.data } : {}),
      ...(plan.rangeEndSession?.date || plan.session?.date
        ? { referenceDate: plan.rangeEndSession?.date ?? plan.session?.date }
        : {}),
      evidence: evidence.data,
    }];
  });
  const studentOverrides = plan.items.flatMap((item) => {
    if (!item.studentId) return [];
    const generationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
    return generationConfig ? [{ studentId: item.studentId, generationConfig }] : [];
  });
  return FeedbackPlanInputSnapshotV2Schema.parse({
    version: 2,
    semesterId: legacy?.semesterId ?? plan.semesterId,
    classId: legacy?.classId ?? plan.classId,
    sessionId: legacy?.sessionId ?? plan.sessionId ?? undefined,
    rangeStartSessionId: legacy?.rangeStartSessionId ?? plan.rangeStartSessionId ?? undefined,
    rangeEndSessionId: legacy?.rangeEndSessionId ?? plan.rangeEndSessionId ?? undefined,
    sessionCode: legacy?.sessionCode ?? plan.session?.code,
    sourceFingerprint: legacy?.sourceFingerprint ?? plan.inputFingerprint,
    lessonMaterial: legacy?.lessonMaterial ?? defaultLessonMaterial(),
    generationPreferences: legacy?.generationPreferences,
    selectedStudentIds: plan.items.flatMap((item) => item.studentId ? [item.studentId] : []),
    studentOverrides,
    factSnapshot: { capturedAt: plan.createdAt.toISOString(), items: factItems },
    intakeSources: [],
  });
}

async function storedFeedbackPlanDraft(id: string, db: FeedbackPlanDb) {
  await assertFeedbackPlanAvailable(id, db);
  return db.feedbackPlan.findUnique({
    where: { id },
    select: {
      id: true,
      displayName: true,
      basedOnPlanId: true,
      type: true,
      outputRequirement: true,
      status: true,
      semesterId: true,
      classId: true,
      sessionId: true,
      rangeStartSessionId: true,
      rangeEndSessionId: true,
      inputFingerprint: true,
      inputSnapshot: true,
      generationMode: true,
      generationApproach: true,
      generationStartedAt: true,
      generationCompletedAt: true,
      planRevision: true,
      archivedAt: true,
      createdAt: true,
      batchId: true,
      batch: { select: { status: true, archivedAt: true } },
      session: { select: { code: true, date: true } },
      rangeEndSession: { select: { date: true } },
      items: {
        select: {
          id: true,
          studentId: true,
          status: true,
          evidenceSnapshot: true,
          generationConfigSnapshot: true,
          finalText: true,
          selectedGenerationId: true,
          approvedAt: true,
          exportedAt: true,
          student: {
            select: {
              name: true,
              studentId: true,
              communicationPreference: { select: { preferenceSnapshot: true } },
            },
          },
        },
      },
    },
  });
}

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

function assertMutableFeedbackPlanDraft(
  plan: StoredFeedbackPlanDraft,
  expectedPlanRevision: number,
  allowBatchDraftUpdate: boolean,
) {
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (plan.batchId && !allowBatchDraftUpdate) {
    throw new ApiError("班级组子计划不能单独修改，请从班级组规划统一保存", 409, "conflict", false);
  }
  if (plan.batch && (plan.batch.archivedAt || !["draft", "ready"].includes(plan.batch.status))) {
    throw new ApiError("班级组已经启动生成，计划内容已冻结；请建立修正计划", 409, "conflict", false);
  }
  if (feedbackPlanHasGenerationTrace(plan)) {
    throw new ApiError("已经启动生成的计划内容已冻结，请建立修正计划", 409, "conflict", false);
  }
  if (expectedPlanRevision !== plan.planRevision) {
    throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
  }
}

export async function updateFeedbackPlanDraft(
  id: string,
  rawPatch: FeedbackPlanDraftPatch,
  db: FeedbackPlanDb = prisma,
  options: { allowBatchDraftUpdate?: boolean } = {},
) {
  const patch = FeedbackPlanDraftPatchSchema.parse(rawPatch);
  const execute = async (tx: FeedbackPlanDb) => {
    const plan = await storedFeedbackPlanDraft(id, tx);
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
    assertMutableFeedbackPlanDraft(plan, patch.expectedPlanRevision, options.allowBatchDraftUpdate === true);
    const snapshot = feedbackPlanSnapshotV2(plan);
    const nextType = patch.type ?? plan.type as FeedbackPlanCreateInput["type"];
    const sourceWasClassPlan = snapshot.factSnapshot.items.some((item) => item.studentId === null);
    const targetIsClassPlan = nextType === "class_update";
    if (sourceWasClassPlan !== targetIsClassPlan) {
      throw new ApiError("班级公共反馈与学生反馈不能在同一草稿内互相转换，请新建计划", 409, "conflict", false);
    }
    let generationPreferences: FeedbackGenerationPreferences;
    try {
      generationPreferences = normalizeFeedbackGenerationPreferences(nextType, patch.generationPreferences ?? snapshot.generationPreferences);
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : "生成结构设置无效", 400, "invalid_request", false);
    }
    const factByStudent = new Map(snapshot.factSnapshot.items.map((item) => [item.studentId, item.evidence]));
    const currentStudentIds = plan.items.flatMap((item) => item.studentId ? [item.studentId] : []);
    const selectedIds: Array<string | null> = targetIsClassPlan
      ? [null]
      : [...new Set(patch.studentIds ?? currentStudentIds)];
    const unknownStudent = selectedIds.find((studentId) => !factByStudent.has(studentId));
    if (unknownStudent !== undefined) {
      throw new ApiError("所选学生不在该计划冻结的事实范围内，请按当前事实新建计划", 409, "conflict", false);
    }
    if (!selectedIds.length) throw new ApiError("至少选择一名反馈对象", 400, "invalid_request", false);
    const currentOverrides = plan.items.flatMap((item) => {
      if (!item.studentId) return [];
      const generationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
      return generationConfig ? [{ studentId: item.studentId, generationConfig }] : [];
    });
    const selectedStudentIdSet = new Set(selectedIds.flatMap((studentId) => studentId ? [studentId] : []));
    const studentOverridesById = normalizedStudentOverrides({
      overrides: patch.studentOverrides ?? currentOverrides.filter((override) => selectedStudentIdSet.has(override.studentId)),
      selectedIds,
      contextStudentIds: new Set(snapshot.factSnapshot.items.flatMap((item) => item.studentId ? [item.studentId] : [])),
    });
    const nextDisplayName = patch.displayName
      ? await allocateFeedbackPlanDisplayName(tx, plan, patch.displayName, plan.id)
      : plan.displayName;
    const nextOutputRequirement = patch.outputRequirement ?? plan.outputRequirement;
    const nextGenerationApproach = patch.generationApproach
      ?? normalizeStoredFeedbackGenerationApproach(plan.generationApproach);
    const nextFingerprint = feedbackPlanDraftFingerprint({
      snapshot,
      type: nextType,
      outputRequirement: nextOutputRequirement,
      generationApproach: nextGenerationApproach,
      generationPreferences,
      selectedStudentIds: selectedIds,
      studentOverrides: studentOverridesById,
    });
    const nextSnapshot = FeedbackPlanInputSnapshotV2Schema.parse({
      ...snapshot,
      generationPreferences,
      selectedStudentIds: selectedIds.flatMap((studentId) => studentId ? [studentId] : []),
      studentOverrides: [...studentOverridesById.entries()].map(([studentId, generationConfig]) => ({ studentId, generationConfig })),
    });
    const planData = {
      displayName: nextDisplayName,
      type: nextType,
      outputRequirement: nextOutputRequirement,
      generationApproach: nextGenerationApproach,
      inputFingerprint: nextFingerprint,
      inputSnapshot: json(nextSnapshot),
      status: "draft",
      planRevision: { increment: 1 },
    };
    const saved = await tx.feedbackPlan.updateMany({
      where: {
        id: plan.id,
        planRevision: patch.expectedPlanRevision,
        generationStartedAt: null,
        archivedAt: null,
      },
      data: planData,
    });
    if (!saved.count) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
    const selectedKeys = new Set(selectedIds.map((studentId) => studentId ?? "__class__"));
    const existingByKey = new Map(plan.items.map((item) => [item.studentId ?? "__class__", item]));
    await tx.feedbackPlanItem.deleteMany({
      where: {
        planId: plan.id,
        id: { in: plan.items.filter((item) => !selectedKeys.has(item.studentId ?? "__class__")).map((item) => item.id) },
      },
    });
    for (const studentId of selectedIds) {
      const generationConfigSnapshot = studentId && studentOverridesById.has(studentId)
        ? json(studentOverridesById.get(studentId))
        : "{}";
      const existing = existingByKey.get(studentId ?? "__class__");
      if (existing) {
        if (existing.generationConfigSnapshot !== generationConfigSnapshot) {
          await tx.feedbackPlanItem.update({
            where: { id: existing.id },
            data: { generationConfigSnapshot, itemRevision: { increment: 1 } },
          });
        }
      } else {
        await tx.feedbackPlanItem.create({
          data: {
            planId: plan.id,
            studentId,
            evidenceSnapshot: json(factByStudent.get(studentId)),
            generationConfigSnapshot,
          },
        });
      }
    }
    return plan.id;
  };
  const planId = "$transaction" in db
    ? await (db as PrismaClient).$transaction((tx) => execute(tx))
    : await execute(db);
  const updated = await getFeedbackPlan(planId, db);
  if (!updated) throw new Error("反馈计划草稿保存后无法读取");
  return updated;
}

export async function renameFeedbackPlan(
  id: string,
  rawInput: FeedbackPlanRenameInput,
  db: FeedbackPlanDb = prisma,
) {
  const input = FeedbackPlanRenameSchema.parse(rawInput);
  const plan = await storedFeedbackPlanDraft(id, db);
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组计划只保留批次名称，请从班级组计划重命名", 409, "conflict", false);
  if (input.expectedPlanRevision && input.expectedPlanRevision !== plan.planRevision) {
    throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
  }
  const displayName = await allocateFeedbackPlanDisplayName(db, plan, input.displayName, plan.id);
  if (input.expectedPlanRevision) {
    const renamed = await db.feedbackPlan.updateMany({
      where: { id, planRevision: input.expectedPlanRevision },
      data: { displayName, planRevision: { increment: 1 } },
    });
    if (!renamed.count) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
  } else {
    await db.feedbackPlan.update({ where: { id }, data: { displayName, planRevision: { increment: 1 } } });
  }
  const updated = await getFeedbackPlan(id, db);
  if (!updated) throw new Error("反馈计划重命名后无法读取");
  return updated;
}

export async function cloneFeedbackPlanDraft(
  rawInput: FeedbackPlanCloneDraftInput & { planId: string },
  db: FeedbackPlanDb = prisma,
  options: { allowBatchClone?: boolean } = {},
) {
  const input = { planId: rawInput.planId, ...FeedbackPlanCloneDraftSchema.parse(rawInput) };
  const execute = async (tx: FeedbackPlanDb) => {
    const source = await storedFeedbackPlanDraft(input.planId, tx);
    if (!source) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    if (source.batchId && !options.allowBatchClone) {
      throw new ApiError("班级组子计划不能单独修正，请从班级组计划建立修正计划", 409, "conflict", false);
    }
    const snapshot = feedbackPlanSnapshotV2(source);
    if (source.generationApproach === "legacy" && input.generationApproach === undefined) {
      throw new ApiError("旧生成方式计划另存为时必须选择受限反馈或自由反馈", 409, "conflict", false);
    }
    const generationApproach = feedbackGenerationApproachForDerivedPlan(
      source.generationApproach,
      input.generationApproach,
    );
    const selectedStudentIds = source.items.flatMap((item) => item.studentId ? [item.studentId] : []);
    const studentOverrides = new Map(source.items.flatMap((item) => {
      if (!item.studentId) return [];
      const generationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
      return generationConfig ? [[item.studentId, generationConfig] as const] : [];
    }));
    const inputFingerprint = feedbackPlanDraftFingerprint({
      snapshot,
      type: source.type as FeedbackPlanCreateInput["type"],
      outputRequirement: source.outputRequirement,
      generationApproach,
      generationPreferences: normalizeFeedbackGenerationPreferences(source.type as FeedbackPlanCreateInput["type"], snapshot.generationPreferences),
      selectedStudentIds: source.type === "class_update" ? [null] : selectedStudentIds,
      studentOverrides,
    });
    const displayName = input.displayName
      ? await allocateFeedbackPlanDisplayName(tx, source, input.displayName)
      : null;
    const clone = await tx.feedbackPlan.create({
      data: {
        displayName,
        basedOnPlanId: source.id,
        type: source.type,
        outputRequirement: source.outputRequirement,
        status: "draft",
        semesterId: source.semesterId,
        classId: source.classId,
        sessionId: source.sessionId,
        rangeStartSessionId: source.rangeStartSessionId,
        rangeEndSessionId: source.rangeEndSessionId,
        inputFingerprint,
        inputSnapshot: json({
          ...snapshot,
          draftRequestKey: undefined,
          selectedStudentIds,
          studentOverrides: [...studentOverrides.entries()].map(([studentId, generationConfig]) => ({ studentId, generationConfig })),
        }),
        generationApproach,
        items: {
          create: source.items.map((item) => ({
            studentId: item.studentId,
            evidenceSnapshot: item.evidenceSnapshot,
            generationConfigSnapshot: item.generationConfigSnapshot,
          })),
        },
      },
    });
    return clone.id;
  };
  const cloneId = "$transaction" in db
    ? await (db as PrismaClient).$transaction((tx) => execute(tx))
    : await execute(db);
  const clone = await getFeedbackPlan(cloneId, db);
  if (!clone) throw new Error("修正计划创建后无法读取");
  return clone;
}

/** Creates a named draft from the current page fields without mutating the source plan. */
export async function saveFeedbackPlanAs(
  input: { planId: string; displayName: string; patch: FeedbackPlanDraftPatch },
  db: PrismaClient = prisma,
) {
  await assertFeedbackPlanAvailable(input.planId, db);
  return db.$transaction(async (tx) => {
    const clone = await cloneFeedbackPlanDraft({
      planId: input.planId,
      displayName: input.displayName,
      generationApproach: input.patch.generationApproach,
    }, tx);
    const { expectedPlanRevision: _sourceRevision, ...fields } = input.patch;
    void _sourceRevision;
    return updateFeedbackPlanDraft(clone.id, {
      ...fields,
      displayName: input.displayName,
      expectedPlanRevision: clone.planRevision,
    }, tx);
  });
}

export async function patchFeedbackPlanItem(id: string, rawPatch: FeedbackPlanItemPatch, db: PrismaClient = prisma) {
  const patch = FeedbackPlanItemPatchSchema.parse(rawPatch);
  const item = await db.feedbackPlanItem.findUnique({ include: { plan: { include: { batch: { select: { status: true, archivedAt: true } }, items: { include: { student: true } } } }, student: true, tasks: true } , where: { id } });
  if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  if (item.plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (["approved", "exported"].includes(item.status)) throw new ApiError("已批准或已导出的反馈不可原位修改，请新建反馈计划", 409, "conflict", false);
  if (["queued", "generating", "pause_requested"].includes(item.status)) {
    throw new ApiError("反馈正在生成，请刷新计划后重试", 409, "conflict", false);
  }
  if (patch.expectedItemRevision && patch.expectedItemRevision !== item.itemRevision) throw new ApiError("反馈计划条目已被其他操作更新", 409, "conflict", false);
  if (Object.hasOwn(patch, "generationConfig")) {
    if (patch.composition || patch.finalText !== undefined || patch.reviewMode) {
      throw new ApiError("独立计划配置不能和正文修改合并提交", 400, "invalid_request", false);
    }
    if (item.plan.batchId) throw new ApiError("班级组子计划不能单独修改，请从班级组规划统一保存", 409, "conflict", false);
    if (feedbackPlanHasGenerationTrace(item.plan) || item.status !== "evidence_ready") {
      throw new ApiError("生成启动后不能原位更换计划配置，请建立修正计划", 409, "conflict", false);
    }
    const nextGenerationConfig = patch.generationConfig === null
      ? null
      : normalizeStudentGenerationConfig(patch.generationConfig);
    if (nextGenerationConfig && !item.studentId) {
      throw new ApiError("班级公共反馈条目不能设置学生独立计划", 400, "invalid_request", false);
    }
    const currentGenerationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
    if (JSON.stringify(currentGenerationConfig ?? {}) === JSON.stringify(nextGenerationConfig ?? {})) return item;
    return db.$transaction(async (tx) => {
      const lockedPlan = await tx.feedbackPlan.updateMany({
        where: {
          id: item.planId,
          archivedAt: null,
          generationStartedAt: null,
          planRevision: item.plan.planRevision,
        },
        data: {
          planRevision: { increment: 1 },
          status: "draft",
          approvedAt: null,
          exportedAt: null,
        },
      });
      if (lockedPlan.count !== 1) {
        throw new ApiError("反馈计划已经启动或被其他操作更新，请刷新后重试", 409, "conflict", false);
      }
      const updated = await tx.feedbackPlanItem.updateMany({
        where: { id, itemRevision: item.itemRevision, status: "evidence_ready" },
        data: {
          generationConfigSnapshot: json(nextGenerationConfig ?? {}),
          compositionSnapshot: "{}",
          auditSnapshot: "{}",
          finalText: null,
          finalTextHash: null,
          selectedGenerationId: null,
          generationError: null,
          reviewMode: "model",
          status: "evidence_ready",
          approvedAt: null,
          exportedAt: null,
          itemRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ApiError("反馈计划条目已被其他操作更新", 409, "conflict", false);
      }
      return tx.feedbackPlanItem.findUniqueOrThrow({ where: { id }, include: { tasks: true } });
    });
  }
  if (item.plan.batchId && item.status === "evidence_ready") {
    throw new ApiError("班级组尚未生成的条目不能单独写入正文，请先启动班级组生成", 409, "conflict", false);
  }
  const effectiveConfig = effectiveFeedbackPlanConfig(item.plan, item);
  const bundle = bundleForPlanConfig(FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {})), effectiveConfig);
  const composition = sanitizeFeedbackComposition(patch.composition ?? parseCompositionSnapshot(item.compositionSnapshot, effectiveConfig.type, patch.finalText ?? item.finalText ?? ""));
  const finalText = stripFeedbackInternalBoundary(patch.finalText ?? composition.draftFeedback);
  const normalizedFinalText = normalizedCoverageText(finalText);
  const evidenceCoverage = patch.finalText === undefined
    ? composition.evidenceCoverage
    : composition.evidenceCoverage.filter((coverage) => normalizedFinalText.includes(normalizedCoverageText(coverage.statement)));
  const nextComposition = FeedbackCompositionPlanSchema.parse({ ...composition, evidenceCoverage, draftFeedback: finalText });
  const taskIds = auditTaskIdsForBundle(bundle, item.tasks);
  const identity = auditIdentityForPlanItem(item.plan, item);
  const recalculatedAudit = createAuditSnapshot(
    nextComposition,
    bundle,
    taskIds,
    identity,
    { generationPreferences: effectiveConfig.generationPreferences },
  );
  const previousWriterBlocker = restrictedWriterBlockerFromAuditSnapshot(item.auditSnapshot);
  const finalTextChanged = patch.finalText !== undefined && sha256(finalText) !== item.finalTextHash;
  const audit = previousWriterBlocker && !finalTextChanged
    ? blockAuditForRestrictedWriter(recalculatedAudit, previousWriterBlocker.message)
    : recalculatedAudit;
  const reviewMode = previousWriterBlocker
    ? finalTextChanged ? "teacher_edited" : item.reviewMode
    : patch.reviewMode ?? (patch.finalText !== undefined ? "teacher_edited" : item.reviewMode);
  const status = audit.status === "blocked" ? "needs_review" : "needs_review";

  return db.feedbackPlanItem.update({
    where: { id },
    data: {
      compositionSnapshot: json(nextComposition),
      auditSnapshot: json(audit),
      finalText,
      finalTextHash: sha256(finalText),
      reviewMode,
      status,
      itemRevision: { increment: 1 },
      plan: { update: { planRevision: { increment: 1 }, status: "in_review", approvedAt: null, exportedAt: null } },
    },
    include: { tasks: true },
  });
}

/**
 * Keep already generated text after a teacher acknowledges a non-destructive
 * context change. This never calls the model or changes the evidence snapshot.
 */
export async function retainStaleFeedbackPlanItems(input: {
  planId: string;
  itemIds?: string[];
}, db: PrismaClient = prisma) {
  const planState = await db.feedbackPlan.findUnique({ where: { id: input.planId }, select: { id: true, archivedAt: true } });
  if (!planState) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (planState.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  const requestedIds = input.itemIds ? [...new Set(input.itemIds)] : undefined;
  const items = await db.feedbackPlanItem.findMany({
    where: {
      planId: input.planId,
      status: "stale",
      ...(requestedIds ? { id: { in: requestedIds } } : {}),
    },
    select: { id: true, finalText: true },
  });
  const retainedIds = items.filter((item) => Boolean(item.finalText?.trim())).map((item) => item.id);
  if (!retainedIds.length) throw new ApiError("没有可保留的已生成正文", 409, "conflict", false);
  await db.$transaction(async (tx) => {
    await tx.feedbackPlanItem.updateMany({
      where: { id: { in: retainedIds }, planId: input.planId, status: "stale" },
      data: { status: "needs_review", reviewMode: "teacher_edited", itemRevision: { increment: 1 } },
    });
    const planItems = await tx.feedbackPlanItem.findMany({ where: { planId: input.planId }, select: { status: true } });
    await tx.feedbackPlan.update({
      where: { id: input.planId },
      data: { status: derivePlanStatus(planItems), planRevision: { increment: 1 }, approvedAt: null, exportedAt: null },
    });
  });
  const plan = await getFeedbackPlan(input.planId, db);
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  return plan;
}

export async function createTeacherTask(input: {
  planItemId: string;
  action: string;
  dueType: "date" | "session";
  dueDate?: string;
  dueSessionId?: string;
  estimatedMinutes?: number;
  promiseExcerpt?: string;
}, db: PrismaClient = prisma) {
  const item = await db.feedbackPlanItem.findUnique({
    where: { id: input.planItemId },
    include: {
      plan: { include: { session: true, rangeEndSession: true, items: { include: { student: true } } } },
      student: true,
      tasks: true,
    },
  });
  if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  if (item.plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (item.status !== "needs_review") throw new ApiError("只有待教师审核的反馈才能批准未来任务", 409, "conflict", false);
  if (!input.action.trim()) throw new ApiError("教师任务不能为空", 400, "invalid_request", false);
  if (input.dueType === "date" && !input.dueDate) throw new ApiError("日期任务缺少截止日期", 400, "invalid_request", false);
  let resolvedDueSessionId = input.dueSessionId;
  if (input.dueType === "session" && !resolvedDueSessionId) {
    const anchor = item.plan.rangeEndSession ?? item.plan.session;
    if (!anchor) throw new ApiError("没有可推断的后续课次，请选择日期或课次", 400, "invalid_request", false);
    const nextSession = await db.classSession.findFirst({
      where: {
        classId: item.plan.classId,
        semesterId: item.plan.semesterId,
        OR: [{ date: { gt: anchor.date } }, { date: anchor.date, semesterNumber: { gt: anchor.semesterNumber } }],
      },
      orderBy: [{ date: "asc" }, { semesterNumber: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    resolvedDueSessionId = nextSession?.id;
  }
  if (input.dueType === "session" && !resolvedDueSessionId) throw new ApiError("没有下一节同班课次，请选择日期或课次", 400, "invalid_request", false);
  if (input.dueType === "session" && resolvedDueSessionId) {
    const dueSession = await db.classSession.findFirst({ where: { id: resolvedDueSessionId, classId: item.plan.classId, semesterId: item.plan.semesterId }, select: { id: true, date: true, semesterNumber: true } });
    if (!dueSession) throw new ApiError("截止课次必须属于同一班级和学期", 400, "invalid_request", false);
    const anchor = item.plan.rangeEndSession ?? item.plan.session;
    if (anchor && (dueSession.date < anchor.date || (dueSession.date === anchor.date && dueSession.semesterNumber <= anchor.semesterNumber))) {
      throw new ApiError("教师任务截止课次必须晚于反馈计划课次", 400, "invalid_request", false);
    }
  }
  return db.$transaction(async (tx) => {
    const currentItem = await tx.feedbackPlanItem.findUnique({ where: { id: item.id }, select: { status: true, itemRevision: true } });
    if (!currentItem || currentItem.status !== "needs_review" || currentItem.itemRevision !== item.itemRevision) {
      throw new ApiError("反馈条目已被其他操作更新，请刷新后再批准教师任务", 409, "conflict", false);
    }
    const task = await tx.teacherTask.create({
      data: {
        planId: item.planId,
        planItemId: item.id,
        studentId: item.studentId,
        classId: item.plan.classId,
        action: input.action.trim(),
        promiseExcerpt: input.promiseExcerpt?.trim() || null,
        dueType: input.dueType,
        dueDate: input.dueDate ?? null,
        dueSessionId: resolvedDueSessionId ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
        sourceHash: item.finalTextHash,
        approvedAt: new Date(),
      },
    });
    const effectiveConfig = effectiveFeedbackPlanConfig(item.plan, item);
    const bundle = bundleForPlanConfig(FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {})), effectiveConfig);
    const composition = parseCompositionSnapshot(item.compositionSnapshot, effectiveConfig.type, item.finalText ?? "");
    const taskIds = auditTaskIdsForBundle(bundle, item.tasks);
    taskIds.add(task.id);
    const baseAudit = createAuditSnapshot(
      composition,
      bundle,
      taskIds,
      auditIdentityForPlanItem(item.plan, item),
      { generationPreferences: effectiveConfig.generationPreferences },
    );
    const previousWriterBlocker = restrictedWriterBlockerFromAuditSnapshot(item.auditSnapshot);
    const audit = previousWriterBlocker
      ? blockAuditForRestrictedWriter(baseAudit, previousWriterBlocker.message)
      : baseAudit;
    await tx.feedbackPlanItem.update({
      where: { id: item.id },
      data: { auditSnapshot: json(audit), status: audit.status === "blocked" ? "needs_review" : "needs_review", itemRevision: { increment: 1 } },
    });
    return task;
  });
}

export async function approveFeedbackPlanItems(input: { planId: string; itemIds?: string[]; expectedHashes?: Record<string, string> }, db: PrismaClient = prisma) {
  const approved = await db.$transaction(async (tx) => {
    const plan = await tx.feedbackPlan.findUnique({ where: { id: input.planId }, include: { items: { include: { tasks: true, student: true } } } });
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
    const itemIds = input.itemIds ? new Set(input.itemIds) : new Set(plan.items.map((item) => item.id));
    const selected = plan.items.filter((item) => itemIds.has(item.id));
    if (!selected.length) throw new ApiError("没有要批准的反馈条目", 400, "invalid_request", false);
    const failures: string[] = [];
    for (const item of selected) {
      const itemLabel = item.student?.name ?? "班级公共反馈";
      if (item.status === "stale" || item.status === "generating") {
        failures.push(`${itemLabel}：当前状态为${item.status}，请先完成生成或重新组装`);
        continue;
      }
      const expected = input.expectedHashes?.[item.id];
      if (!expected || expected !== item.finalTextHash) {
        failures.push(`${itemLabel}：文本已变化，请重新检查`);
        continue;
      }
      const audit = parseJson(item.auditSnapshot, null as ReturnType<typeof createAuditSnapshot> | null);
      const effectiveConfig = effectiveFeedbackPlanConfig(plan, item);
      const bundle = bundleForPlanConfig(FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {})), effectiveConfig);
      const composition = parseCompositionSnapshot(item.compositionSnapshot, effectiveConfig.type, item.finalText ?? "");
      const recalculatedAudit = createAuditSnapshot(
        composition,
        bundle,
        auditTaskIdsForBundle(bundle, item.tasks),
        auditIdentityForPlanItem(plan, item),
        { generationPreferences: effectiveConfig.generationPreferences },
      );
      const savedWriterBlockers = Array.isArray(audit?.items)
        ? audit.items.filter((issue) => issue.code === RESTRICTED_WRITER_OUTPUT_INVALID_CODE)
        : [];
      const hardBlocked = [
        ...recalculatedAudit.items.filter((issue) => isHardFeedbackAuditIssue(issue.code)),
        ...savedWriterBlockers,
      ];
      if (!item.finalText?.trim() || !item.finalTextHash || !audit || audit.textHash !== item.finalTextHash || recalculatedAudit.textHash !== item.finalTextHash || hardBlocked.length > 0) {
        const blocked = hardBlocked
          .map((issue) => issue.message);
        failures.push(`${itemLabel}：${blocked.join("、") || "未通过文本哈希或程序门禁"}`);
      }
    }
    if (failures.length) {
      throw new ApiError(`以下条目暂不能批准：${failures.join("；")}`, 409, "conflict", false, { failures });
    }
    await Promise.all(selected.map((item) => tx.feedbackPlanItem.update({
      where: { id: item.id },
      data: { status: "approved", approvedAt: new Date() },
    })));
    const nextItems = plan.items.map((item) => itemIds.has(item.id) ? { status: "approved" } : item);
    const status = derivePlanStatus(nextItems);
    const allApproved = nextItems.every((item) => item.status === "approved" || item.status === "exported");
    return tx.feedbackPlan.update({ where: { id: plan.id }, data: { status, approvedAt: allApproved ? new Date() : null }, include: { items: true } });
  });
  const detail = await getFeedbackPlan(approved.id, db);
  if (!detail) throw new Error("反馈计划批准后无法读取");
  return detail;
}

export async function updateTeacherTaskStatus(id: string, status: "pending" | "completed" | "cancelled", db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const existing = await tx.teacherTask.findUnique({ where: { id }, select: { planId: true } });
    if (!existing) throw new ApiError("教师任务不存在", 404, "not_found", false);
    await assertFeedbackPlanAvailable(existing.planId, tx);
    const task = await tx.teacherTask.update({
      where: { id },
      data: { status, completedAt: status === "completed" ? new Date() : null },
      include: {
        planItem: {
          include: {
            tasks: true,
            student: true,
            plan: { include: { items: { include: { student: true } } } },
          },
        },
      },
    });
    const item = task.planItem;
    if (item && ["evidence_ready", "needs_review"].includes(item.status)) {
      const effectiveConfig = effectiveFeedbackPlanConfig(item.plan, item);
      const bundle = bundleForPlanConfig(FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {})), effectiveConfig);
      const composition = parseCompositionSnapshot(item.compositionSnapshot, effectiveConfig.type, item.finalText ?? "");
      const currentTasks = item.tasks.map((entry) => entry.id === task.id ? { ...entry, status } : entry);
      const baseAudit = createAuditSnapshot(
        composition,
        bundle,
        auditTaskIdsForBundle(bundle, currentTasks),
        auditIdentityForPlanItem(item.plan, item),
        { generationPreferences: effectiveConfig.generationPreferences },
      );
      const previousWriterBlocker = restrictedWriterBlockerFromAuditSnapshot(item.auditSnapshot);
      const audit = previousWriterBlocker
        ? blockAuditForRestrictedWriter(baseAudit, previousWriterBlocker.message)
        : baseAudit;
      await tx.feedbackPlanItem.update({
        where: { id: item.id },
        data: { auditSnapshot: json(audit), status: "needs_review", itemRevision: { increment: 1 } },
      });
      const planItems = await tx.feedbackPlanItem.findMany({ where: { planId: item.planId }, select: { status: true } });
      await tx.feedbackPlan.update({ where: { id: item.planId }, data: { status: derivePlanStatus(planItems), planRevision: { increment: 1 } } });
    }
    return task;
  });
}

/**
 * Mark only mutable feedback-plan revisions stale after confirmed source changes.
 * Approved/exported history is immutable; a later generation gets a new revision.
 */
export async function invalidateFeedbackPlans(input: {
  classId?: string;
  semesterId?: string;
  sessionId?: string;
  studentIds?: string[];
}, db: FeedbackPlanDb = prisma) {
  const studentIds = [...new Set(input.studentIds ?? [])];
  const targetSession = input.sessionId
    ? await db.classSession.findUnique({ where: { id: input.sessionId }, select: { id: true, classId: true, semesterId: true, date: true, semesterNumber: true } })
    : null;
  const classId = input.classId ?? targetSession?.classId ?? undefined;
  const semesterId = input.semesterId ?? targetSession?.semesterId ?? undefined;
  const plans = await db.feedbackPlan.findMany({
    where: {
      archivedAt: null,
      generationStartedAt: null,
      ...(classId ? { classId } : {}),
      ...(semesterId ? { semesterId } : {}),
      items: { some: { status: { in: ["evidence_ready", "generating", "needs_review"] } } },
    },
    select: {
      id: true,
      status: true,
      inputSnapshot: true,
      sessionId: true,
      rangeStartSessionId: true,
      rangeEndSessionId: true,
      generationStartedAt: true,
      generationCompletedAt: true,
      session: { select: { date: true, semesterNumber: true } },
      rangeStartSession: { select: { date: true, semesterNumber: true } },
      rangeEndSession: { select: { date: true, semesterNumber: true } },
      items: {
        select: {
          id: true,
          studentId: true,
          status: true,
          finalText: true,
          selectedGenerationId: true,
          approvedAt: true,
          exportedAt: true,
        },
      },
    },
  });
  const position = (session: { date: string; semesterNumber: number } | null | undefined) => session
    ? `${session.date}|${String(session.semesterNumber).padStart(6, "0")}`
    : null;
  const targetPosition = targetSession ? position(targetSession) : null;
  const matchingPlanIds = new Set(plans.filter((plan) => {
    if (feedbackPlanHasGenerationTrace(plan)) return false;
    const snapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
    // V2 plans own a durable fact snapshot from the moment they are created.
    // New facts must create another named plan instead of silently rebasing it.
    if (snapshot.success && snapshot.data.version === 2) return false;
    if (!input.sessionId) return true;
    if (plan.sessionId === input.sessionId) return true;
    if (!targetPosition) return false;
    const start = position(plan.rangeStartSession);
    const end = position(plan.rangeEndSession);
    return Boolean(start && end && targetPosition >= start && targetPosition <= end);
  }).map((plan) => plan.id));
  const itemIds = plans.flatMap((plan) => matchingPlanIds.has(plan.id)
    ? plan.items.filter((item) => (
      ["evidence_ready", "generating", "needs_review"].includes(item.status)
      && (studentIds.length > 0
        ? Boolean(item.studentId && studentIds.includes(item.studentId)) || Boolean(input.sessionId && item.studentId === null)
        : true)
    )).map((item) => item.id)
    : []);
  if (itemIds.length === 0) return 0;
  const updated = await db.feedbackPlanItem.updateMany({ where: { id: { in: itemIds } }, data: { status: "stale" } });
  if (updated.count > 0) {
    await db.feedbackPlan.updateMany({ where: { id: { in: [...matchingPlanIds] } }, data: { status: "stale" } });
  }
  return updated.count;
}

export async function listTeacherTasks(input: { semesterId?: string; classId?: string; status?: string }, db: PrismaClient = prisma) {
  const planWhere: Prisma.FeedbackPlanWhereInput = {
    ...(input.semesterId ? { semesterId: input.semesterId } : {}),
    semester: { deletedAt: null },
    class: { deletedAt: null },
    OR: [
      { batchId: null },
      { batch: { plans: { none: { class: { deletedAt: { not: null } } } } } },
    ],
  };
  const baseWhere: Prisma.TeacherTaskWhereInput = {
    ...(input.classId ? { classId: input.classId } : {}),
    class: { deletedAt: null, semester: { deletedAt: null } },
    plan: planWhere,
  };
  const include = {
    student: { select: { id: true, name: true } },
    dueSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
    plan: { select: { id: true, type: true, outputRequirement: true } },
  } as const;

  if (input.status) {
    return db.teacherTask.findMany({
      where: { ...baseWhere, status: input.status },
      include,
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      ...(input.status === "pending" ? {} : { take: 200 }),
    });
  }

  // Pending work is the dashboard's actionable surface and must not be pushed
  // out by an old history tail. Keep history bounded independently.
  const [pending, history] = await Promise.all([
    db.teacherTask.findMany({
      where: { ...baseWhere, status: "pending" },
      include,
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    }),
    db.teacherTask.findMany({
      where: { ...baseWhere, status: { not: "pending" } },
      include,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
  ]);
  return [...pending, ...history];
}

function feedbackAttachmentRoot() {
  return path.resolve(resolveStudentTrackRuntimePath(
    "feedback-attachments",
    "STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT",
    path.join(os.homedir(), "Library", "Application Support", "Student Track", "feedback-attachments"),
  ));
}

/** Removes only the controlled per-plan attachment directories after their database rows are purged. */
export async function purgeFeedbackAttachmentDirectories(planIds: string[]) {
  const root = feedbackAttachmentRoot();
  for (const planId of [...new Set(planIds)]) {
    const directory = path.resolve(root, planId);
    const relative = path.relative(root, directory);
    if (relative !== planId || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("反馈计划附件目录无效");
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function safeAttachmentName(name: string) {
  const base = path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 160);
  return base || "attachment";
}

function attachmentDestination(planId: string, relativeLocator: string) {
  const prefix = `${path.posix.join("feedback-attachments", planId)}/`;
  if (!relativeLocator.startsWith(prefix)) throw new Error("附件定位符不在受控目录内");
  const filePart = relativeLocator.slice(prefix.length);
  if (!filePart || filePart.includes("..") || path.posix.isAbsolute(filePart)) throw new Error("附件定位符无效");
  const root = feedbackAttachmentRoot();
  const destination = path.resolve(root, planId, ...filePart.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("附件路径越界");
  return destination;
}

export async function validateFeedbackPlanAttachments(planId: string, db: FeedbackPlanDb = prisma) {
  const attachments = await db.feedbackAttachment.findMany({ where: { planId } });
  const result: Array<{ id: string; status: "available" | "missing" }> = [];
  for (const attachment of attachments) {
    let status: "available" | "missing" = "available";
    try {
      const destination = attachmentDestination(planId, attachment.relativeLocator);
      const bytes = await fs.readFile(destination);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== attachment.sizeBytes || hash !== attachment.sha256) status = "missing";
    } catch {
      status = "missing";
    }
    if (attachment.status !== status) await db.feedbackAttachment.update({ where: { id: attachment.id }, data: { status } });
    result.push({ id: attachment.id, status });
  }
  return result;
}

export async function addFeedbackAttachment(input: {
  planId: string;
  planItemId?: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}, db: PrismaClient = prisma) {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > 25 * 1024 * 1024) throw new ApiError("附件大小必须在 1B 到 25MB 之间", 400, "invalid_request", false);
  await assertFeedbackPlanAvailable(input.planId, db);
  const plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, select: { id: true, archivedAt: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (input.planItemId) {
    const item = await db.feedbackPlanItem.findFirst({ where: { id: input.planItemId, planId: input.planId }, select: { id: true } });
    if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  }
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const fileName = `${randomUUID()}-${safeAttachmentName(input.fileName)}`;
  const relativeLocator = path.posix.join("feedback-attachments", input.planId, fileName);
  const destination = path.join(feedbackAttachmentRoot(), input.planId, fileName);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, input.bytes, { mode: 0o600 });
  try {
    return await db.feedbackAttachment.create({
      data: {
        planId: input.planId,
        planItemId: input.planItemId,
        displayName: input.fileName.trim().slice(0, 200) || "attachment",
        mimeType: input.mimeType.trim().slice(0, 200) || "application/octet-stream",
        sizeBytes: input.bytes.byteLength,
        sha256: hash,
        relativeLocator,
      },
    });
  } catch (error) {
    await fs.unlink(destination).catch(() => undefined);
    throw error;
  }
}

export async function removeFeedbackAttachment(input: { planId: string; attachmentId: string }, db: PrismaClient = prisma) {
  await assertFeedbackPlanAvailable(input.planId, db);
  const plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, select: { id: true, archivedAt: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  const attachment = await db.feedbackAttachment.findFirst({ where: { id: input.attachmentId, planId: input.planId } });
  if (!attachment) throw new ApiError("反馈附件不存在", 404, "not_found", false);
  const destination = attachmentDestination(input.planId, attachment.relativeLocator);
  const quarantine = `${destination}.delete-${randomUUID()}`;
  let moved = false;
  try {
    await fs.rename(destination, quarantine);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await db.feedbackAttachment.delete({ where: { id: attachment.id } });
    if (moved) await fs.unlink(quarantine).catch(() => undefined);
    return { id: attachment.id, deleted: true };
  } catch (error) {
    if (moved) await fs.rename(quarantine, destination).catch(() => undefined);
    throw error;
  }
}

export async function deleteFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({ where: { id }, select: { id: true, batchId: true, status: true, approvedAt: true, exportedAt: true, exportRuns: { select: { id: true }, take: 1 }, attachments: { select: { relativeLocator: true } }, items: { select: { status: true, finalText: true, selectedGenerationId: true, approvedAt: true, exportedAt: true, generations: { select: { id: true }, take: 1 }, attachments: { select: { id: true } } } } } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组子计划不能单独删除，请从班级组计划操作", 409, "conflict", false);
  const hasGenerationOrApproval = plan.approvedAt || plan.exportedAt || plan.exportRuns.length > 0 || plan.items.some((item) => (
    Boolean(item.selectedGenerationId)
    || Boolean(item.approvedAt)
    || Boolean(item.exportedAt)
    || item.generations.length > 0
    || Boolean(item.finalText?.trim())
    || ["generating", "queued", "generation_failed", "needs_review", "approved", "exported"].includes(item.status)
    || item.attachments.length > 0
  ));
  if (hasGenerationOrApproval) {
    throw new ApiError("已有生成、审核、导出或附件的反馈计划只能归档，不能删除", 409, "conflict", false);
  }
  // Validate every persisted locator before moving anything. A corrupted row
  // must fail closed rather than allowing deletion to operate on an unknown
  // path, even though the normal plan directory is itself controlled.
  for (const attachment of plan.attachments) attachmentDestination(id, attachment.relativeLocator);
  const root = feedbackAttachmentRoot();
  const planDirectory = path.resolve(root, id);
  const relative = path.relative(root, planDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== id) throw new Error("反馈计划附件目录无效");
  const quarantineDirectory = path.resolve(root, `.deleted-${id}-${randomUUID()}`);
  let moved = false;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try { await fs.rename(planDirectory, quarantineDirectory); moved = true; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    await db.$transaction(async (tx) => {
      await tx.feedbackPlan.delete({ where: { id } });
    });
    if (moved) await fs.rm(quarantineDirectory, { recursive: true, force: true });
    return { id, deleted: true };
  } catch (error) {
    if (moved) await fs.rename(quarantineDirectory, planDirectory).catch(() => undefined);
    throw error;
  }
}

export async function archiveFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({ where: { id }, select: { id: true, batchId: true, status: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组子计划不能单独归档，请从班级组计划操作", 409, "conflict", false);
  if (["generating", "queued", "pause_requested"].includes(plan.status)) {
    throw new ApiError("生成中的反馈计划不能直接归档，请先暂停并等待进行中任务完成", 409, "conflict", false);
  }
  return db.feedbackPlan.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function unarchiveFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({ where: { id }, select: { id: true, batchId: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组子计划不能单独取消归档，请从班级组计划操作", 409, "conflict", false);
  return db.feedbackPlan.update({ where: { id }, data: { archivedAt: null } });
}

export async function generateFeedbackPlanItems(input: {
  planId: string;
  itemIds?: string[];
  assessmentEvidence?: FeedbackPlanAssessmentEvidenceInput;
  signal?: AbortSignal;
  preclaimed?: boolean;
  onProgress?: (event: { type: "status" | "item"; message?: string; itemId?: string; status?: string; error?: string }) => void | Promise<void>;
}, db: PrismaClient = prisma) {
  let plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, include: { items: { include: { student: true, tasks: true } } } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  let selected = input.itemIds
    ? plan.items.filter((item) => input.itemIds!.includes(item.id))
    : plan.items;
  if (!selected.length) throw new ApiError("没有要生成的反馈条目", 400, "invalid_request", false);
  const planInputSnapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
  const hasFrozenV2Input = planInputSnapshot.success && planInputSnapshot.data.version === 2;
  const hasReplacementEvidence = Object.keys(input.assessmentEvidence ?? {}).length > 0;
  if (feedbackPlanHasGenerationTrace(plan) && (hasReplacementEvidence || selected.some((item) => item.status === "stale"))) {
    throw new ApiError("已经启动的计划不能原位换用新事实；请保留旧正文或建立另一份计划", 409, "conflict", false);
  }
  if (hasFrozenV2Input && hasReplacementEvidence) {
    throw new ApiError("本计划的事实快照已经冻结；请按当前事实建立另一份计划", 409, "conflict", false);
  }
  const lessonMaterial = planInputSnapshot.success ? planInputSnapshot.data.lessonMaterial : undefined;
  const generationPreferences = generationPreferencesFromSnapshot(plan.type, plan.inputSnapshot);
  const immutable = selected.filter((item) => (
    feedbackPlanItemHasGeneratedResult(item)
    || (item.reviewMode === "teacher_edited" && item.status !== "stale")
  ));
  if (immutable.length) {
    throw new ApiError("已批准、已导出或教师已修改的反馈不能被批量覆盖；请批准当前文本，或新建计划保留历史版本", 409, "conflict", false);
  }

  const planInput: FeedbackPlanCreateInput = {
    type: plan.type as FeedbackPlanCreateInput["type"],
    outputRequirement: plan.outputRequirement,
    semesterId: plan.semesterId,
    classId: plan.classId,
    sessionId: plan.sessionId ?? undefined,
    rangeStartSessionId: plan.rangeStartSessionId ?? undefined,
    rangeEndSessionId: plan.rangeEndSessionId ?? undefined,
    studentIds: selected.flatMap((item) => item.studentId ? [item.studentId] : []),
    lessonMaterial,
    generationPreferences,
  };
  const context = hasFrozenV2Input ? null : await findContextForPlan(db, planInput);
  const contextByStudent = new Map(context?.students.map((student) => [student.id, student]) ?? []);
  const classStudentNames = plan.type === "class_update"
    ? (await db.student.findMany({
        where: {
          enrollments: {
            some: {
              semesterId: plan.semesterId,
              classId: plan.classId,
            },
          },
        },
        select: { name: true },
      })).map((student) => student.name)
    : [];
  const frozenFactItems = planInputSnapshot.success && planInputSnapshot.data.version === 2
    ? planInputSnapshot.data.factSnapshot.items
    : [];
  const frozenFactByStudent = new Map(frozenFactItems.map((fact) => [fact.studentId, fact]));
  const normalizedAssessmentEvidence = normalizePlanAssessmentEvidence({
    assessmentEvidence: input.assessmentEvidence,
    sessionCode: context?.session.code ?? (planInputSnapshot.success ? planInputSnapshot.data.sessionCode ?? "" : ""),
    allowedStudentIds: selected.flatMap((item) => item.studentId ? [item.studentId] : []),
  });

  // A stale item must never reuse its old evidence snapshot. Rebase the
  // deterministic bundle first; this creates a new mutable item revision while
  // approved/exported history remains immutable.
  const staleItems = hasFrozenV2Input ? [] : selected.filter((item) => item.status === "stale");
  if (staleItems.length) {
    const planBeforeRebase = plan;
    const pendingTasks = await db.teacherTask.findMany({
      where: { planId: plan.id, status: "pending" },
      select: { id: true, studentId: true },
    });
    const taskIdsByStudent = new Map<string | null, string[]>();
    for (const task of pendingTasks) {
      const key = task.studentId ?? null;
      taskIdsByStudent.set(key, [...(taskIdsByStudent.get(key) ?? []), task.id]);
    }
    const sourceFingerprint = sha256(JSON.stringify({
      input: planInput,
      context: context?.students.map((student) => ({
        id: student.id,
        promptContext: student.promptContext,
        communicationPreference: student.communicationPreference ?? null,
      })) ?? [],
      executionConstraints: { existingTaskIds: pendingTasks.map((task) => task.id).sort(), fixedArrangementRefs: [] },
      assessmentEvidence: normalizedAssessmentEvidence,
      lessonMaterial,
    }));
    await db.$transaction(async (tx) => {
      for (const item of staleItems) {
        const student = item.studentId ? contextByStudent.get(item.studentId) ?? null : null;
        const replacementAssessment = item.studentId ? normalizedAssessmentEvidence[item.studentId] : undefined;
        const preservedAssessment = replacementAssessment ? undefined : persistedAssessmentEvidence(item.evidenceSnapshot);
        const itemFingerprint = sha256(JSON.stringify({ sourceFingerprint, assessmentEvidence: replacementAssessment ?? preservedAssessment }));
        const bundle = planBeforeRebase.type === "class_update"
          ? evidenceFromClassContext({ planType: "class_update", students: context?.students ?? [], sessionId: planBeforeRebase.sessionId ?? planBeforeRebase.rangeEndSessionId ?? undefined, sourceFingerprint: itemFingerprint, existingTaskIds: taskIdsByStudent.get(null), lessonMaterial })
          : evidenceFromStudent({
            planType: planBeforeRebase.type as FeedbackPlanCreateInput["type"],
            student,
            sourceFingerprint: itemFingerprint,
            existingTaskIds: taskIdsByStudent.get(item.studentId),
            assessmentEvidence: replacementAssessment,
            preservedAssessmentEvidence: preservedAssessment,
            lessonMaterial,
          });
        await tx.feedbackPlanItem.update({
          where: { id: item.id },
          data: {
            evidenceSnapshot: json(bundle),
            compositionSnapshot: "{}",
            auditSnapshot: "{}",
            finalText: null,
            finalTextHash: null,
            selectedGenerationId: null,
            reviewMode: "model",
            status: "evidence_ready",
            approvedAt: null,
            exportedAt: null,
            itemRevision: { increment: 1 },
          },
        });
      }
      await tx.feedbackPlan.update({
        where: { id: planBeforeRebase.id },
        data: {
          inputFingerprint: sourceFingerprint,
          inputSnapshot: json({
            ...(FeedbackPlanInputSnapshotSchema.safeParse(parseJson(planBeforeRebase.inputSnapshot, null)).success
              ? FeedbackPlanInputSnapshotSchema.parse(parseJson(planBeforeRebase.inputSnapshot, null))
              : {}),
            sourceFingerprint,
          }),
          status: "draft",
          planRevision: { increment: 1 },
          approvedAt: null,
          exportedAt: null,
        },
      });
    });
    plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, include: { items: { include: { student: true, tasks: true } } } });
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    selected = input.itemIds
      ? plan.items.filter((item) => input.itemIds!.includes(item.id))
      : plan.items;
  }

  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);

  const assessmentBundleOverrides = new Map<string, FeedbackEvidenceBundle>();
  for (const item of selected) {
    if (!item.studentId || !Object.hasOwn(normalizedAssessmentEvidence, item.studentId)) continue;
    const student = contextByStudent.get(item.studentId) ?? null;
    const assessmentEvidence = normalizedAssessmentEvidence[item.studentId]!;
    const sourceFingerprint = sha256(JSON.stringify({
      planInput,
      studentId: item.studentId,
      promptContext: student?.promptContext ?? null,
      communicationPreference: student?.communicationPreference ?? null,
      existingTaskIds: [...activeTaskIds(item.tasks)].sort(),
      assessmentEvidence,
      lessonMaterial,
    }));
    assessmentBundleOverrides.set(item.id, evidenceFromStudent({
      planType: plan.type as FeedbackPlanCreateInput["type"],
      student,
      sourceFingerprint,
      existingTaskIds: [...activeTaskIds(item.tasks)],
      assessmentEvidence,
      lessonMaterial,
    }));
  }

  const allowedStatuses = input.preclaimed
    ? ["generating"]
    : hasFrozenV2Input
      ? ["evidence_ready", "queued"]
      : ["evidence_ready", "needs_review", "queued"];
  const unsupported = selected.filter((item) => !allowedStatuses.includes(item.status));
  if (unsupported.length) throw new ApiError("反馈条目当前状态不能生成，请刷新计划后重试", 409, "conflict", false);
  const originalStates = new Map(selected.map((item) => [item.id, {
    status: item.status,
    approvedAt: item.approvedAt,
    exportedAt: item.exportedAt,
  }]));
  if (!input.preclaimed) {
    const generationStartedAt = new Date();
    await db.$transaction(async (tx) => {
      const locked = await tx.feedbackPlanItem.updateMany({
        where: { id: { in: selected.map((item) => item.id) }, status: { in: ["evidence_ready", "needs_review", "queued"] } },
        data: { status: "generating", generationError: null, generationStartedAt, generationCompletedAt: null, generationDurationMs: null },
      });
      if (locked.count !== selected.length) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
      await tx.feedbackPlan.update({ where: { id: plan.id }, data: { status: "generating" } });
    });
  }
  const startedAtByItem = new Map(selected.map((item) => [item.id, item.generationStartedAt ?? new Date()]));
  const results = [];
  const executionByItem = new Map<string, {
    snapshot: FeedbackGenerationExecutionSnapshotV1;
    attempt: number;
    actualApproach: FeedbackGenerationApproach;
  }>();

  try {
    let draftRuntime: { client: ReturnType<typeof createLLMClient>; model: string } | null = null;
    let reviewRuntime: { client: ReturnType<typeof createLLMClient>; model: string } | null = null;
    const getDraftRuntime = () => draftRuntime ??= {
      client: createLLMClient("feedbackDraft"),
      model: getLLMModel("feedbackDraft"),
    };
    const getReviewRuntime = () => reviewRuntime ??= {
      client: createLLMClient("feedbackReview"),
      model: getLLMModel("feedbackReview"),
    };
    const storedApproach: FeedbackGenerationApproach = plan.generationApproach === "free" ? "free" : "restricted";
    await input.onProgress?.({ type: "status", message: `开始生成 ${selected.length} 条反馈` });
    const failures: Array<{ itemId: string; name: string; message: string }> = [];
    for (const item of selected) {
      if (input.signal?.aborted) throw new DOMException("反馈生成已取消", "AbortError");
      const student = item.studentId ? contextByStudent.get(item.studentId) ?? null : null;
      const frozenFact = frozenFactByStudent.get(item.studentId);
      const identity = auditIdentityForPlanItem(plan, item);
      const studentName = item.studentId
        ? identity.studentName ?? frozenFact?.studentName ?? frozenFact?.studentNumber ?? student?.name ?? "该学生"
        : "班级家长";
      const itemName = item.studentId ? studentName : "班级公共反馈";
      try {
        const begunExecution = beginFeedbackGenerationExecution(
          item.generationExecutionSnapshot,
          storedApproach,
        );
        const started = await db.feedbackPlanItem.updateMany({
          where: { id: item.id, status: "generating", itemRevision: item.itemRevision },
          data: {
            generationExecutionSnapshot: serializeFeedbackGenerationExecutionSnapshot(begunExecution.snapshot),
          },
        });
        if (started.count !== 1) {
          throw new ApiError("反馈条目状态已经变化，请刷新后重试", 409, "conflict", false);
        }
        executionByItem.set(item.id, begunExecution);
        const effectiveConfig = effectiveFeedbackPlanConfig(plan, item);
        const bundle = bundleForPlanConfig(sanitizeFeedbackEvidenceBundle(assessmentBundleOverrides.get(item.id)
          ?? FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {}))), effectiveConfig);
        const preference = hasFrozenV2Input
          ? frozenFact?.communicationPreference ?? undefined
          : student?.communicationPreference;
        const referenceDate = hasFrozenV2Input ? frozenFact?.referenceDate : context?.session.date;
        const generationTaskIds = auditTaskIdsForBundle(bundle, item.tasks);
        const style = effectiveConfig.generationPreferences?.tone === "professional"
          ? "professional" as const
          : effectiveConfig.generationPreferences?.tone === "gentle"
            ? "gentle" as const
            : preference?.terminology === "professional" ? "professional" as const : "gentle" as const;
        const length = effectiveConfig.generationPreferences?.length === "short"
          ? "short" as const
          : effectiveConfig.generationPreferences?.length === "detailed"
            ? "standard" as const
            : preference?.length === "short" ? "short" as const : "standard" as const;
        const execution = executionByItem.get(item.id);
        if (!execution) {
          throw new ApiError("反馈生成缺少执行快照，请刷新后重试", 409, "conflict", false);
        }
        const actualApproach = execution.actualApproach;
        let composition: FeedbackCompositionPlan;
        let draftComposition: FeedbackCompositionPlan | null = null;
        let restrictedGeneration: RestrictedFeedbackGenerationResult | null = null;

        if (actualApproach === "restricted") {
          const planner = getDraftRuntime();
          const writer = getReviewRuntime();
          const checkpoint = RestrictedFeedbackCheckpointV1Schema.safeParse(execution.snapshot.restrictedCheckpoint);
          restrictedGeneration = await generateRestrictedFeedback({
            studentName,
            planType: effectiveConfig.type,
            outputRequirement: effectiveConfig.outputRequirement,
            evidenceBundle: bundle,
            style,
            length,
            generationPreferences: effectiveConfig.generationPreferences,
            plannerClient: planner.client,
            plannerModel: planner.model,
            writerClient: writer.client,
            writerModel: writer.model,
            referenceDate,
            forbiddenStudentNames: item.studentId === null
              ? classStudentNames
              : identity.otherStudentNames,
            checkpoint: checkpoint.success ? checkpoint.data : null,
            onCheckpoint: async (nextCheckpoint) => {
              const nextSnapshot: FeedbackGenerationExecutionSnapshotV1 = {
                ...updateFeedbackGenerationExecutionStage(execution.snapshot, execution.attempt, "writer"),
                restrictedCheckpoint: nextCheckpoint,
              };
              const saved = await db.feedbackPlanItem.updateMany({
                where: { id: item.id, status: "generating", itemRevision: item.itemRevision },
                data: {
                  generationExecutionSnapshot: serializeFeedbackGenerationExecutionSnapshot(nextSnapshot),
                },
              });
              if (saved.count !== 1) {
                throw new ApiError("反馈条目状态已经变化，策略检查点未保存", 409, "conflict", false);
              }
              execution.snapshot = nextSnapshot;
            },
            signal: input.signal,
          });
          composition = restrictedGeneration.composition;
        } else {
          const draft = getDraftRuntime();
          const generated = await generateFreeFeedbackPlanComposition({
            studentName,
            planType: effectiveConfig.type,
            outputRequirement: effectiveConfig.outputRequirement,
            evidenceBundle: bundle,
            style,
            length,
            draftClient: draft.client,
            draftModel: draft.model,
            generationPreferences: effectiveConfig.generationPreferences,
            referenceDate,
            existingTaskIds: generationTaskIds,
            signal: input.signal,
          });
          composition = generated.composition;
          draftComposition = generated.draftComposition;
        }
        const blockedRestrictedGeneration = restrictedGeneration?.kind === "blocked_draft"
          ? restrictedGeneration
          : null;
        const successfulRestrictedGeneration = restrictedGeneration?.kind === "validated"
          ? restrictedGeneration
          : null;
        const baseAudit = createAuditSnapshot(
          composition,
          bundle,
          generationTaskIds,
          identity,
          { enforceParentAudience: true, generationPreferences: effectiveConfig.generationPreferences },
        );
        const audit = blockedRestrictedGeneration
          ? blockAuditForRestrictedWriter(baseAudit, blockedRestrictedGeneration.blocker.message)
          : baseAudit;
        if (blockedRestrictedGeneration) {
          execution.snapshot = updateFeedbackGenerationExecutionStage(
            execution.snapshot,
            execution.attempt,
            "deterministic_check",
          );
        }
        const generationCompletedAt = new Date();
        const updated = await db.$transaction(async (tx) => {
          const generation = blockedRestrictedGeneration
            ? null
            : await recordSuccessfulGeneration({
                taskType: "feedback",
                stage: actualApproach === "restricted"
                  ? "plan-restricted"
                  : "plan-free",
                semesterId: plan.semesterId,
                classId: plan.classId,
                sessionId: plan.sessionId,
                studentId: item.studentId,
                feedbackPlanItemId: item.id,
                sourceRefs: item.studentId ? [{ type: "student", id: item.studentId }] : [],
                promptVersion: actualApproach === "restricted"
                  ? "feedback-plan-v3-restricted"
                  : "feedback-plan-v3-free",
                modelRole: actualApproach === "restricted"
                  ? "feedbackReview"
                  : "feedbackDraft",
                inputRevision: String(plan.planRevision),
                variantKey: execution ? `feedback-plan-item:${item.id}:attempt:${execution.attempt}` : null,
                inputSnapshot: successfulRestrictedGeneration ? {
                  generationApproach: "restricted",
                  requestedApproach: execution?.snapshot.requestedApproach,
                  strategy: successfulRestrictedGeneration.strategy,
                  writerInput: successfulRestrictedGeneration.writerInput,
                  generationConfig: effectiveConfig,
                  generationContext: { studentName, communicationPreference: preference ?? null, referenceDate },
                  planner: successfulRestrictedGeneration.planner,
                  writer: successfulRestrictedGeneration.writer,
                } : {
                  evidenceBundle: bundle,
                  draftComposition,
                  generationApproach: actualApproach,
                  generationConfig: effectiveConfig,
                  generationContext: { studentName, communicationPreference: preference ?? null, referenceDate },
                },
                outputSnapshot: {
                  composition,
                  audit,
                  generationApproach: actualApproach,
                  ...(successfulRestrictedGeneration ? {
                    planner: successfulRestrictedGeneration.planner,
                    writer: successfulRestrictedGeneration.writer,
                  } : {}),
                },
                finalText: composition.draftFeedback,
              }, tx);
          const completedExecutionSnapshot = execution
            ? completeFeedbackGenerationExecution({
              snapshot: execution.snapshot,
              attempt: execution.attempt,
              status: blockedRestrictedGeneration ? "failed" : "succeeded",
              completedAt: generationCompletedAt,
              ...(blockedRestrictedGeneration ? {
                error: new ApiError(
                  blockedRestrictedGeneration.blocker.message,
                  502,
                  "llm_schema_invalid",
                  true,
                ),
              } : {}),
              ...(generation ? { generationRecordId: generation.id } : {}),
            })
            : null;
          const writeResult = await tx.feedbackPlanItem.updateMany({
            where: { id: item.id, status: "generating", itemRevision: item.itemRevision },
            data: {
              evidenceSnapshot: json(bundle),
              compositionSnapshot: json(composition),
              auditSnapshot: json(audit),
              finalText: composition.draftFeedback,
              finalTextHash: sha256(composition.draftFeedback),
              selectedGenerationId: generation?.id ?? null,
              status: "needs_review",
              reviewMode: "model",
              generationError: null,
              generationCompletedAt,
              generationDurationMs: Math.max(0, generationCompletedAt.getTime() - startedAtByItem.get(item.id)!.getTime()),
              ...(completedExecutionSnapshot ? {
                generationExecutionSnapshot: serializeFeedbackGenerationExecutionSnapshot(completedExecutionSnapshot),
              } : {}),
              itemRevision: { increment: 1 },
            },
          });
          if (writeResult.count !== 1) {
            throw new ApiError("反馈证据或偏好在生成期间发生变化，请刷新后重新生成", 409, "conflict", false);
          }
          const persisted = await tx.feedbackPlanItem.findUnique({ where: { id: item.id } });
          if (!persisted) throw new Error("生成后的反馈条目无法读取");
          return { persisted, completedExecutionSnapshot };
        });
        if (execution && updated.completedExecutionSnapshot) {
          execution.snapshot = updated.completedExecutionSnapshot;
        }
        results.push(updated.persisted);
        await input.onProgress?.({ type: "item", itemId: updated.persisted.id, status: updated.persisted.status, message: itemName });
      } catch (error) {
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const original = originalStates.get(item.id);
        if (original) {
          const generationCompletedAt = new Date();
          const execution = executionByItem.get(item.id);
          if (execution) {
            execution.snapshot = completeFeedbackGenerationExecution({
              snapshot: execution.snapshot,
              attempt: execution.attempt,
              status: "failed",
              completedAt: generationCompletedAt,
              error,
            });
          }
          await db.feedbackPlanItem.updateMany({
            where: { id: item.id, status: "generating", itemRevision: item.itemRevision },
            data: {
              status: "generation_failed",
              generationError: messageForGenerationError(error),
              generationCompletedAt,
              generationDurationMs: Math.max(0, generationCompletedAt.getTime() - startedAtByItem.get(item.id)!.getTime()),
              approvedAt: original.approvedAt,
              exportedAt: original.exportedAt,
              ...(execution ? {
                generationExecutionSnapshot: serializeFeedbackGenerationExecutionSnapshot(execution.snapshot),
              } : {}),
              itemRevision: { increment: 1 },
            },
          });
        }
        const message = messageForGenerationError(error);
        failures.push({ itemId: item.id, name: itemName, message });
        await input.onProgress?.({ type: "item", itemId: item.id, status: "error", message: itemName, error: message });
      }
    }
    const currentItems = await db.feedbackPlanItem.findMany({ where: { planId: plan.id }, select: { status: true } });
    const currentPlan = await db.feedbackPlan.findUnique({ where: { id: plan.id }, select: { status: true } });
    await db.feedbackPlan.update({
      where: { id: plan.id },
      data: {
        status: currentPlan?.status === "pause_requested"
          ? "pause_requested"
          : input.preclaimed && !input.signal?.aborted
            ? "generating"
            : derivePlanStatus(currentItems),
        planRevision: { increment: 1 },
      },
    });
    await input.onProgress?.({ type: "status", message: failures.length ? `生成完成：成功 ${results.length} 条，失败 ${failures.length} 条` : `生成完成：${results.length} 条` });
    return results;
  } catch (error) {
    const terminalError = input.signal?.aborted
      ? new ApiError("已由教师强制终止，可重试", 409, "cancelled", true)
      : error;
    await db.$transaction(async (tx) => {
      for (const item of selected) {
        const original = originalStates.get(item.id);
        if (!original) continue;
        const generationCompletedAt = new Date();
        const execution = executionByItem.get(item.id);
        if (execution && execution.snapshot.attempts.some((attempt) => (
          attempt.attempt === execution.attempt && attempt.status === "running"
        ))) {
          execution.snapshot = completeFeedbackGenerationExecution({
            snapshot: execution.snapshot,
            attempt: execution.attempt,
            status: "interrupted",
            completedAt: generationCompletedAt,
            error: terminalError,
          });
        }
        await tx.feedbackPlanItem.updateMany({
          where: { id: item.id, status: "generating", itemRevision: item.itemRevision },
          data: {
            status: "generation_failed",
            generationError: messageForGenerationError(terminalError),
            generationCompletedAt,
            generationDurationMs: Math.max(0, generationCompletedAt.getTime() - startedAtByItem.get(item.id)!.getTime()),
            approvedAt: original.approvedAt,
            exportedAt: original.exportedAt,
            ...(execution ? {
              generationExecutionSnapshot: serializeFeedbackGenerationExecutionSnapshot(execution.snapshot),
            } : {}),
            itemRevision: { increment: 1 },
          },
        });
      }
      const currentItems = await tx.feedbackPlanItem.findMany({ where: { planId: plan.id }, select: { status: true } });
      const currentPlan = await tx.feedbackPlan.findUnique({ where: { id: plan.id }, select: { status: true } });
      await tx.feedbackPlan.update({
        where: { id: plan.id },
        data: {
          status: currentPlan?.status === "pause_requested"
            ? "pause_requested"
            : input.preclaimed && !input.signal?.aborted
              ? "generating"
              : derivePlanStatus(currentItems),
        },
      });
    }).catch(() => undefined);
    throw terminalError;
  }
}

// 生成器只在当前 Node 进程内持有执行句柄，真正的进度和条目状态全部写入
// FeedbackPlan/FeedbackPlanItem。这样页面刷新、断线或请求超时都不会丢失已完成结果；
// 进程重启后由 continue/retry 把没有执行器的 generating 条目重新入队。
type FeedbackGenerationJobHandle = {
  runId: string;
  controller: AbortController;
  promise: Promise<void>;
};

const feedbackGenerationJobs = new Map<string, FeedbackGenerationJobHandle>();
const MAX_FEEDBACK_CONCURRENCY = 2;

type FeedbackGenerationPermitWaiter = {
  signal?: AbortSignal;
  resolve: (release: (() => void) | null) => void;
  onAbort?: () => void;
};

type FeedbackGenerationPermitPool = {
  active: number;
  waiters: FeedbackGenerationPermitWaiter[];
};

const feedbackGenerationPermitPools = new Map<string, FeedbackGenerationPermitPool>();

function feedbackGenerationPermitScope(planId: string, batchId: string | null) {
  return batchId ? `batch:${batchId}` : `plan:${planId}`;
}

function releaseFeedbackGenerationPermit(scope: string) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const pool = feedbackGenerationPermitPools.get(scope);
    if (!pool) return;
    pool.active = Math.max(0, pool.active - 1);
    while (pool.waiters.length) {
      const waiter = pool.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.resolve(null);
        continue;
      }
      pool.active += 1;
      waiter.resolve(releaseFeedbackGenerationPermit(scope));
      return;
    }
    if (pool.active === 0) feedbackGenerationPermitPools.delete(scope);
  };
}

function acquireFeedbackGenerationPermit(scope: string, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve<(() => void) | null>(null);
  const pool = feedbackGenerationPermitPools.get(scope) ?? { active: 0, waiters: [] };
  feedbackGenerationPermitPools.set(scope, pool);
  if (pool.active < MAX_FEEDBACK_CONCURRENCY) {
    pool.active += 1;
    return Promise.resolve<(() => void) | null>(releaseFeedbackGenerationPermit(scope));
  }
  return new Promise<(() => void) | null>((resolve) => {
    const waiter: FeedbackGenerationPermitWaiter = { signal, resolve };
    waiter.onAbort = () => {
      const index = pool.waiters.indexOf(waiter);
      if (index >= 0) pool.waiters.splice(index, 1);
      signal?.removeEventListener("abort", waiter.onAbort!);
      resolve(null);
      if (pool.active === 0 && pool.waiters.length === 0) feedbackGenerationPermitPools.delete(scope);
    };
    pool.waiters.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

export function isFeedbackPlanGenerationRunning(planId: string) {
  return feedbackGenerationJobs.has(planId);
}

async function claimQueuedFeedbackPlanItem(
  planId: string,
  batchId: string | null,
  db: PrismaClient,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return null;
  const candidate = await db.feedbackPlanItem.findFirst({
    where: { planId, status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true, itemRevision: true },
  });
  if (!candidate || signal?.aborted) return null;
  const claimed = await db.feedbackPlanItem.updateMany({
    where: {
      id: candidate.id,
      planId,
      status: "queued",
      itemRevision: candidate.itemRevision,
      plan: {
        status: { in: ["queued", "generating"] },
        batchId,
        ...(batchId ? {
          batch: {
            is: {
              id: batchId,
              archivedAt: null,
              status: "running",
            },
          },
        } : {}),
      },
    },
    data: {
      status: "generating",
      generationError: null,
      generationStartedAt: new Date(),
      generationCompletedAt: null,
      generationDurationMs: null,
      itemRevision: { increment: 1 },
    },
  });
  return claimed.count === 1 ? candidate.id : null;
}

async function runFeedbackGenerationJob(planId: string, db: PrismaClient = prisma, signal?: AbortSignal) {
  const active = new Map<string, Promise<unknown>>();
  while (true) {
    if (signal?.aborted) return;
    const plan = await db.feedbackPlan.findUnique({
      where: { id: planId },
      select: {
        status: true,
        batchId: true,
        generationApproach: true,
        items: { select: { status: true } },
        batch: {
          select: {
            status: true,
            plans: {
              where: { id: { not: planId } },
              select: {
                status: true,
                items: { select: { status: true } },
              },
            },
          },
        },
      },
    });
    if (!plan) return;
    assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
    if (!["queued", "generating", "pause_requested"].includes(plan.status)) return;

    const parentAllowsClaims = !plan.batchId || plan.batch?.status === "running";
    if (plan.status !== "pause_requested" && parentAllowsClaims && !signal?.aborted) {
      const hasRunnableSibling = plan.batch?.plans.some((sibling) => (
        sibling.status !== "generation_failed"
        && sibling.items.some((item) => ["evidence_ready", "queued", "generating"].includes(item.status))
      )) ?? false;
      const localConcurrency = plan.batchId && hasRunnableSibling ? 1 : MAX_FEEDBACK_CONCURRENCY;
      while (active.size < localConcurrency) {
        if (signal?.aborted) break;
        const releasePermit = await acquireFeedbackGenerationPermit(
          feedbackGenerationPermitScope(planId, plan.batchId),
          signal,
        );
        if (!releasePermit) break;
        let itemId: string | null;
        try {
          itemId = await claimQueuedFeedbackPlanItem(planId, plan.batchId, db, signal);
        } catch (error) {
          releasePermit();
          throw error;
        }
        if (!itemId) {
          releasePermit();
          break;
        }
        const task = generateFeedbackPlanItems({ planId, itemIds: [itemId], preclaimed: true, signal }, db)
          .catch(() => undefined)
          .finally(() => {
            active.delete(itemId);
            releasePermit();
          });
        active.set(itemId, task);
      }
    }

    if (active.size > 0) {
      await Promise.race(active.values());
      if (signal?.aborted) {
        await Promise.allSettled([...active.values()]);
        return;
      }
      continue;
    }
    if (signal?.aborted) return;

    const latest = await db.feedbackPlan.findUnique({
      where: { id: planId },
      select: {
        status: true,
        batchId: true,
        batch: { select: { status: true } },
        items: { select: { status: true } },
      },
    });
    if (!latest) return;
    const hasQueued = latest.items.some((item) => item.status === "queued");
    const hasUnownedGenerating = latest.items.some((item) => item.status === "generating");
    const parentIsPausing = Boolean(
      latest.batchId && ["pause_requested", "paused"].includes(latest.batch?.status ?? ""),
    );
    if (latest.status === "pause_requested" || parentIsPausing) {
      const closed = await closeGenerationClock(planId, false, db, {
        status: "paused",
        incrementPlanRevision: true,
        expectedStatuses: parentIsPausing
          ? ["queued", "generating", "pause_requested"]
          : ["pause_requested"],
      });
      if (closed) return;
      continue;
    }
    if (hasQueued) continue;
    if (hasUnownedGenerating) {
      await settleInterruptedFeedbackPlanItems({
        planId,
        message: "生成执行上下文已丢失，本条已收口，可重试",
        includeQueued: false,
      }, db);
      return;
    }
    const closed = await closeGenerationClock(planId, true, db, {
      status: derivePlanStatus(latest.items),
      incrementPlanRevision: true,
      expectedStatuses: ["queued", "generating"],
    });
    if (closed) return;
  }
}

function startFeedbackGenerationJob(planId: string, db: PrismaClient = prisma): Promise<void> {
  const existing = feedbackGenerationJobs.get(planId);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const runId = randomUUID();
  const promise = runFeedbackGenerationJob(planId, db, controller.signal).finally(() => {
    if (feedbackGenerationJobs.get(planId)?.runId === runId) feedbackGenerationJobs.delete(planId);
  });
  feedbackGenerationJobs.set(planId, { runId, controller, promise });
  void promise.catch(() => undefined);
  return promise;
}

async function prepareQueuedGenerationEvidence(input: {
  planId: string;
  itemIds?: string[];
  assessmentEvidence?: FeedbackPlanAssessmentEvidenceInput;
}, db: PrismaClient) {
  const requestedIds = input.itemIds?.length ? new Set(input.itemIds) : null;
  const plan = await db.feedbackPlan.findUnique({
    where: { id: input.planId },
    include: { items: { include: { student: true, tasks: true } } },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  const selected = plan.items.filter((item) => (
    (!requestedIds || requestedIds.has(item.id))
    && ["evidence_ready", "needs_review", "generation_failed", "stale"].includes(item.status)
  ));
  const hasReplacementEvidence = Object.keys(input.assessmentEvidence ?? {}).length > 0;
  if (feedbackPlanHasGenerationTrace(plan) && (hasReplacementEvidence || selected.some((item) => item.status === "stale"))) {
    throw new ApiError("已经启动的计划不能原位换用新事实；请保留旧正文或建立另一份计划", 409, "conflict", false);
  }
  if (!hasReplacementEvidence && !selected.some((item) => item.status === "stale")) return plan.planRevision;

  const parsedSnapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
  if (parsedSnapshot.success && parsedSnapshot.data.version === 2) {
    if (hasReplacementEvidence) {
      throw new ApiError("本计划的事实快照已经冻结；请按当前事实建立另一份计划", 409, "conflict", false);
    }
    // V2 plans never rebuild or regenerate stale rows in place. Historical
    // accidental stale marks can be kept explicitly through the retain action.
    return plan.planRevision;
  }
  const lessonMaterial = parsedSnapshot.success ? parsedSnapshot.data.lessonMaterial : undefined;
  const planInput: FeedbackPlanCreateInput = {
    type: plan.type as FeedbackPlanCreateInput["type"],
    outputRequirement: plan.outputRequirement,
    semesterId: plan.semesterId,
    classId: plan.classId,
    sessionId: plan.sessionId ?? undefined,
    rangeStartSessionId: plan.rangeStartSessionId ?? undefined,
    rangeEndSessionId: plan.rangeEndSessionId ?? undefined,
    studentIds: selected.flatMap((item) => item.studentId ? [item.studentId] : []),
    lessonMaterial,
    generationPreferences: generationPreferencesFromSnapshot(plan.type, plan.inputSnapshot),
  };
  const context = await findContextForPlan(db, planInput);
  const contextByStudent = new Map(context?.students.map((student) => [student.id, student]) ?? []);
  const normalizedAssessmentEvidence = normalizePlanAssessmentEvidence({
    assessmentEvidence: input.assessmentEvidence,
    sessionCode: context?.session.code ?? "",
    allowedStudentIds: selected.flatMap((item) => item.studentId ? [item.studentId] : []),
  });
  const sourceFingerprint = sha256(JSON.stringify({
    previousFingerprint: plan.inputFingerprint,
    planInput,
    context: context?.students.map((student) => ({
      id: student.id,
      promptContext: student.promptContext,
      communicationPreference: student.communicationPreference ?? null,
    })) ?? [],
    assessmentEvidence: normalizedAssessmentEvidence,
    lessonMaterial,
  }));

  return db.$transaction(async (tx) => {
    const lockedPlan = await tx.feedbackPlan.updateMany({
      where: {
        id: plan.id,
        planRevision: plan.planRevision,
        generationStartedAt: null,
        archivedAt: null,
      },
      data: {
        inputFingerprint: sourceFingerprint,
        inputSnapshot: json({ ...(parsedSnapshot.success ? parsedSnapshot.data : {}), sourceFingerprint }),
        planRevision: { increment: 1 },
        approvedAt: null,
        exportedAt: null,
      },
    });
    if (lockedPlan.count !== 1) {
      throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
    }
    for (const item of selected) {
      const replacementAssessment = item.studentId && Object.hasOwn(normalizedAssessmentEvidence, item.studentId)
        ? normalizedAssessmentEvidence[item.studentId]
        : undefined;
      if (!replacementAssessment && item.status !== "stale") continue;
      const preservedAssessment = replacementAssessment ? undefined : persistedAssessmentEvidence(item.evidenceSnapshot);
      const itemFingerprint = sha256(JSON.stringify({
        sourceFingerprint,
        studentId: item.studentId,
        assessmentEvidence: replacementAssessment ?? preservedAssessment,
      }));
      const bundle = plan.type === "class_update"
        ? evidenceFromClassContext({
          planType: "class_update",
          students: context?.students ?? [],
          sessionId: plan.sessionId ?? plan.rangeEndSessionId ?? undefined,
          sourceFingerprint: itemFingerprint,
          existingTaskIds: [...activeTaskIds(item.tasks)],
          lessonMaterial,
        })
        : evidenceFromStudent({
          planType: plan.type as FeedbackPlanCreateInput["type"],
          student: item.studentId ? contextByStudent.get(item.studentId) ?? null : null,
          sourceFingerprint: itemFingerprint,
          existingTaskIds: [...activeTaskIds(item.tasks)],
          assessmentEvidence: replacementAssessment,
          preservedAssessmentEvidence: preservedAssessment,
          lessonMaterial,
        });
      await tx.feedbackPlanItem.update({
        where: { id: item.id },
        data: {
          evidenceSnapshot: json(bundle),
          generationError: null,
          itemRevision: { increment: 1 },
          ...(item.status === "stale" ? {
            compositionSnapshot: "{}",
            auditSnapshot: "{}",
            finalText: null,
            finalTextHash: null,
            selectedGenerationId: null,
            reviewMode: "model",
            approvedAt: null,
            exportedAt: null,
            status: "evidence_ready",
          } : {}),
        },
      });
    }
    return plan.planRevision + 1;
  });
}

export async function startFeedbackPlanGeneration(input: {
  planId: string;
  itemIds?: string[];
  assessmentEvidence?: FeedbackPlanAssessmentEvidenceInput;
  generationApproach?: FeedbackGenerationApproach;
  expectedPlanRevision?: number;
}, db: PrismaClient = prisma, options: { allowBatchStart?: boolean; expectedBatchRevision?: number } = {}) {
  await reconcileInterruptedFeedbackPlanGeneration(input.planId, db);
  const plan = await db.feedbackPlan.findUnique({
    where: { id: input.planId },
    select: {
      id: true,
      archivedAt: true,
      status: true,
      displayName: true,
      basedOnPlanId: true,
      batchId: true,
      planRevision: true,
      generationStartedAt: true,
      generationApproach: true,
    },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划不能继续生成", 409, "conflict", false);
  if (plan.batchId && !options.allowBatchStart) {
    throw new ApiError("班级组子计划不能单独启动，请从班级组计划开始生成", 409, "conflict", false);
  }
  if (plan.basedOnPlanId && !plan.batchId && !plan.displayName?.trim()) {
    throw new ApiError("请先为修正计划命名，再开始生成", 409, "conflict", false);
  }
  if (input.expectedPlanRevision && input.expectedPlanRevision !== plan.planRevision) {
    throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
  }
  if (input.generationApproach) {
    const storedApproach = normalizeStoredFeedbackGenerationApproach(plan.generationApproach);
    if (storedApproach === "legacy" || storedApproach !== input.generationApproach) {
      throw new ApiError("反馈生成方式与已保存计划不一致，请刷新后重试", 409, "conflict", false);
    }
  }
  if (feedbackGenerationJobs.has(input.planId) && ["queued", "generating", "pause_requested"].includes(plan.status)) {
    return { accepted: true, status: plan.status };
  }
  if (["queued", "generating", "pause_requested"].includes(plan.status)) {
    throw new ApiError("反馈生成已在队列中；请继续当前生成，不要重复启动", 409, "conflict", false);
  }
  const preparedPlanRevision = await prepareQueuedGenerationEvidence(input, db);
  const queued = await db.$transaction(async (tx) => {
    const current = await tx.feedbackPlan.findUnique({
      where: { id: input.planId },
      select: {
        id: true,
        batchId: true,
        archivedAt: true,
        planRevision: true,
        generationApproach: true,
        generationStartedAt: true,
        items: {
          select: {
            id: true,
            status: true,
            finalText: true,
            selectedGenerationId: true,
            approvedAt: true,
            exportedAt: true,
          },
        },
      },
    });
    if (!current) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    assertLegacyFeedbackGenerationAvailable(current.generationApproach);
    if (current.archivedAt) throw new ApiError("已归档反馈计划不能继续生成", 409, "conflict", false);
    if (current.planRevision !== preparedPlanRevision) {
      throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
    }
    const allowedStatuses = ["evidence_ready"];
    const requestedIds = input.itemIds?.length ? new Set(input.itemIds) : null;
    const selected = current.items.filter((item) => (
      (!requestedIds || requestedIds.has(item.id))
      && allowedStatuses.includes(item.status)
      && !feedbackPlanItemHasGeneratedResult(item)
    ));
    if (requestedIds && selected.length !== requestedIds.size) {
      throw new ApiError("已生成的反馈不能原位重新生成；请建立修正计划，失败项请使用重试", 409, "conflict", false);
    }
    if (!selected.length) {
      throw new ApiError("没有尚未生成的反馈条目；修正内容请建立另一份计划", 409, "conflict", false);
    }
    if (current.batchId && options.allowBatchStart) {
      if (options.expectedBatchRevision === undefined) {
        throw new ApiError("班级组生成缺少调度版本，请刷新后重试", 409, "conflict", true);
      }
      const parentClaim = await tx.feedbackPlanBatch.updateMany({
        where: {
          id: current.batchId,
          archivedAt: null,
          status: "running",
          planRevision: options.expectedBatchRevision,
        },
        data: { planRevision: { increment: 1 } },
      });
      if (parentClaim.count !== 1) {
        throw new ApiError("班级组状态已经变化，本班未启动", 409, "conflict", true);
      }
    }
    const generationRunStartedAt = new Date();
    const firstStart = !current.generationStartedAt;
    const frozen = await tx.feedbackPlan.updateMany({
      where: {
        id: current.id,
        archivedAt: null,
        planRevision: current.planRevision,
        ...(firstStart ? { generationStartedAt: null } : {}),
      },
      data: {
        status: "queued",
        generationStartedAt: current.generationStartedAt ?? generationRunStartedAt,
        generationCompletedAt: null,
        ...(firstStart ? { generationElapsedMs: 0 } : {}),
        generationRunStartedAt,
        planRevision: { increment: 1 },
      },
    });
    if (frozen.count !== 1) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
    const updated = await tx.feedbackPlanItem.updateMany({
      where: { id: { in: selected.map((item) => item.id) }, planId: current.id, status: { in: allowedStatuses } },
      data: {
        status: "queued",
        generationError: null,
        generationStartedAt: null,
        generationCompletedAt: null,
        generationDurationMs: null,
        itemRevision: { increment: 1 },
      },
    });
    if (updated.count !== selected.length) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
    return updated.count;
  });
  void startFeedbackGenerationJob(input.planId, db).catch(() => undefined);
  return { accepted: true, status: "queued", queued };
}

export async function pauseFeedbackPlanGeneration(
  planId: string,
  db: PrismaClient = prisma,
  options: { allowBatchControl?: boolean } = {},
) {
  const plan = await db.feedbackPlan.findUnique({
    where: { id: planId },
    select: { id: true, status: true, archivedAt: true, batchId: true },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (plan.batchId && !options.allowBatchControl) {
    throw new ApiError("班级组子计划由批次统一控制，请在班级组计划中暂停", 409, "conflict", false);
  }
  if (!["queued", "generating", "pause_requested"].includes(plan.status)) {
    throw new ApiError("当前反馈计划不能暂停", 409, "conflict", false);
  }
  const handle = feedbackGenerationJobs.get(planId);
  if (!handle) {
    const reconciled = await reconcileInterruptedFeedbackPlanGeneration(planId, db);
    if (reconciled > 0) {
      const failed = await db.feedbackPlan.findUnique({ where: { id: planId }, select: { status: true } });
      return { accepted: true, status: failed?.status ?? "generation_failed" };
    }
    const paused = await closeGenerationClock(planId, false, db, {
      status: "paused",
      incrementPlanRevision: true,
      expectedStatuses: ["queued", "generating", "pause_requested"],
    });
    if (paused) return { accepted: true, status: "paused" };
    const current = await db.feedbackPlan.findUnique({ where: { id: planId }, select: { status: true } });
    if (!current) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    return { accepted: true, status: current.status };
  }
  const requested = await db.feedbackPlan.updateMany({
    where: { id: planId, archivedAt: null, status: { in: ["queued", "generating", "pause_requested"] } },
    data: { status: "pause_requested" },
  });
  if (requested.count) return { accepted: true, status: "pause_requested" };
  const current = await db.feedbackPlan.findUnique({ where: { id: planId }, select: { status: true } });
  if (!current) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  return { accepted: true, status: current.status };
}

async function settleInterruptedFeedbackPlanItems(input: {
  planId: string;
  message: string;
  includeQueued: boolean;
}, db: PrismaClient) {
  const completedAt = new Date();
  const interruption = new ApiError(input.message, 409, "cancelled", true);
  return db.$transaction(async (tx) => {
    const plan = await tx.feedbackPlan.findUnique({
      where: { id: input.planId },
      select: {
        generationElapsedMs: true,
        generationRunStartedAt: true,
        items: {
          where: { status: { in: input.includeQueued ? ["queued", "generating"] : ["generating"] } },
          select: {
            id: true,
            status: true,
            generationStartedAt: true,
            generationExecutionSnapshot: true,
          },
        },
      },
    });
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);

    let interrupted = 0;
    for (const item of plan.items) {
      let execution = parseFeedbackGenerationExecutionSnapshot(item.generationExecutionSnapshot);
      if (execution) {
        for (const attempt of execution.attempts.filter((entry) => entry.status === "running")) {
          execution = completeFeedbackGenerationExecution({
            snapshot: execution,
            attempt: attempt.attempt,
            status: "interrupted",
            completedAt,
            error: interruption,
          });
        }
      }
      const updated = await tx.feedbackPlanItem.updateMany({
        where: { id: item.id, planId: input.planId, status: item.status },
        data: {
          status: "generation_failed",
          generationError: input.message,
          generationCompletedAt: completedAt,
          generationDurationMs: item.generationStartedAt
            ? Math.max(0, completedAt.getTime() - item.generationStartedAt.getTime())
            : null,
          ...(execution ? { generationExecutionSnapshot: serializeFeedbackGenerationExecutionSnapshot(execution) } : {}),
          itemRevision: { increment: 1 },
        },
      });
      interrupted += updated.count;
    }

    const currentItems = await tx.feedbackPlanItem.findMany({
      where: { planId: input.planId },
      select: { status: true },
    });
    const elapsedMs = plan.generationElapsedMs + (plan.generationRunStartedAt
      ? Math.max(0, completedAt.getTime() - plan.generationRunStartedAt.getTime())
      : 0);
    await tx.feedbackPlan.update({
      where: { id: input.planId },
      data: {
        status: derivePlanStatus(currentItems),
        generationElapsedMs: elapsedMs,
        generationRunStartedAt: null,
        generationCompletedAt: completedAt,
        planRevision: { increment: 1 },
      },
    });
    return interrupted;
  });
}

export async function reconcileInterruptedFeedbackPlanGeneration(planId: string, db: PrismaClient = prisma) {
  if (feedbackGenerationJobs.has(planId)) return 0;
  const orphaned = await db.feedbackPlanItem.count({
    where: { planId, status: { in: ["queued", "generating"] } },
  });
  if (!orphaned) return 0;
  return settleInterruptedFeedbackPlanItems({
    planId,
    message: "生成服务曾中断，本条已收口，可重试",
    includeQueued: true,
  }, db);
}

export async function forceStopFeedbackPlanGeneration(
  planId: string,
  db: PrismaClient = prisma,
  options: { allowBatchControl?: boolean } = {},
) {
  const plan = await db.feedbackPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      archivedAt: true,
      batchId: true,
      status: true,
      items: { select: { status: true } },
    },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (plan.batchId && !options.allowBatchControl) {
    throw new ApiError("班级组子计划由批次统一控制，请在班级组计划中终止", 409, "conflict", false);
  }
  const hasActiveItems = plan.items.some((item) => ["queued", "generating"].includes(item.status));
  const handle = feedbackGenerationJobs.get(planId);
  if (!hasActiveItems && !handle) throw new ApiError("当前反馈计划没有正在运行的生成", 409, "conflict", false);

  await db.feedbackPlan.updateMany({
    where: { id: planId, archivedAt: null },
    data: { status: "pause_requested", planRevision: { increment: 1 } },
  });
  handle?.controller.abort(new DOMException("教师已强制终止反馈生成", "AbortError"));
  const interrupted = await settleInterruptedFeedbackPlanItems({
    planId,
    message: "已由教师强制终止，可重试",
    includeQueued: true,
  }, db);
  const settled = await db.feedbackPlan.findUnique({
    where: { id: planId },
    select: { status: true },
  });
  if (!settled) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  return { accepted: true, status: settled.status, interrupted };
}

export async function continueFeedbackPlanGeneration(
  planId: string,
  db: PrismaClient = prisma,
  options: { allowBatchControl?: boolean; expectedBatchRevision?: number } = {},
) {
  const plan = await db.feedbackPlan.findUnique({
    where: { id: planId },
    select: { id: true, archivedAt: true, generationStartedAt: true, batchId: true, generationApproach: true },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划不能继续生成", 409, "conflict", false);
  if (plan.batchId && !options.allowBatchControl) {
    throw new ApiError("班级组子计划由批次统一控制，请在班级组计划中继续", 409, "conflict", false);
  }
  const hasRunningJob = feedbackGenerationJobs.has(planId);
  const generationRunStartedAt = new Date();
  const queued = await db.$transaction(async (tx) => {
    if (plan.batchId && options.allowBatchControl) {
      if (options.expectedBatchRevision === undefined) {
        throw new ApiError("班级组生成缺少调度版本，请刷新后重试", 409, "conflict", true);
      }
      const parentClaim = await tx.feedbackPlanBatch.updateMany({
        where: {
          id: plan.batchId,
          archivedAt: null,
          status: "running",
          planRevision: options.expectedBatchRevision,
        },
        data: { planRevision: { increment: 1 } },
      });
      if (parentClaim.count !== 1) {
        throw new ApiError("班级组状态已经变化，本班未继续", 409, "conflict", true);
      }
    }
    if (!hasRunningJob) {
      await tx.feedbackPlanItem.updateMany({
        where: { planId, status: "generating" },
        data: { status: "queued", generationError: null, itemRevision: { increment: 1 } },
      });
    }
    const queuedCount = await tx.feedbackPlanItem.count({ where: { planId, status: "queued" } });
    if (!queuedCount && !hasRunningJob) {
      throw new ApiError("当前没有等待继续生成的反馈条目", 409, "conflict", false);
    }
    await tx.feedbackPlan.update({
      where: { id: planId },
      data: {
        status: "queued",
        generationStartedAt: plan.generationStartedAt ?? generationRunStartedAt,
        generationRunStartedAt,
        generationCompletedAt: null,
      },
    });
    return queuedCount;
  });
  const existing = feedbackGenerationJobs.get(planId);
  if (existing) {
    void existing.promise
      .catch(() => undefined)
      .then(() => startFeedbackGenerationJob(planId, db))
      .catch(() => undefined);
  } else {
    void startFeedbackGenerationJob(planId, db).catch(() => undefined);
  }
  return { accepted: true, status: "queued", queued };
}

export async function retryFeedbackPlanGeneration(
  input: { planId: string; itemIds?: string[] },
  db: PrismaClient = prisma,
  options: { allowBatchControl?: boolean; startJob?: boolean } = {},
) {
  await reconcileInterruptedFeedbackPlanGeneration(input.planId, db);
  const plan = await db.feedbackPlan.findUnique({
    where: { id: input.planId },
    select: {
      id: true,
      archivedAt: true,
      generationApproach: true,
      batchId: true,
      status: true,
      generationStartedAt: true,
      items: { select: { status: true } },
    },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (plan.batchId && !options.allowBatchControl) {
    throw new ApiError("班级组子计划由批次统一控制，请在班级组计划中重试", 409, "conflict", false);
  }
  if (feedbackGenerationJobs.has(input.planId)
    || ["queued", "generating", "pause_requested"].includes(plan.status)
    || plan.items.some((item) => ["queued", "generating"].includes(item.status))) {
    throw new ApiError("仍有反馈正在生成，请先等待完成或强制终止", 409, "conflict", false);
  }
  const where = input.itemIds?.length
    ? { planId: input.planId, id: { in: [...new Set(input.itemIds)] }, status: "generation_failed" }
    : { planId: input.planId, status: "generation_failed" };
  const candidates = await db.feedbackPlanItem.findMany({
    where,
    select: {
      id: true,
      status: true,
      finalText: true,
      selectedGenerationId: true,
      approvedAt: true,
      exportedAt: true,
    },
  });
  if (!candidates.length) throw new ApiError("没有可重试的失败反馈", 409, "conflict", false);
  const restoredIds = candidates.filter(feedbackPlanItemHasGeneratedResult).map((item) => item.id);
  const retryableIds = candidates.filter((item) => !feedbackPlanItemHasGeneratedResult(item)).map((item) => item.id);
  const result = await db.$transaction(async (tx) => {
    const restored = restoredIds.length
      ? await tx.feedbackPlanItem.updateMany({
          where: { id: { in: restoredIds }, planId: input.planId, status: "generation_failed" },
          data: { status: "needs_review", generationError: null, itemRevision: { increment: 1 } },
        })
      : { count: 0 };
    const retried = retryableIds.length
      ? await tx.feedbackPlanItem.updateMany({
          where: { id: { in: retryableIds }, planId: input.planId, status: "generation_failed" },
          data: { status: "queued", generationError: null, generationStartedAt: null, generationCompletedAt: null, generationDurationMs: null, itemRevision: { increment: 1 } },
        })
      : { count: 0 };
    if (!restored.count && !retried.count) {
      throw new ApiError("失败反馈已被其他操作更新，请刷新后重试", 409, "conflict", false);
    }
    if (retried.count) {
      const generationRunStartedAt = new Date();
      await tx.feedbackPlan.update({
        where: { id: input.planId },
        data: {
          status: "queued",
          generationStartedAt: plan.generationStartedAt ?? generationRunStartedAt,
          generationCompletedAt: null,
          ...(!plan.generationStartedAt ? { generationElapsedMs: 0 } : {}),
          generationRunStartedAt,
          planRevision: { increment: 1 },
        },
      });
      return { status: "queued", retried: retried.count, restored: restored.count };
    }
    const currentItems = await tx.feedbackPlanItem.findMany({ where: { planId: input.planId }, select: { status: true } });
    const status = derivePlanStatus(currentItems);
    await tx.feedbackPlan.update({
      where: { id: input.planId },
      data: { status, planRevision: { increment: 1 } },
    });
    return { status, retried: 0, restored: restored.count };
  });
  if (result.retried && options.startJob !== false) void startFeedbackGenerationJob(input.planId, db).catch(() => undefined);
  return { accepted: true, ...result };
}

export async function retryFeedbackPlanGenerationWithFree(
  input: { planId: string; itemIds?: string[] },
  db: PrismaClient = prisma,
  options: {
    allowBatchControl?: boolean;
    includeUnstarted?: boolean;
    startJob?: boolean;
  } = {},
) {
  await reconcileInterruptedFeedbackPlanGeneration(input.planId, db);
  const plan = await db.feedbackPlan.findUnique({
    where: { id: input.planId },
    select: {
      id: true,
      archivedAt: true,
      batchId: true,
      generationApproach: true,
      generationStartedAt: true,
      status: true,
      items: {
        select: {
          id: true,
          status: true,
          finalText: true,
          selectedGenerationId: true,
          approvedAt: true,
          exportedAt: true,
          generationExecutionSnapshot: true,
        },
      },
    },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (plan.batchId && !options.allowBatchControl) {
    throw new ApiError("班级组子计划由批次统一控制，请在班级组计划中切换生成方式", 409, "conflict", false);
  }
  if (feedbackGenerationJobs.has(input.planId)
    || ["queued", "generating", "pause_requested"].includes(plan.status)
    || plan.items.some((item) => ["queued", "generating"].includes(item.status))) {
    throw new ApiError("仍有反馈正在生成，请先等待完成或强制终止", 409, "conflict", false);
  }
  if (normalizeStoredFeedbackGenerationApproach(plan.generationApproach) !== "restricted") {
    throw new ApiError("只有受限反馈计划的失败或未开始条目可以改用自由反馈", 409, "conflict", false);
  }
  const requestedIds = input.itemIds?.length ? new Set(input.itemIds) : null;
  const allowedStatuses = new Set(options.includeUnstarted
    ? ["generation_failed", "evidence_ready", "queued"]
    : ["generation_failed"]);
  const inScope = plan.items.filter((item) => !requestedIds || requestedIds.has(item.id));
  if (requestedIds && inScope.length !== requestedIds.size) {
    throw new ApiError("部分反馈条目不存在", 404, "not_found", false);
  }
  const candidates = inScope.flatMap((item) => {
    if (!allowedStatuses.has(item.status) || feedbackPlanItemHasGeneratedResult(item)) return [];
    const snapshot = parseFeedbackGenerationExecutionSnapshot(item.generationExecutionSnapshot)
      ?? createFeedbackGenerationExecutionSnapshot("restricted");
    if (snapshot.requestedApproach !== "restricted" || snapshot.nextApproach === "free") return [];
    return [{ item, snapshot }];
  });
  if (requestedIds && candidates.length !== requestedIds.size) {
    throw new ApiError("所选条目不能改用自由反馈；只允许失败且尚无成功结果的受限反馈", 409, "conflict", false);
  }
  if (!candidates.length) {
    throw new ApiError(options.includeUnstarted
      ? "没有可改用自由反馈的失败或未开始条目"
      : "没有可改用自由反馈的失败条目", 409, "conflict", false);
  }

  const confirmedAt = new Date();
  const changed = await db.$transaction(async (tx) => {
    let queued = 0;
    for (const { item, snapshot } of candidates) {
      const nextSnapshot = withExplicitFreeFeedbackFallback(snapshot, confirmedAt);
      const nextStatus = item.status === "generation_failed" ? "queued" : item.status;
      const updated = await tx.feedbackPlanItem.updateMany({
        where: { id: item.id, planId: plan.id, status: item.status },
        data: {
          status: nextStatus,
          generationError: null,
          generationExecutionSnapshot: serializeFeedbackGenerationExecutionSnapshot(nextSnapshot),
          ...(nextStatus === "queued" ? {
            generationStartedAt: null,
            generationCompletedAt: null,
            generationDurationMs: null,
          } : {}),
          itemRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ApiError("反馈条目已被其他操作更新，请刷新后重试", 409, "conflict", false);
      }
      if (nextStatus === "queued") queued += 1;
    }
    const runStartedAt = new Date();
    await tx.feedbackPlan.update({
      where: { id: plan.id },
      data: {
        ...(queued ? {
          status: "queued",
          generationStartedAt: plan.generationStartedAt ?? runStartedAt,
          generationCompletedAt: null,
          generationRunStartedAt: runStartedAt,
        } : {}),
        planRevision: { increment: 1 },
      },
    });
    return { changed: candidates.length, queued };
  });
  if (changed.queued && options.startJob !== false) {
    void startFeedbackGenerationJob(plan.id, db).catch(() => undefined);
  }
  return { accepted: true, status: changed.queued ? "queued" : "prepared", ...changed };
}

export async function createPreferenceCandidate(input: {
  studentId: string;
  sourceType: "communication" | "teacher";
  sourceId?: string;
  preference: CommunicationPreference;
  evidence?: { source?: "teacher_manual"; signals?: string[] };
}, db: PrismaClient = prisma) {
  const preference = CommunicationPreferenceSchema.parse(input.preference);
  const evidence = {
    ...(input.evidence?.source === "teacher_manual" ? { source: "teacher_manual" as const } : {}),
    ...(input.evidence?.signals?.length ? { signals: input.evidence.signals.filter((signal) => typeof signal === "string").map((signal) => signal.slice(0, 100)).slice(0, 10) } : {}),
  };
  return db.communicationPreferenceCandidate.create({
    data: {
      studentId: input.studentId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      preferenceSnapshot: json(preference),
      evidenceSnapshot: json(evidence),
    },
  });
}

export async function resolvePreferenceCandidate(id: string, decision: "confirmed" | "rejected", db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const candidate = await tx.communicationPreferenceCandidate.findUnique({ where: { id } });
    if (!candidate) throw new ApiError("沟通偏好候选不存在", 404, "not_found", false);
    if (candidate.status !== "pending") throw new ApiError("沟通偏好候选已经处理，不能重复提交", 409, "conflict", false);
    const updated = await tx.communicationPreferenceCandidate.update({ where: { id }, data: { status: decision, reviewedAt: new Date() } });
    if (decision === "rejected") return updated;
    const preference = CommunicationPreferenceSchema.parse(parseJson(candidate.preferenceSnapshot, {}));
    await tx.communicationPreferenceCandidate.updateMany({
      where: { studentId: candidate.studentId, status: "confirmed", id: { not: id } },
      data: { status: "superseded" },
    });
    await tx.communicationPreference.upsert({
      where: { studentId: candidate.studentId },
      create: { studentId: candidate.studentId, preferenceSnapshot: json(preference), sourceCandidateId: id, confirmedAt: new Date() },
      update: { preferenceSnapshot: json(preference), sourceCandidateId: id, confirmedAt: new Date() },
    });
    return updated;
  });
}
