import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import {
  createFeedbackGenerationExecutionSnapshot,
  feedbackGenerationApproachForDerivedPlan,
  feedbackGenerationApproachForNewPlan,
  normalizeStoredFeedbackGenerationApproach,
  parseFeedbackGenerationExecutionSnapshot,
  serializeFeedbackGenerationExecutionSnapshot,
  withExplicitFreeFeedbackFallback,
  type FeedbackGenerationApproach,
  type FeedbackGenerationExecutionSnapshotV1
} from "@/lib/feedback-generation-approach";
import {
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  FeedbackPlanCloneDraftSchema,
  FeedbackPlanCreateSchema,
  FeedbackPlanDraftPatchSchema,
  FeedbackPlanInputSnapshotSchema,
  FeedbackPlanInputSnapshotV2Schema,
  FeedbackPlanItemPatchSchema,
  FeedbackPlanRenameSchema,
  isHardFeedbackAuditIssue,
  normalizeFeedbackGenerationPreferences,
  RESTRICTED_WRITER_OUTPUT_INVALID_CODE,
  sanitizeFeedbackComposition,
  sanitizeFeedbackEvidenceBundle,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackGenerationPreferences,
  type FeedbackPlanAssessmentEvidenceInput,
  type FeedbackPlanCloneDraftInput,
  type FeedbackPlanCreateInput,
  type FeedbackPlanDraftPatch,
  type FeedbackPlanItemPatch,
  type FeedbackPlanRenameInput
} from "@/lib/feedback-plan";
import { stripFeedbackInternalBoundary } from "@/lib/feedback-text-safety";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import { prisma } from "@/lib/prisma";
import {
  assertClassAvailable,
  assertFeedbackPlanAvailable,
  assertSemesterAvailable,
} from "@/services/academic-scope-recycle-service";
import { withFeedbackPlanDirectoryRemoval } from "@/services/feedback-attachment-storage";
import { generateFreeFeedbackPlanComposition } from "@/services/feedback-generation-service";
import { blockAuditForRestrictedWriter, createAuditSnapshot, sha256 } from "@/services/feedback-plan-audit";
import { activeTaskIds, assertPlanScope, auditIdentityForPlanItem, auditTaskIdsForBundle, buildFeedbackPlanFrozenInput, defaultLessonMaterial, evidenceFromClassContext, evidenceFromStudent, feedbackPlanSnapshotV2, findContextForPlan, normalizePlanAssessmentEvidence, persistedAssessmentEvidence, resolveSession } from "@/services/feedback-plan/evidence";
import { assertLegacyFeedbackGenerationAvailable, bundleForPlanConfig, derivePlanStatus, effectiveFeedbackPlanConfig, FeedbackPlanDb, feedbackPlanDraftFingerprint, feedbackPlanHasGenerationTrace, feedbackPlanItemHasGeneratedResult, generationPreferencesFromSnapshot, json, normalizedCoverageText, normalizedStudentOverrides, normalizeStudentGenerationConfig, parseCompositionSnapshot, parseGenerationConfigSnapshot, parseJson, restrictedWriterBlockerFromAuditSnapshot, StoredFeedbackPlanDraft } from "@/services/feedback-plan/model";
import { getFeedbackPlan, storedFeedbackPlanDraft } from "@/services/feedback-plan/query";
import { recordSuccessfulGeneration } from "@/services/generation-memory-service";
import {
  generateRestrictedFeedback,
  generateStudentContentBriefFeedback,
  RestrictedFeedbackCheckpointV1Schema,
  RestrictedFeedbackCheckpointV2Schema,
  type RestrictedFeedbackGenerationResult,
  type StudentContentBriefGenerationResult,
} from "@/services/restricted-feedback-generation-service";
import { randomUUID } from "node:crypto";
export { createPreferenceCandidate, resolvePreferenceCandidate } from "@/services/communication-preference-service";
export { addFeedbackAttachment, removeFeedbackAttachment, validateFeedbackPlanAttachments } from "@/services/feedback-attachment-service";
export { purgeFeedbackAttachmentDirectories } from "@/services/feedback-attachment-storage";
export { invalidateFeedbackPlans } from "@/services/feedback-plan-invalidation-service";
export { derivePlanStatus, feedbackPlanHasGenerationTrace, feedbackPlanItemHasGeneratedResult } from "@/services/feedback-plan/model";
export { getFeedbackPlan, listFeedbackPlans } from "@/services/feedback-plan/query";
export { toFeedbackPlanDetail, toFeedbackPlanItemView } from "@/services/feedback-plan/view";





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
  await findContextForPlan(db, input);
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

  const { inputSnapshot, inputFingerprint, selectedIds, studentOverridesById, frozenFactsByStudent } =
    await buildFeedbackPlanFrozenInput(input, rangeStartSessionId, rangeEndSessionId, db);

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
  return withFeedbackPlanDirectoryRemoval(id, plan.attachments, async () => {
    await db.$transaction(async (tx) => {
      await tx.feedbackPlan.delete({ where: { id } });
    });
    return { id, deleted: true };
  });
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
        let studentContentBriefGeneration: StudentContentBriefGenerationResult | null = null;

        if (actualApproach === "restricted") {
          const planner = getDraftRuntime();
          const writer = getReviewRuntime();
          const saveRestrictedCheckpoint = async (nextCheckpoint: unknown) => {
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
          };
          if (item.studentId) {
            const checkpoint = RestrictedFeedbackCheckpointV2Schema.safeParse(execution.snapshot.restrictedCheckpoint);
            studentContentBriefGeneration = await generateStudentContentBriefFeedback({
              studentName,
              planType: effectiveConfig.type as "event_micro" | "stage_trend" | "course_end",
              outputRequirement: effectiveConfig.outputRequirement,
              evidenceBundle: bundle,
              lessonMaterial: lessonMaterial ?? defaultLessonMaterial(),
              communicationPreference: preference ?? null,
              style,
              length,
              generationPreferences: effectiveConfig.generationPreferences,
              plannerClient: planner.client,
              plannerModel: planner.model,
              writerClient: writer.client,
              writerModel: writer.model,
              referenceDate,
              checkpoint: checkpoint.success ? checkpoint.data : null,
              onCheckpoint: saveRestrictedCheckpoint,
              signal: input.signal,
            });
            composition = studentContentBriefGeneration.composition;
          } else {
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
              forbiddenStudentNames: classStudentNames,
              checkpoint: checkpoint.success ? checkpoint.data : null,
              onCheckpoint: saveRestrictedCheckpoint,
              signal: input.signal,
            });
            composition = restrictedGeneration.composition;
          }
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
                  ? studentContentBriefGeneration
                    ? "feedback-plan-v4-restricted-content-brief"
                    : "feedback-plan-v3-restricted"
                  : "feedback-plan-v3-free",
                modelRole: actualApproach === "restricted"
                  ? "feedbackReview"
                  : "feedbackDraft",
                inputRevision: String(plan.planRevision),
                variantKey: execution ? `feedback-plan-item:${item.id}:attempt:${execution.attempt}` : null,
                inputSnapshot: studentContentBriefGeneration ? {
                  generationApproach: "restricted",
                  requestedApproach: execution?.snapshot.requestedApproach,
                  contentBrief: studentContentBriefGeneration.contentBrief,
                  writerInput: studentContentBriefGeneration.writerInput,
                  generationConfig: effectiveConfig,
                  generationContext: { studentName, communicationPreference: preference ?? null, referenceDate },
                  planner: studentContentBriefGeneration.planner,
                  writer: studentContentBriefGeneration.writer,
                } : successfulRestrictedGeneration ? {
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
                  } : studentContentBriefGeneration ? {
                    planner: studentContentBriefGeneration.planner,
                    writer: studentContentBriefGeneration.writer,
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
