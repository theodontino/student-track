import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import {
  FeedbackPlanBatchCreateSchema,
  FeedbackPlanBatchDraftPatchSchema,
  FeedbackPlanBatchRenameSchema,
  type FeedbackPlanBatchCreateInput,
  type FeedbackPlanBatchDraftPatch,
  type FeedbackPlanBatchRename,
} from "@/lib/feedback-plan-batch";
import {
  FeedbackPlanInputSnapshotSchema,
  FeedbackPlanItemGenerationConfigSchema,
  FeedbackPlanAssessmentEvidenceSchema,
  normalizeFeedbackGenerationPreferences,
  type FeedbackPlanCreateInput,
  type FeedbackPlanItemGenerationConfig,
} from "@/lib/feedback-plan";
import { prisma } from "@/lib/prisma";
import {
  continueFeedbackPlanGeneration,
  cloneFeedbackPlanDraft,
  createFeedbackPlan,
  feedbackPlanHasGenerationTrace,
  isFeedbackPlanGenerationRunning,
  pauseFeedbackPlanGeneration,
  retryFeedbackPlanGeneration,
  startFeedbackPlanGeneration,
  updateFeedbackPlanDraft,
} from "@/services/feedback-plan-service";

type BatchDb = PrismaClient | Prisma.TransactionClient;

type FeedbackPlanBatchNameScope = {
  semesterId: string;
  plans: Array<{ classId: string; sessionId?: string | null; rangeEndSessionId?: string | null }>;
};

function feedbackPlanBatchScopeKey(plans: FeedbackPlanBatchNameScope["plans"]) {
  return plans
    .map((plan) => `${plan.classId}:${plan.sessionId ?? plan.rangeEndSessionId ?? ""}`)
    .sort()
    .join("|");
}

async function allocateFeedbackPlanBatchDisplayName(
  db: BatchDb,
  scope: FeedbackPlanBatchNameScope,
  requestedName: string,
  excludeBatchId?: string,
) {
  const baseName = requestedName.trim();
  const targetScope = feedbackPlanBatchScopeKey(scope.plans);
  const batches = await db.feedbackPlanBatch.findMany({
    where: {
      semesterId: scope.semesterId,
      displayName: { not: null },
      ...(excludeBatchId ? { id: { not: excludeBatchId } } : {}),
    },
    select: {
      displayName: true,
      plans: { select: { classId: true, sessionId: true, rangeEndSessionId: true } },
    },
  });
  const names = new Set(batches.flatMap((batch) => (
    batch.displayName && feedbackPlanBatchScopeKey(batch.plans) === targetScope ? [batch.displayName] : []
  )));
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName} ${suffix}`)) suffix += 1;
  return `${baseName} ${suffix}`;
}

const batchInclude = {
  semester: { select: { id: true, name: true } },
  sharedLessonRevision: { include: { groupLesson: { select: { id: true, title: true } } } },
  plans: {
    orderBy: { batchOrder: "asc" as const },
    include: {
      class: { select: { id: true, code: true, name: true } },
      session: { select: { id: true, code: true, date: true, groupLessonSession: { select: { groupLessonId: true } } } },
      rangeStartSession: { select: { id: true, code: true, date: true } },
      rangeEndSession: { select: { id: true, code: true, date: true, groupLessonSession: { select: { groupLessonId: true } } } },
      items: {
        orderBy: { createdAt: "asc" as const },
        select: {
          id: true,
          status: true,
          studentId: true,
          generationConfigSnapshot: true,
          student: { select: { id: true, name: true, studentId: true } },
        },
      },
    },
  },
  exportRuns: { orderBy: { createdAt: "desc" as const } },
} as const;

function itemCounts(items: Array<{ status: string }>) {
  const count = (statuses: string[]) => items.filter((item) => statuses.includes(item.status)).length;
  return {
    total: items.length,
    queued: count(["queued"]),
    running: count(["generating"]),
    generated: count(["needs_review", "approved", "exported"]),
    approved: count(["approved", "exported"]),
    exported: count(["exported"]),
    failed: count(["generation_failed"]),
  };
}

function itemConfigFromSnapshot(snapshot: string): FeedbackPlanItemGenerationConfig | null | undefined {
  try {
    const value = JSON.parse(snapshot) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return null;
    const parsed = FeedbackPlanItemGenerationConfigSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function frozenStudentIdsFromPlan(plan: {
  inputSnapshot: string;
  items: Array<{ studentId: string | null }>;
}) {
  try {
    const snapshot = FeedbackPlanInputSnapshotSchema.safeParse(JSON.parse(plan.inputSnapshot));
    if (snapshot.success && snapshot.data.version === 2) {
      return snapshot.data.factSnapshot.items.flatMap((item) => item.studentId ? [item.studentId] : []);
    }
  } catch { /* V1 or malformed historical snapshots fall back to their current frozen items */ }
  return plan.items.flatMap((item) => item.studentId ? [item.studentId] : []);
}

export function toFeedbackPlanBatchView<T extends {
  plans: Array<{
    type: string;
    inputSnapshot: string;
    items: Array<{ id: string; status: string; generationConfigSnapshot?: string }>;
  }>;
  exportRuns: Array<{ itemManifest: string }>;
}>(batch: T) {
  const batchExportedItemIds = new Set<string>();
  for (const run of batch.exportRuns) {
    try {
      const entries = JSON.parse(run.itemManifest) as Array<{ itemId?: unknown }>;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (typeof entry.itemId === "string") batchExportedItemIds.add(entry.itemId);
      }
    } catch { /* malformed historical ledgers do not count as exported */ }
  }
  const plans = batch.plans.map((plan) => {
    const progress = itemCounts(plan.items);
    let parsedInput: unknown = null;
    try {
      const candidate = FeedbackPlanInputSnapshotSchema.safeParse(JSON.parse(plan.inputSnapshot));
      if (candidate.success) parsedInput = candidate.data;
    } catch { /* malformed historical snapshots remain visible through inputSnapshot */ }
    return {
      ...plan,
      input: parsedInput,
      items: plan.items.map((item) => ({
        ...item,
        generationConfig: item.generationConfigSnapshot === undefined
          ? undefined
          : itemConfigFromSnapshot(item.generationConfigSnapshot) ?? null,
      })),
      progress: {
        ...progress,
        exported: plan.items.filter((item) => batchExportedItemIds.has(item.id)).length,
      },
    };
  });
  const totals = itemCounts(batch.plans.flatMap((plan) => plan.items));
  totals.exported = batchExportedItemIds.size;
  return { ...batch, plans, progress: { ...totals, completedClasses: plans.filter((plan) => plan.progress.failed === 0 && plan.progress.generated === plan.progress.total).length, totalClasses: plans.length } };
}

export async function getFeedbackPlanBatch(id: string, db: BatchDb = prisma) {
  const batch = await db.feedbackPlanBatch.findUnique({ where: { id }, include: batchInclude });
  return batch ? toFeedbackPlanBatchView(batch) : null;
}

export async function listFeedbackPlanBatches(input: { semesterId?: string; archived?: boolean }, db: BatchDb = prisma) {
  const batches = await db.feedbackPlanBatch.findMany({
    where: {
      ...(input.semesterId ? { semesterId: input.semesterId } : {}),
      ...(input.archived === true ? { archivedAt: { not: null } } : input.archived === false ? { archivedAt: null } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: batchInclude,
  });
  return batches.map(toFeedbackPlanBatchView);
}

export async function createFeedbackPlanBatch(raw: FeedbackPlanBatchCreateInput, db: PrismaClient = prisma) {
  const input = FeedbackPlanBatchCreateSchema.parse(raw);
  const batchGenerationPreferences = normalizeFeedbackGenerationPreferences(input.type, input.generationPreferences);
  const existing = await db.feedbackPlanBatch.findUnique({ where: { requestKey: input.requestKey }, include: batchInclude });
  if (existing && !existing.archivedAt) {
    if (existing.basedOnBatchId !== (input.basedOnBatchId ?? null)) {
      throw new ApiError("反馈批次请求标识已用于另一条计划修订", 409, "conflict", false);
    }
    return toFeedbackPlanBatchView(existing);
  }

  // An archived batch is historical data, not an idempotency hit for a new run.
  // The request key is unique, so use a fresh key while preserving the old batch.
  const batchRequestKey = existing?.archivedAt ? randomUUID() : input.requestKey;

  try {
    return await db.$transaction(async (tx) => {
    const semester = await tx.semester.findUnique({ where: { id: input.semesterId }, select: { id: true } });
    if (!semester) throw new ApiError("学期不存在", 404, "not_found", false);
    const classes = await tx.class.findMany({
      where: { id: { in: input.plans.map((plan) => plan.classId) } },
      select: { id: true, semesterId: true, classGroupMembership: { select: { groupId: true } } },
    });
    if (classes.length !== input.plans.length) throw new ApiError("有班级不存在", 404, "not_found", false);
    if (classes.some((item) => item.semesterId !== input.semesterId)) {
      throw new ApiError("反馈批次只能包含同一学期的班级", 409, "conflict", false);
    }
    const sourceBatch = input.basedOnBatchId
      ? await tx.feedbackPlanBatch.findUnique({
          where: { id: input.basedOnBatchId },
          select: { id: true, semesterId: true, type: true, plans: { select: { id: true, classId: true } } },
        })
      : null;
    if (input.basedOnBatchId && !sourceBatch) throw new ApiError("来源反馈批次不存在", 404, "not_found", false);
    if (sourceBatch && (sourceBatch.semesterId !== input.semesterId || sourceBatch.type !== input.type)) {
      throw new ApiError("来源反馈批次与当前学期或反馈类型不一致", 409, "conflict", false);
    }
    const sourcePlanByClassId = new Map(sourceBatch?.plans.map((plan) => [plan.classId, plan.id]) ?? []);
    if (sourceBatch && input.plans.some((plan) => !sourcePlanByClassId.has(plan.classId))) {
      throw new ApiError("当前事实修订不能加入来源批次之外的班级", 409, "conflict", false);
    }

    const childSessions = await Promise.all(input.plans.map(async (child) => {
      const sessionRef = child.sessionId ?? child.rangeEndSessionId;
      if (!sessionRef) return null;
      return tx.classSession.findFirst({
        where: { OR: [{ id: sessionRef }, { code: sessionRef }] },
        select: {
          id: true,
          code: true,
          classId: true,
          groupLessonSession: { select: { groupLessonId: true } },
        },
      });
    }));
    input.plans.forEach((child, index) => {
      const session = childSessions[index];
      if (session && session.classId !== child.classId) {
        throw new ApiError("反馈批次课次与班级不一致", 409, "conflict", false);
      }
      if ((input.groupLessonId || child.intakeRunId) && !session) {
        throw new ApiError("班级组反馈必须为每个班指定真实课次", 409, "conflict", false);
      }
      if (input.groupLessonId && session?.groupLessonSession?.groupLessonId !== input.groupLessonId) {
        throw new ApiError("反馈批次中的课次不属于同一共同课", 409, "conflict", false);
      }
    });

    const intakeRuns = await Promise.all(input.plans.map(async (child, index) => {
      if (!child.intakeRunId) return null;
      const run = await tx.feedbackIntakeRun.findUnique({ where: { id: child.intakeRunId } });
      if (!run) throw new ApiError("有班级的材料运行不存在", 404, "not_found", false);
      if (run.status !== "applied") throw new ApiError("有班级尚未确认课堂事实", 409, "conflict", false);
      if (run.sessionCode !== childSessions[index]?.code) throw new ApiError("材料运行与目标课次不一致", 409, "conflict", false);
      // planId is a legacy convenience pointer, not exclusive ownership.
      // The same confirmed run can seed several independently versioned plans.
      return run;
    }));

    const revision = input.sharedLessonRevisionId
      ? await tx.groupLessonRevision.findUnique({
          where: { id: input.sharedLessonRevisionId },
          include: { groupLesson: { include: { group: { select: { id: true, semesterId: true } } } } },
        })
      : null;
    if (input.sharedLessonRevisionId && !revision) throw new ApiError("已确认共同课修订不存在", 404, "not_found", false);
    if (revision && (
      revision.groupLesson.group.semesterId !== input.semesterId
      || (!input.groupLessonId && classes.some((item) => item.classGroupMembership?.groupId !== revision.groupLesson.group.id))
    )) {
      throw new ApiError("共同课修订与所选班级不属于同一班级组", 409, "conflict", false);
    }
    if (revision && input.groupLessonId && revision.groupLessonId !== input.groupLessonId) {
      throw new ApiError("共同课修订与批次共同课不一致", 409, "conflict", false);
    }
    const sharedMaterial = revision ? LessonFeedbackMaterialSchema.parse(JSON.parse(revision.materialSnapshot)) : null;

    const displayName = input.basedOnBatchId && input.displayName === undefined
      ? null
      : await allocateFeedbackPlanBatchDisplayName(tx, {
          semesterId: input.semesterId,
          plans: input.plans.map((child, index) => ({
            classId: child.classId,
            sessionId: childSessions[index]?.id,
            rangeEndSessionId: child.rangeEndSessionId,
          })),
        }, input.displayName ?? "初版计划");
    const batch = await tx.feedbackPlanBatch.create({
      data: {
        requestKey: batchRequestKey,
        displayName,
        basedOnBatchId: input.basedOnBatchId,
        semesterId: input.semesterId,
        type: input.type,
        outputRequirement: input.outputRequirement,
        generationMode: input.generationMode,
        status: "draft",
        sharedLessonRevisionId: revision?.id,
      },
    });
    for (const [index, child] of input.plans.entries()) {
      const session = childSessions[index];
      const intakeRun = intakeRuns[index];
      let intakeAssessmentEvidence: FeedbackPlanCreateInput["assessmentEvidence"];
      if (intakeRun) {
        try {
          const snapshot = JSON.parse(intakeRun.appliedSummary) as { assessmentEvidence?: Record<string, unknown> };
          const parsed = FeedbackPlanAssessmentEvidenceSchema.safeParse(snapshot.assessmentEvidence);
          if (parsed.success) intakeAssessmentEvidence = parsed.data;
        } catch { /* malformed historical summaries do not add assessment evidence */ }
      }
      const lessonMaterial = sharedMaterial
        ? { ...sharedMaterial, ...(session?.code ? { sessionCode: session.code } : {}) }
        : child.lessonMaterial;
      const planInput: FeedbackPlanCreateInput = {
        ...child,
        displayName: null,
        type: input.type,
        outputRequirement: child.outputRequirement ?? input.outputRequirement,
        semesterId: input.semesterId,
        ...(intakeRun ? { intakeRunIds: [intakeRun.id] } : {}),
        lessonMaterial,
        assessmentEvidence: intakeAssessmentEvidence ?? child.assessmentEvidence,
      };
      const createdPlan = await createFeedbackPlan(planInput, tx, { withinTransaction: true });
      const parsedPlanInput = FeedbackPlanInputSnapshotSchema.safeParse(JSON.parse(createdPlan.inputSnapshot));
      const inputSnapshot = parsedPlanInput.success && parsedPlanInput.data.version === 2
        ? JSON.stringify({ ...parsedPlanInput.data, batchGenerationPreferences })
        : createdPlan.inputSnapshot;
      const planId = createdPlan.id;
      await tx.feedbackPlan.update({
        where: { id: planId },
        data: {
          batchId: batch.id,
          batchOrder: index + 1,
          basedOnPlanId: sourcePlanByClassId.get(child.classId),
          generationMode: input.generationMode,
          inputSnapshot,
        },
      });
      // Keep the old pointer useful for callers that still expect it, without
      // stealing an intake run from an earlier plan.
      if (intakeRun && !intakeRun.planId) {
        await tx.feedbackIntakeRun.updateMany({ where: { id: intakeRun.id, planId: null }, data: { planId } });
      }
    }
    const created = await tx.feedbackPlanBatch.findUnique({ where: { id: batch.id }, include: batchInclude });
    if (!created) throw new Error("反馈批次创建后无法读取");
      return toFeedbackPlanBatchView(created);
    });
  } catch (error) {
    if (batchRequestKey === input.requestKey) {
      const raced = await db.feedbackPlanBatch.findUnique({ where: { requestKey: input.requestKey }, include: batchInclude });
      if (raced && !raced.archivedAt) {
        if (raced.basedOnBatchId !== (input.basedOnBatchId ?? null)) {
          throw new ApiError("反馈批次请求标识已用于另一条计划修订", 409, "conflict", false);
        }
        return toFeedbackPlanBatchView(raced);
      }
    }
    throw error;
  }
}

export async function updateFeedbackPlanBatchDraft(
  batchId: string,
  rawPatch: FeedbackPlanBatchDraftPatch,
  db: PrismaClient = prisma,
) {
  const patch = FeedbackPlanBatchDraftPatchSchema.parse(rawPatch);
  return db.$transaction(async (tx) => {
    const batch = await tx.feedbackPlanBatch.findUnique({
      where: { id: batchId },
      include: {
        plans: {
          orderBy: { batchOrder: "asc" },
          include: {
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
        },
      },
    });
    if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
    if (batch.archivedAt) throw new ApiError("已归档反馈批次为只读，请先取消归档", 409, "conflict", false);
    if (batch.planRevision !== patch.expectedPlanRevision) {
      throw new ApiError("反馈批次已被其他操作更新，请刷新后重试", 409, "conflict", false);
    }
    const generationStarted = !["draft", "ready"].includes(batch.status)
      || batch.plans.some((plan) => Boolean(plan.generationStartedAt || plan.generationCompletedAt)
        || plan.items.some((item) => item.status !== "evidence_ready"
          || Boolean(item.finalText || item.selectedGenerationId || item.approvedAt || item.exportedAt)));
    if (generationStarted) {
      throw new ApiError("反馈批次已经开始生成；可以重命名，修改计划请基于当前批次新建修订", 409, "conflict", false);
    }

    const planByClassId = new Map(batch.plans.map((plan) => [plan.classId, plan]));
    if (patch.studentSelections.length !== batch.plans.length) {
      throw new ApiError("学生范围必须完整包含批次中的每个班级", 400, "invalid_request", false);
    }
    const selectionByClassId = new Map(patch.studentSelections.map((selection) => [selection.classId, selection]));
    const studentPlanById = new Map<string, (typeof batch.plans)[number]>();
    for (const plan of batch.plans) {
      const selection = selectionByClassId.get(plan.classId);
      if (!selection) {
        throw new ApiError("学生范围必须完整包含批次中的每个班级", 400, "invalid_request", false);
      }
      const frozenStudentIds = new Set(frozenStudentIdsFromPlan(plan));
      for (const studentId of selection.studentIds) {
        if (!frozenStudentIds.has(studentId)) {
          throw new ApiError("所选学生不在对应班级计划冻结的事实范围内", 409, "conflict", false);
        }
        if (studentPlanById.has(studentId)) {
          throw new ApiError("同一学生不能出现在多个班级计划中", 409, "conflict", false);
        }
        studentPlanById.set(studentId, plan);
      }
    }
    for (const override of patch.classOverrides) {
      if (!planByClassId.has(override.classId)) {
        throw new ApiError("班级例外不属于当前反馈批次", 400, "invalid_request", false);
      }
    }
    for (const override of patch.studentOverrides) {
      if (!studentPlanById.has(override.studentId)) {
        throw new ApiError("学生独立计划不属于当前反馈批次", 400, "invalid_request", false);
      }
    }

    const classOverrideById = new Map(patch.classOverrides.map((override) => [override.classId, override]));
    for (const plan of batch.plans) {
      const classOverride = classOverrideById.get(plan.classId);
      const selection = selectionByClassId.get(plan.classId)!;
      const studentOverrides = patch.studentOverrides.filter((override) => studentPlanById.get(override.studentId)?.id === plan.id);
      const updatedPlan = await updateFeedbackPlanDraft(plan.id, {
        expectedPlanRevision: plan.planRevision,
        outputRequirement: classOverride?.outputRequirement ?? patch.outputRequirement,
        generationMode: patch.generationMode,
        studentIds: selection.studentIds,
        generationPreferences: classOverride?.generationPreferences ?? patch.generationPreferences,
        studentOverrides,
      }, tx, { allowBatchDraftUpdate: true });
      const parsedPlanInput = FeedbackPlanInputSnapshotSchema.safeParse(JSON.parse(updatedPlan.inputSnapshot));
      if (parsedPlanInput.success && parsedPlanInput.data.version === 2) {
        await tx.feedbackPlan.update({
          where: { id: plan.id },
          data: { inputSnapshot: JSON.stringify({ ...parsedPlanInput.data, batchGenerationPreferences: patch.generationPreferences }) },
        });
      }
    }

    const displayName = patch.displayName === undefined
      ? batch.displayName
      : await allocateFeedbackPlanBatchDisplayName(tx, {
        semesterId: batch.semesterId,
        plans: batch.plans,
      }, patch.displayName, batch.id);

    const updated = await tx.feedbackPlanBatch.updateMany({
      where: { id: batchId, planRevision: patch.expectedPlanRevision },
      data: {
        ...(patch.displayName !== undefined ? { displayName } : {}),
        outputRequirement: patch.outputRequirement,
        generationMode: patch.generationMode,
        status: "draft",
        currentPlanId: null,
        failedPlanId: null,
        planRevision: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new ApiError("反馈批次已被其他操作更新，请刷新后重试", 409, "conflict", false);
    const result = await tx.feedbackPlanBatch.findUnique({ where: { id: batchId }, include: batchInclude });
    if (!result) throw new ApiError("反馈批次不存在", 404, "not_found", false);
    return toFeedbackPlanBatchView(result);
  });
}

export async function renameFeedbackPlanBatch(
  batchId: string,
  rawInput: FeedbackPlanBatchRename,
  db: PrismaClient = prisma,
) {
  const input = FeedbackPlanBatchRenameSchema.parse(rawInput);
  const current = await db.feedbackPlanBatch.findUnique({ where: { id: batchId }, select: { id: true, planRevision: true } });
  if (!current) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  if (input.expectedPlanRevision && current.planRevision !== input.expectedPlanRevision) {
    throw new ApiError("反馈批次已被其他操作更新，请刷新后重试", 409, "conflict", false);
  }
  const scope = await db.feedbackPlanBatch.findUnique({
    where: { id: batchId },
    select: { semesterId: true, plans: { select: { classId: true, sessionId: true, rangeEndSessionId: true } } },
  });
  if (!scope) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  const displayName = await allocateFeedbackPlanBatchDisplayName(db, scope, input.displayName, batchId);
  const updated = await db.feedbackPlanBatch.updateMany({
    where: { id: batchId, ...(input.expectedPlanRevision ? { planRevision: input.expectedPlanRevision } : {}) },
    data: { displayName, planRevision: { increment: 1 } },
  });
  if (updated.count !== 1) throw new ApiError("反馈批次已被其他操作更新，请刷新后重试", 409, "conflict", false);
  const result = await getFeedbackPlanBatch(batchId, db);
  if (!result) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  return result;
}

export async function cloneFeedbackPlanBatchDraft(
  input: { batchId: string; displayName?: string },
  db: PrismaClient = prisma,
) {
  return db.$transaction(async (tx) => {
    const source = await tx.feedbackPlanBatch.findUnique({
      where: { id: input.batchId },
      include: { plans: { orderBy: { batchOrder: "asc" } } },
    });
    if (!source) throw new ApiError("反馈批次不存在", 404, "not_found", false);
    if (!source.plans.length) throw new ApiError("反馈批次没有可复制的班级计划", 409, "conflict", false);
    const displayName = input.displayName
      ? await allocateFeedbackPlanBatchDisplayName(tx, {
        semesterId: source.semesterId,
        plans: source.plans,
      }, input.displayName)
      : null;
    const createdBatch = await tx.feedbackPlanBatch.create({
      data: {
        requestKey: randomUUID(),
        displayName,
        semesterId: source.semesterId,
        type: source.type,
        outputRequirement: source.outputRequirement,
        generationMode: source.generationMode,
        status: "draft",
        sharedLessonRevisionId: source.sharedLessonRevisionId,
        basedOnBatchId: source.id,
      },
    });
    for (const [index, sourcePlan] of source.plans.entries()) {
      const clonedPlan = await cloneFeedbackPlanDraft({ planId: sourcePlan.id }, tx, { allowBatchClone: true });
      await tx.feedbackPlan.update({
        where: { id: clonedPlan.id },
        data: { batchId: createdBatch.id, batchOrder: index + 1 },
      });
    }
    const result = await tx.feedbackPlanBatch.findUnique({ where: { id: createdBatch.id }, include: batchInclude });
    if (!result) throw new ApiError("反馈批次修订创建后无法读取", 500, "internal_error", true);
    return toFeedbackPlanBatchView(result);
  });
}

const batchJobs = new Map<string, Promise<void>>();
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runBatchJob(batchId: string, db: PrismaClient = prisma) {
  while (true) {
    const batch = await db.feedbackPlanBatch.findUnique({
      where: { id: batchId },
      include: { plans: { orderBy: { batchOrder: "asc" }, include: { items: { select: { status: true } } } } },
    });
    if (!batch || batch.archivedAt || ["archived", "completed", "failed", "paused"].includes(batch.status)) return;
    const current = batch.plans.find((plan) => plan.id === batch.currentPlanId)
      ?? batch.plans.find((plan) => plan.items.some((item) => !["needs_review", "approved", "exported"].includes(item.status)));
    if (!current) {
      await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "completed", currentPlanId: null, failedPlanId: null, planRevision: { increment: 1 } } });
      return;
    }

    if (batch.status === "pause_requested") {
      if (["queued", "generating", "pause_requested"].includes(current.status)) {
        await pauseFeedbackPlanGeneration(current.id, db, { allowBatchControl: true });
      }
      const refreshed = await db.feedbackPlan.findUnique({
        where: { id: current.id },
        select: { status: true, items: { select: { status: true } } },
      });
      const childIsActive = Boolean(refreshed && (
        ["queued", "generating", "pause_requested"].includes(refreshed.status)
        || refreshed.items.some((item) => ["queued", "generating"].includes(item.status))
      ));
      if (refreshed && !childIsActive) {
        const paused = await db.feedbackPlanBatch.updateMany({
          where: { id: batchId, status: "pause_requested" },
          data: { status: "paused", currentPlanId: current.id, planRevision: { increment: 1 } },
        });
        if (paused.count === 1) return;
      }
      await wait(150);
      continue;
    }

    if (current.items.some((item) => item.status === "generation_failed")) {
      await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "failed", currentPlanId: current.id, failedPlanId: current.id, planRevision: { increment: 1 } } });
      return;
    }
    const finished = current.items.every((item) => ["needs_review", "approved", "exported"].includes(item.status));
    if (finished) {
      const next = batch.plans.find((plan) => (plan.batchOrder ?? 0) > (current.batchOrder ?? 0));
      if (!next) {
        await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "completed", currentPlanId: null, failedPlanId: null, planRevision: { increment: 1 } } });
        return;
      }
      await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { currentPlanId: next.id, planRevision: { increment: 1 } } });
      continue;
    }

    const claimed = await db.feedbackPlanBatch.updateMany({
      where: {
        id: batchId,
        archivedAt: null,
        status: { in: ["queued", "running"] },
        planRevision: batch.planRevision,
      },
      data: { status: "running", currentPlanId: current.id, failedPlanId: null },
    });
    if (!claimed.count) continue;
    if (current.status === "paused") {
      await continueFeedbackPlanGeneration(current.id, db, { allowBatchControl: true });
    } else if (["queued", "generating", "pause_requested"].includes(current.status)) {
      if (!isFeedbackPlanGenerationRunning(current.id)) {
        await continueFeedbackPlanGeneration(current.id, db, { allowBatchControl: true });
      }
    } else {
      await startFeedbackPlanGeneration(
        { planId: current.id, generationMode: batch.generationMode === "fast" ? "fast" : "standard" },
        db,
        { allowBatchStart: true },
      );
    }
    await wait(150);
  }
}

function startBatchJob(batchId: string, db: PrismaClient = prisma) {
  const existing = batchJobs.get(batchId);
  if (existing) return existing;
  const job = runBatchJob(batchId, db).finally(() => batchJobs.delete(batchId));
  batchJobs.set(batchId, job);
  void job.catch(async () => {
    await db.feedbackPlanBatch.updateMany({ where: { id: batchId, status: { in: ["queued", "running"] } }, data: { status: "failed", planRevision: { increment: 1 } } }).catch(() => undefined);
  });
  return job;
}

export async function startFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma, expectedPlanRevision?: number) {
  const batch = await db.feedbackPlanBatch.findUnique({
    where: { id: batchId },
    include: {
      plans: {
        orderBy: { batchOrder: "asc" },
        select: {
          id: true,
          status: true,
          generationStartedAt: true,
          generationCompletedAt: true,
          items: {
            select: {
              status: true,
              finalText: true,
              selectedGenerationId: true,
              approvedAt: true,
              exportedAt: true,
            },
          },
        },
      },
    },
  });
  if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  if (batch.archivedAt) throw new ApiError("已归档反馈批次不能启动", 409, "conflict", false);
  if (expectedPlanRevision && expectedPlanRevision !== batch.planRevision) {
    throw new ApiError("反馈批次已被其他操作更新，请刷新后重试", 409, "conflict", false);
  }
  if (batch.basedOnBatchId && !batch.displayName) {
    throw new ApiError("请先为修正批次命名，再开始生成", 409, "conflict", false);
  }
  if (batch.status === "completed") return { accepted: true, status: "completed" };
  if (batchJobs.has(batchId) && ["queued", "running", "pause_requested"].includes(batch.status)) {
    return { accepted: true, status: batch.status };
  }
  if (!["draft", "ready"].includes(batch.status) || batch.plans.some(feedbackPlanHasGenerationTrace)) {
    throw new ApiError("当前班级组计划已经启动；请继续、重试，或建立修正计划", 409, "conflict", false);
  }
  const currentPlanId = batch.currentPlanId ?? batch.plans[0]?.id;
  if (!currentPlanId) throw new ApiError("反馈批次没有可生成的班级计划", 409, "conflict", false);
  const frozen = await db.feedbackPlanBatch.updateMany({
    where: {
      id: batchId,
      archivedAt: null,
      status: { in: ["draft", "ready"] },
      planRevision: batch.planRevision,
    },
    data: { status: "queued", currentPlanId, failedPlanId: null, planRevision: { increment: 1 } },
  });
  if (frozen.count !== 1) throw new ApiError("反馈批次已被其他操作更新，请刷新后重试", 409, "conflict", false);
  void startBatchJob(batchId, db);
  return { accepted: true, status: "queued" };
}

export async function pauseFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma) {
  const updated = await db.feedbackPlanBatch.updateMany({ where: { id: batchId, archivedAt: null, status: { in: ["queued", "running"] } }, data: { status: "pause_requested", planRevision: { increment: 1 } } });
  if (!updated.count) throw new ApiError("当前批次不能暂停", 409, "conflict", false);
  void startBatchJob(batchId, db);
  return { accepted: true, status: "pause_requested" };
}

export async function continueFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma) {
  const batch = await db.feedbackPlanBatch.findUnique({ where: { id: batchId }, select: { status: true, archivedAt: true } });
  if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  if (batch.archivedAt || batch.status === "archived") throw new ApiError("已归档反馈批次不能继续", 409, "conflict", false);
  if (!["paused", "queued", "running", "pause_requested"].includes(batch.status)) throw new ApiError("当前批次不能继续", 409, "conflict", false);
  await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "queued", planRevision: { increment: 1 } } });
  void startBatchJob(batchId, db);
  return { accepted: true, status: "queued" };
}

export async function retryFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma) {
  const batch = await db.feedbackPlanBatch.findUnique({ where: { id: batchId }, select: { failedPlanId: true, archivedAt: true, status: true } });
  if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  if (batch.archivedAt || batch.status !== "failed" || !batch.failedPlanId) throw new ApiError("当前批次没有可重试的失败班级", 409, "conflict", false);
  await retryFeedbackPlanGeneration({ planId: batch.failedPlanId }, db, { allowBatchControl: true });
  await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "running", currentPlanId: batch.failedPlanId, failedPlanId: null, planRevision: { increment: 1 } } });
  void startBatchJob(batchId, db);
  return { accepted: true, status: "running" };
}

export async function archiveFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma) {
  await db.$transaction(async (tx) => {
    const batch = await tx.feedbackPlanBatch.findUnique({
      where: { id: batchId },
      select: {
        status: true,
        plans: { select: { status: true, items: { select: { status: true } } } },
      },
    });
    if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
    if (["queued", "running", "pause_requested"].includes(batch.status)) throw new ApiError("运行中的批次不能归档，请先暂停", 409, "conflict", false);
    const activeChild = batch.plans.some((plan) => (
      ["queued", "generating", "pause_requested"].includes(plan.status)
      || plan.items.some((item) => ["queued", "generating"].includes(item.status))
    ));
    if (activeChild) throw new ApiError("仍有班级正在生成，完成暂停后才能归档", 409, "conflict", false);
    const archivedAt = new Date();
    await tx.feedbackPlan.updateMany({
      where: { batchId, archivedAt: null },
      data: { archivedAt, planRevision: { increment: 1 } },
    });
    await tx.feedbackPlanBatch.update({
      where: { id: batchId },
      data: { status: "archived", archivedAt, planRevision: { increment: 1 } },
    });
  });
  return { success: true };
}

export async function unarchiveFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const batch = await tx.feedbackPlanBatch.findUnique({
      where: { id: batchId },
      include: {
        plans: {
          orderBy: { batchOrder: "asc" },
          include: {
            items: {
              select: {
                status: true,
                finalText: true,
                selectedGenerationId: true,
                approvedAt: true,
                exportedAt: true,
              },
            },
          },
        },
      },
    });
    if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
    if (!batch.archivedAt && batch.status !== "archived") {
      const current = await tx.feedbackPlanBatch.findUnique({ where: { id: batchId }, include: batchInclude });
      if (!current) throw new ApiError("反馈批次不存在", 404, "not_found", false);
      return toFeedbackPlanBatchView(current);
    }
    if (!batch.plans.length) throw new ApiError("反馈批次没有可恢复的班级计划", 409, "conflict", false);

    const failedPlan = batch.plans.find((plan) => plan.items.some((item) => item.status === "generation_failed"));
    const completeStatuses = new Set(["needs_review", "approved", "exported"]);
    const allCompleted = batch.plans.every((plan) => (
      plan.items.length > 0 && plan.items.every((item) => completeStatuses.has(item.status))
    ));
    const firstIncomplete = batch.plans.find((plan) => (
      !plan.items.length || plan.items.some((item) => !completeStatuses.has(item.status))
    ));
    const hasGenerationTrace = batch.plans.some((plan) => (
      Boolean(plan.generationStartedAt || plan.generationCompletedAt)
      || plan.items.some((item) => (
        Boolean(item.finalText || item.selectedGenerationId || item.approvedAt || item.exportedAt)
        || ["queued", "generating", "pause_requested", "paused", "generation_failed", "needs_review", "approved", "exported"].includes(item.status)
      ))
    ));
    const status = failedPlan ? "failed" : allCompleted ? "completed" : hasGenerationTrace ? "paused" : "draft";
    const currentPlanId = allCompleted ? null : (failedPlan?.id ?? firstIncomplete?.id ?? batch.plans[0]!.id);

    await tx.feedbackPlan.updateMany({
      where: { batchId, archivedAt: { not: null } },
      data: { archivedAt: null, planRevision: { increment: 1 } },
    });
    await tx.feedbackPlanBatch.update({
      where: { id: batchId },
      data: {
        archivedAt: null,
        status,
        currentPlanId,
        failedPlanId: failedPlan?.id ?? null,
        planRevision: { increment: 1 },
      },
    });
    const restored = await tx.feedbackPlanBatch.findUnique({ where: { id: batchId }, include: batchInclude });
    if (!restored) throw new ApiError("反馈批次不存在", 404, "not_found", false);
    return toFeedbackPlanBatchView(restored);
  });
}
