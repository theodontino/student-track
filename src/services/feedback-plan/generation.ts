import type { PrismaClient } from "@/generated/prisma/client";

import { ApiError } from "@/lib/api-errors";

import {
  createFeedbackGenerationExecutionSnapshot,
  normalizeStoredFeedbackGenerationApproach,
  parseFeedbackGenerationExecutionSnapshot,
  serializeFeedbackGenerationExecutionSnapshot,
  withExplicitFreeFeedbackFallback,
  type FeedbackGenerationApproach,
  type FeedbackGenerationExecutionSnapshotV1
} from "@/lib/feedback-generation-approach";

import {
  FeedbackEvidenceBundleSchema,
  FeedbackPlanInputSnapshotSchema,
  sanitizeFeedbackEvidenceBundle,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackPlanAssessmentEvidenceInput,
  type FeedbackPlanCreateInput
} from "@/lib/feedback-plan";

import { createLLMClient, getLLMModel } from "@/lib/llm";

import { prisma } from "@/lib/prisma";

import { generateFreeFeedbackPlanComposition } from "@/services/feedback-generation-service";

import { blockAuditForRestrictedWriter, createAuditSnapshot, sha256 } from "@/services/feedback-plan-audit";

import { activeTaskIds, auditIdentityForPlanItem, auditTaskIdsForBundle, defaultLessonMaterial, evidenceFromClassContext, evidenceFromStudent, findContextForPlan, normalizePlanAssessmentEvidence, persistedAssessmentEvidence } from "@/services/feedback-plan/evidence";

import { assertLegacyFeedbackGenerationAvailable, bundleForPlanConfig, derivePlanStatus, effectiveFeedbackPlanConfig, FeedbackPlanDb, feedbackPlanHasGenerationTrace, feedbackPlanItemHasGeneratedResult, generationPreferencesFromSnapshot, json, parseJson } from "@/services/feedback-plan/model";

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
