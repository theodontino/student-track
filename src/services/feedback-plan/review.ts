import { assertStudentPlanWritable, isHistoricalStudentPlan, parseStudentContext } from "./model";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import {
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  FeedbackPlanItemPatchSchema,
  isHardFeedbackAuditIssue,
  RESTRICTED_WRITER_OUTPUT_INVALID_CODE,
  sanitizeFeedbackComposition,
  type FeedbackPlanItemPatch
} from "@/lib/feedback-plan";
import { stripFeedbackInternalBoundary } from "@/lib/feedback-text-safety";
import { prisma } from "@/lib/prisma";
import {
  assertFeedbackPlanAvailable
} from "@/services/academic-scope-recycle-service";
import { blockAuditForRestrictedWriter, createAuditSnapshot, sha256 } from "@/services/feedback-plan-audit";
import { auditIdentityForPlanItem, auditTaskIdsForBundle } from "@/services/feedback-plan/evidence";
import { bundleForPlanConfig, derivePlanStatus, effectiveFeedbackPlanConfig, feedbackPlanHasGenerationTrace, json, normalizedCoverageText, normalizeStudentGenerationConfig, parseCompositionSnapshot, parseGenerationConfigSnapshot, parseJson, restrictedWriterBlockerFromAuditSnapshot } from "@/services/feedback-plan/model";
import { getFeedbackPlan } from "@/services/feedback-plan/query";

export async function patchFeedbackPlanItem(id: string, rawPatch: FeedbackPlanItemPatch, db: PrismaClient = prisma) {
  const patch = FeedbackPlanItemPatchSchema.parse(rawPatch);
  const item = await db.feedbackPlanItem.findUnique({ include: { plan: { include: { batch: { select: { status: true, archivedAt: true } }, items: { include: { student: true } } } }, student: true, tasks: true } , where: { id } });
  if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  assertStudentPlanWritable(item.plan);
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
  const planState = await db.feedbackPlan.findUnique({ where: { id: input.planId }, select: { id: true, archivedAt: true, type: true, structureVersion: true } });
  if (!planState) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  assertStudentPlanWritable(planState);
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
  assertStudentPlanWritable(item.plan);
  if (item.plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (item.status !== "needs_review") throw new ApiError("只有待教师审核的反馈才能批准未来任务", 409, "conflict", false);
  if (!input.action.trim()) throw new ApiError("教师任务不能为空", 400, "invalid_request", false);
  if (input.dueType === "date" && !input.dueDate) throw new ApiError("日期任务缺少截止日期", 400, "invalid_request", false);
  let resolvedDueSessionId = input.dueSessionId;
  if (input.dueType === "session" && !resolvedDueSessionId) {
    const anchor = parseStudentContext(item.contextSnapshot)?.session ?? item.plan.rangeEndSession ?? item.plan.session;
    if (!anchor) throw new ApiError("没有可推断的后续课次，请选择日期或课次", 400, "invalid_request", false);
    const nextSession = await db.classSession.findFirst({
      where: {
        classId: (item.classId ?? item.plan.classId)!,
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
    const dueSession = await db.classSession.findFirst({ where: { id: resolvedDueSessionId, classId: (item.classId ?? item.plan.classId)!, semesterId: item.plan.semesterId }, select: { id: true, date: true, semesterNumber: true } });
    if (!dueSession) throw new ApiError("截止课次必须属于同一班级和学期", 400, "invalid_request", false);
    const anchor = parseStudentContext(item.contextSnapshot)?.session ?? item.plan.rangeEndSession ?? item.plan.session;
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
        classId: (item.classId ?? item.plan.classId)!,
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
    assertStudentPlanWritable(plan);
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
    const existing = await tx.teacherTask.findUnique({ where: { id }, select: { planId: true, plan: { select: { type: true, structureVersion: true } } } });
    if (!existing) throw new ApiError("教师任务不存在", 404, "not_found", false);
    await assertFeedbackPlanAvailable(existing.planId, tx);
    if (status === "pending") assertStudentPlanWritable(existing.plan);
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
    if (item && !isHistoricalStudentPlan(item.plan) && ["evidence_ready", "needs_review"].includes(item.status)) {
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
