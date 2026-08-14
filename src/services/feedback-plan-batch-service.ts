import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import {
  FeedbackPlanBatchCreateSchema,
  type FeedbackPlanBatchCreateInput,
} from "@/lib/feedback-plan-batch";
import { FeedbackPlanAssessmentEvidenceSchema, type FeedbackPlanCreateInput } from "@/lib/feedback-plan";
import { prisma } from "@/lib/prisma";
import {
  continueFeedbackPlanGeneration,
  createFeedbackPlan,
  isFeedbackPlanGenerationRunning,
  pauseFeedbackPlanGeneration,
  retryFeedbackPlanGeneration,
  startFeedbackPlanGeneration,
} from "@/services/feedback-plan-service";

type BatchDb = PrismaClient | Prisma.TransactionClient;

const batchInclude = {
  semester: { select: { id: true, name: true } },
  sharedLessonRevision: { include: { groupLesson: { select: { id: true, title: true } } } },
  plans: {
    orderBy: { batchOrder: "asc" as const },
    include: {
      class: { select: { id: true, code: true, name: true } },
      session: { select: { id: true, code: true, date: true } },
      rangeStartSession: { select: { id: true, code: true, date: true } },
      rangeEndSession: { select: { id: true, code: true, date: true } },
      items: { select: { id: true, status: true, studentId: true } },
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

export function toFeedbackPlanBatchView<T extends {
  plans: Array<{ items: Array<{ id: string; status: string }> }>;
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
    return { ...plan, progress: { ...progress, exported: plan.items.filter((item) => batchExportedItemIds.has(item.id)).length } };
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
  const existing = await db.feedbackPlanBatch.findUnique({ where: { requestKey: input.requestKey }, include: batchInclude });
  if (existing) return toFeedbackPlanBatchView(existing);

  return db.$transaction(async (tx) => {
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
      if (run.planId) throw new ApiError("有班级的材料运行已经创建过反馈计划", 409, "conflict", false);
      return run;
    }));

    const revision = input.sharedLessonRevisionId
      ? await tx.groupLessonRevision.findUnique({
          where: { id: input.sharedLessonRevisionId },
          include: { groupLesson: { include: { group: { select: { id: true, semesterId: true } } } } },
        })
      : null;
    if (input.sharedLessonRevisionId && !revision) throw new ApiError("已确认共同课修订不存在", 404, "not_found", false);
    if (revision && (revision.groupLesson.group.semesterId !== input.semesterId || classes.some((item) => item.classGroupMembership?.groupId !== revision.groupLesson.group.id))) {
      throw new ApiError("共同课修订与所选班级不属于同一班级组", 409, "conflict", false);
    }
    if (revision && input.groupLessonId && revision.groupLessonId !== input.groupLessonId) {
      throw new ApiError("共同课修订与批次共同课不一致", 409, "conflict", false);
    }
    const sharedMaterial = revision ? LessonFeedbackMaterialSchema.parse(JSON.parse(revision.materialSnapshot)) : null;

    const batch = await tx.feedbackPlanBatch.create({
      data: {
        requestKey: input.requestKey,
        semesterId: input.semesterId,
        type: input.type,
        outputRequirement: input.outputRequirement,
        generationMode: input.generationMode,
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
        type: input.type,
        outputRequirement: input.outputRequirement,
        semesterId: input.semesterId,
        lessonMaterial,
        assessmentEvidence: intakeAssessmentEvidence ?? child.assessmentEvidence,
      };
      const plan = await createFeedbackPlan(planInput, tx);
      await tx.feedbackPlan.update({ where: { id: plan.id }, data: { batchId: batch.id, batchOrder: index + 1, generationMode: input.generationMode } });
      if (intakeRun) await tx.feedbackIntakeRun.update({ where: { id: intakeRun.id }, data: { planId: plan.id } });
    }
    const created = await tx.feedbackPlanBatch.findUnique({ where: { id: batch.id }, include: batchInclude });
    if (!created) throw new Error("反馈批次创建后无法读取");
    return toFeedbackPlanBatchView(created);
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
      if (["queued", "generating", "pause_requested"].includes(current.status)) await pauseFeedbackPlanGeneration(current.id, db);
      const runningItem = current.items.some((item) => item.status === "generating");
      if (current.status === "paused" || !runningItem) {
        await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "paused", currentPlanId: current.id, planRevision: { increment: 1 } } });
        return;
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

    await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "running", currentPlanId: current.id, failedPlanId: null } });
    if (current.status === "paused") {
      await continueFeedbackPlanGeneration(current.id, db);
    } else if (["queued", "generating", "pause_requested"].includes(current.status)) {
      if (!isFeedbackPlanGenerationRunning(current.id)) await continueFeedbackPlanGeneration(current.id, db);
    } else {
      await startFeedbackPlanGeneration({ planId: current.id, generationMode: batch.generationMode === "fast" ? "fast" : "standard" }, db);
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

export async function startFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma) {
  const batch = await db.feedbackPlanBatch.findUnique({ where: { id: batchId }, include: { plans: { orderBy: { batchOrder: "asc" }, select: { id: true } } } });
  if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  if (batch.archivedAt) throw new ApiError("已归档反馈批次不能启动", 409, "conflict", false);
  if (batch.status === "completed") return { accepted: true, status: "completed" };
  const currentPlanId = batch.currentPlanId ?? batch.plans[0]?.id;
  await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "queued", currentPlanId, failedPlanId: null, planRevision: { increment: 1 } } });
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
  await retryFeedbackPlanGeneration({ planId: batch.failedPlanId }, db);
  await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "running", currentPlanId: batch.failedPlanId, failedPlanId: null, planRevision: { increment: 1 } } });
  void startBatchJob(batchId, db);
  return { accepted: true, status: "running" };
}

export async function archiveFeedbackPlanBatch(batchId: string, db: PrismaClient = prisma) {
  const batch = await db.feedbackPlanBatch.findUnique({ where: { id: batchId }, select: { status: true } });
  if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  if (["queued", "running", "pause_requested"].includes(batch.status)) throw new ApiError("运行中的批次不能归档，请先暂停", 409, "conflict", false);
  await db.feedbackPlanBatch.update({ where: { id: batchId }, data: { status: "archived", archivedAt: new Date(), planRevision: { increment: 1 } } });
  return { success: true };
}
