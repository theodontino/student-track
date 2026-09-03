import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { createDatabaseBackup, verifyDatabaseBackup } from "@/services/database-backup-service";

export const RECYCLE_RETENTION_DAYS = 30;
export const RECYCLE_RETENTION_MS = RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

type RecycleDb = PrismaClient | Prisma.TransactionClient;
type ScopeKind = "class" | "semester";

async function purgeFeedbackAttachmentDirectories(planIds: string[]) {
  const root = path.resolve(process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT?.trim()
    || path.join(os.homedir(), "Library", "Application Support", "Student Track", "feedback-attachments"));
  for (const planId of [...new Set(planIds)]) {
    const directory = path.resolve(root, planId);
    if (path.relative(root, directory) !== planId) throw new Error("反馈计划附件目录无效");
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function purgeAt(deletedAt: Date) {
  return new Date(deletedAt.getTime() + RECYCLE_RETENTION_MS);
}

function scopeDetails(deletedAt: Date, inheritedFrom?: "semester") {
  return {
    deletedAt: deletedAt.toISOString(),
    purgeAt: purgeAt(deletedAt).toISOString(),
    recoveryDays: RECYCLE_RETENTION_DAYS,
    ...(inheritedFrom ? { inheritedFrom } : {}),
  };
}

export async function assertSemesterAvailable(
  semesterId: string,
  db: RecycleDb = prisma,
) {
  const semester = await db.semester.findUnique({
    where: { id: semesterId },
    select: { id: true, deletedAt: true },
  });
  if (!semester) throw new ApiError("学期不存在", 404, "not_found", false);
  if (semester.deletedAt) {
    throw new ApiError("学期位于回收站，当前不可用", 409, "scope_in_recycle_bin", false, scopeDetails(semester.deletedAt));
  }
  return semester;
}

export async function assertClassAvailable(classId: string, db: RecycleDb = prisma) {
  const klass = await db.class.findUnique({
    where: { id: classId },
    select: { id: true, semesterId: true, deletedAt: true, semester: { select: { deletedAt: true } } },
  });
  if (!klass) throw new ApiError("班级不存在", 404, "not_found", false);
  const effectiveDeletedAt = klass.deletedAt ?? klass.semester.deletedAt;
  if (effectiveDeletedAt) {
    throw new ApiError(
      "班级或所属学期位于回收站，当前不可用",
      409,
      "scope_in_recycle_bin",
      false,
      scopeDetails(effectiveDeletedAt, klass.deletedAt ? undefined : "semester"),
    );
  }
  return klass;
}

export async function assertSessionAvailable(sessionId: string, db: RecycleDb = prisma) {
  const session = await db.classSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      semester: { select: { deletedAt: true } },
      class: { select: { deletedAt: true } },
    },
  });
  if (!session) throw new ApiError("课次不存在", 404, "not_found", false);
  const effectiveDeletedAt = session.class?.deletedAt ?? session.semester.deletedAt;
  if (effectiveDeletedAt) {
    throw new ApiError("课次所属范围位于回收站，当前不可用", 409, "scope_in_recycle_bin", false, scopeDetails(effectiveDeletedAt));
  }
  return session;
}

export async function assertFeedbackPlanAvailable(planId: string, db: RecycleDb = prisma) {
  const plan = await db.feedbackPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      batchId: true,
      semester: { select: { deletedAt: true } },
      class: { select: { deletedAt: true } },
      batch: {
        select: { plans: { select: { class: { select: { deletedAt: true } } } } },
      },
    },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  const batchDeletedAt = plan.batch?.plans.find((item) => item.class.deletedAt)?.class.deletedAt ?? null;
  const effectiveDeletedAt = plan.class.deletedAt ?? plan.semester.deletedAt ?? batchDeletedAt;
  if (effectiveDeletedAt) {
    throw new ApiError("反馈计划所属范围位于回收站，当前不可用", 409, "scope_in_recycle_bin", false, scopeDetails(effectiveDeletedAt));
  }
  return plan;
}

export async function assertFeedbackBatchAvailable(batchId: string, db: RecycleDb = prisma) {
  const batch = await db.feedbackPlanBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      semester: { select: { deletedAt: true } },
      plans: { select: { class: { select: { deletedAt: true } } } },
    },
  });
  if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  const classDeletedAt = batch.plans.find((plan) => plan.class.deletedAt)?.class.deletedAt ?? null;
  const effectiveDeletedAt = batch.semester.deletedAt ?? classDeletedAt;
  if (effectiveDeletedAt) {
    throw new ApiError("多班计划包含回收站班级，整份计划当前不可用", 409, "scope_in_recycle_bin", false, scopeDetails(effectiveDeletedAt));
  }
  return batch;
}

async function impactedBatchIdsForClass(classId: string, db: RecycleDb) {
  const plans = await db.feedbackPlan.findMany({
    where: { classId, batchId: { not: null } },
    select: { batchId: true },
  });
  return [...new Set(plans.flatMap((plan) => plan.batchId ? [plan.batchId] : []))];
}

export async function getRecycleImpact(kind: ScopeKind, id: string, db: RecycleDb = prisma) {
  if (kind === "class") {
    const klass = await db.class.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, semesterId: true, deletedAt: true, semester: { select: { name: true, deletedAt: true } } },
    });
    if (!klass) throw new ApiError("班级不存在", 404, "not_found", false);
    const batchIds = await impactedBatchIdsForClass(id, db);
    const [sessionCount, directPlanCount, affectedPlanCount, metricCount, attendanceCount, eventCount, intakeRunCount] = await Promise.all([
      db.classSession.count({ where: { classId: id } }),
      db.feedbackPlan.count({ where: { classId: id } }),
      db.feedbackPlan.count({ where: { OR: [{ classId: id }, ...(batchIds.length ? [{ batchId: { in: batchIds } }] : [])] } }),
      db.sessionMetric.count({ where: { session: { classId: id } } }),
      db.attendance.count({ where: { session: { classId: id } } }),
      db.event.count({ where: { session: { classId: id } } }),
      db.feedbackIntakeRun.count({ where: { session: { classId: id } } }),
    ]);
    return {
      kind,
      id,
      name: klass.name ?? klass.code,
      semesterId: klass.semesterId,
      semesterName: klass.semester.name,
      deletedAt: klass.deletedAt?.toISOString() ?? null,
      inheritedUnavailable: Boolean(klass.semester.deletedAt),
      sessionCount,
      directPlanCount,
      affectedPlanCount,
      batchCount: batchIds.length,
      factCount: metricCount + attendanceCount + eventCount,
      intakeRunCount,
    };
  }

  const semester = await db.semester.findUnique({
    where: { id },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!semester) throw new ApiError("学期不存在", 404, "not_found", false);
  const [classCount, sessionCount, planCount, batchCount, metricCount, attendanceCount, eventCount, intakeRunCount] = await Promise.all([
    db.class.count({ where: { semesterId: id } }),
    db.classSession.count({ where: { semesterId: id } }),
    db.feedbackPlan.count({ where: { semesterId: id } }),
    db.feedbackPlanBatch.count({ where: { semesterId: id } }),
    db.sessionMetric.count({ where: { session: { semesterId: id } } }),
    db.attendance.count({ where: { session: { semesterId: id } } }),
    db.event.count({ where: { session: { semesterId: id } } }),
    db.feedbackIntakeRun.count({ where: { session: { semesterId: id } } }),
  ]);
  return {
    kind,
    id,
    name: semester.name,
    deletedAt: semester.deletedAt?.toISOString() ?? null,
    classCount,
    sessionCount,
    planCount,
    batchCount,
    factCount: metricCount + attendanceCount + eventCount,
    intakeRunCount,
  };
}

async function requestGenerationPause(kind: ScopeKind, id: string, db: PrismaClient) {
  const planWhere: Prisma.FeedbackPlanWhereInput = kind === "semester"
    ? { semesterId: id }
    : { OR: [{ classId: id }, { batch: { plans: { some: { classId: id } } } }] };
  const plans = await db.feedbackPlan.findMany({ where: planWhere, select: { id: true, batchId: true } });
  const planIds = plans.map((plan) => plan.id);
  const batchIds = [...new Set(plans.flatMap((plan) => plan.batchId ? [plan.batchId] : []))];
  await db.$transaction(async (tx) => {
    if (batchIds.length) {
      await tx.feedbackPlanBatch.updateMany({
        where: { id: { in: batchIds }, status: { in: ["queued", "running"] } },
        data: { status: "pause_requested", planRevision: { increment: 1 } },
      });
    }
    if (planIds.length) {
      await tx.feedbackPlan.updateMany({
        where: { id: { in: planIds }, status: { in: ["queued", "generating"] } },
        data: { status: "pause_requested", planRevision: { increment: 1 } },
      });
    }
  });
}

export async function moveScopeToRecycleBin(kind: ScopeKind, id: string, db: PrismaClient = prisma) {
  const impact = await getRecycleImpact(kind, id, db);
  await requestGenerationPause(kind, id, db);
  const now = new Date();
  if (kind === "class") {
    await db.class.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now } });
  } else {
    await db.semester.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now } });
  }
  await db.systemLog.create({
    data: {
      action: `${kind}.recycled`,
      targetType: kind === "class" ? "Class" : "Semester",
      targetId: id,
      targetName: impact.name,
      detail: JSON.stringify({ purgeAt: purgeAt(now).toISOString(), impact }),
    },
  });
  return { ...impact, deletedAt: now.toISOString(), purgeAt: purgeAt(now).toISOString() };
}

export async function restoreScope(kind: ScopeKind, id: string, db: PrismaClient = prisma) {
  if (kind === "class") {
    const klass = await db.class.findUnique({ where: { id }, select: { id: true, deletedAt: true, semester: { select: { deletedAt: true } } } });
    if (!klass) throw new ApiError("班级不存在", 404, "not_found", false);
    if (klass.semester.deletedAt) throw new ApiError("请先恢复所属学期", 409, "scope_in_recycle_bin", false, scopeDetails(klass.semester.deletedAt, "semester"));
    if (!klass.deletedAt) return { restored: false, id };
    if (purgeAt(klass.deletedAt).getTime() <= Date.now()) throw new ApiError("班级已超过 30 天恢复期限，等待永久清除", 409, "conflict", false);
    await db.class.update({ where: { id }, data: { deletedAt: null } });
  } else {
    const semester = await db.semester.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
    if (!semester) throw new ApiError("学期不存在", 404, "not_found", false);
    if (!semester.deletedAt) return { restored: false, id };
    if (purgeAt(semester.deletedAt).getTime() <= Date.now()) throw new ApiError("学期已超过 30 天恢复期限，等待永久清除", 409, "conflict", false);
    await db.semester.update({ where: { id }, data: { deletedAt: null } });
  }
  await db.systemLog.create({ data: { action: `${kind}.restored`, targetType: kind === "class" ? "Class" : "Semester", targetId: id } });
  return { restored: true, id };
}

export async function listRecycleBin(db: PrismaClient = prisma) {
  const [semesters, classes] = await Promise.all([
    db.semester.findMany({ where: { deletedAt: { not: null } }, orderBy: { deletedAt: "asc" }, select: { id: true, name: true, deletedAt: true } }),
    db.class.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: "asc" },
      select: { id: true, code: true, name: true, deletedAt: true, semester: { select: { id: true, name: true, deletedAt: true } } },
    }),
  ]);
  const now = Date.now();
  const decorate = (deletedAt: Date) => {
    const deadline = purgeAt(deletedAt);
    return { deletedAt: deletedAt.toISOString(), purgeAt: deadline.toISOString(), daysRemaining: Math.max(0, Math.ceil((deadline.getTime() - now) / 86_400_000)) };
  };
  return {
    retentionDays: RECYCLE_RETENTION_DAYS,
    semesters: semesters.map((semester) => ({ kind: "semester" as const, id: semester.id, name: semester.name, ...decorate(semester.deletedAt!) })),
    classes: classes.map((klass) => ({ kind: "class" as const, id: klass.id, name: klass.name ?? klass.code, code: klass.code, semester: klass.semester, restorable: !klass.semester.deletedAt, ...decorate(klass.deletedAt!) })),
  };
}

async function collectPurgeTargets(kind: ScopeKind, id: string, db: RecycleDb) {
  const classIds = kind === "semester"
    ? (await db.class.findMany({ where: { semesterId: id }, select: { id: true } })).map((item) => item.id)
    : [id];
  const semesterIds = kind === "semester"
    ? [id]
    : (await db.class.findUnique({ where: { id }, select: { semesterId: true } }))?.semesterId
      ? [(await db.class.findUnique({ where: { id }, select: { semesterId: true } }))!.semesterId]
      : [];
  const directPlans = await db.feedbackPlan.findMany({ where: { classId: { in: classIds } }, select: { id: true, batchId: true } });
  const batchIds = [...new Set(directPlans.flatMap((plan) => plan.batchId ? [plan.batchId] : []))];
  const planIds = (await db.feedbackPlan.findMany({
    where: { OR: [{ classId: { in: classIds } }, ...(batchIds.length ? [{ batchId: { in: batchIds } }] : [])] },
    select: { id: true },
  })).map((plan) => plan.id);
  const sessionIds = (await db.classSession.findMany({
    where: kind === "semester" ? { semesterId: id } : { classId: id },
    select: { id: true },
  })).map((session) => session.id);
  return { classIds, semesterIds, batchIds, planIds, sessionIds };
}

async function permanentlyPurgeScope(kind: ScopeKind, id: string, db: PrismaClient) {
  const targets = await collectPurgeTargets(kind, id, db);
  const itemIds = (await db.feedbackPlanItem.findMany({ where: { planId: { in: targets.planIds } }, select: { id: true } })).map((item) => item.id);
  await db.$transaction(async (tx) => {
    if (itemIds.length) await tx.generationRecord.deleteMany({ where: { feedbackPlanItemId: { in: itemIds } } });
    await tx.generationRecord.deleteMany({
      where: {
        OR: [
          { classId: { in: targets.classIds } },
          { sessionId: { in: targets.sessionIds } },
          ...(kind === "semester" ? [{ semesterId: id }] : []),
        ],
      },
    });
    if (targets.planIds.length) await tx.feedbackPlan.deleteMany({ where: { id: { in: targets.planIds } } });
    if (targets.batchIds.length) await tx.feedbackPlanBatch.deleteMany({ where: { id: { in: targets.batchIds } } });
    await tx.groupLessonSession.deleteMany({ where: { sessionId: { in: targets.sessionIds } } });
    await tx.classSession.deleteMany({ where: { id: { in: targets.sessionIds } } });
    await tx.studentClassEnrollment.deleteMany({ where: { classId: { in: targets.classIds } } });
    await tx.memoryCompactionRun.deleteMany({ where: { classId: { in: targets.classIds } } });
    await tx.teachingMemory.deleteMany({ where: { OR: [{ scopeType: "class", scopeId: { in: targets.classIds } }, ...(kind === "semester" ? [{ semesterId: id }] : [])] } });
    await tx.classGroup.updateMany({ where: { leadClassId: { in: targets.classIds } }, data: { leadClassId: null } });
    await tx.classGroupMembership.deleteMany({ where: { classId: { in: targets.classIds } } });
    if (kind === "semester") await tx.classGroup.deleteMany({ where: { semesterId: id } });
    await tx.class.deleteMany({ where: { id: { in: targets.classIds } } });
    if (kind === "semester") await tx.semester.delete({ where: { id } });
    await tx.systemLog.create({ data: { action: `${kind}.purged`, targetType: kind === "class" ? "Class" : "Semester", targetId: id } });
  }, { timeout: 30_000 });
  await purgeFeedbackAttachmentDirectories(targets.planIds);
  return targets;
}

export async function purgeExpiredRecycleBin(options: { now?: Date; db?: PrismaClient } = {}) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECYCLE_RETENTION_MS);
  const [semesters, classes] = await Promise.all([
    db.semester.findMany({ where: { deletedAt: { lte: cutoff } }, select: { id: true } }),
    db.class.findMany({ where: { deletedAt: { lte: cutoff }, semester: { deletedAt: null } }, select: { id: true } }),
  ]);
  if (!semesters.length && !classes.length) return { purgedSemesters: 0, purgedClasses: 0, backup: null };

  const backup = await createDatabaseBackup({ prefix: "pre-recycle-bin-purge" });
  await verifyDatabaseBackup(backup.backupPath);
  for (const semester of semesters) await permanentlyPurgeScope("semester", semester.id, db);
  for (const klass of classes) {
    const exists = await db.class.findUnique({ where: { id: klass.id }, select: { id: true } });
    if (exists) await permanentlyPurgeScope("class", klass.id, db);
  }
  return { purgedSemesters: semesters.length, purgedClasses: classes.length, backup: { verified: true, createdAt: backup.manifest.createdAt } };
}
