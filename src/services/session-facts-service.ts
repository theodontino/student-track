import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { prisma } from "@/lib/prisma";
import { assertSessionAvailable } from "@/services/academic-scope-recycle-service";
import { createDatabaseBackup, verifyDatabaseBackup } from "@/services/database-backup-service";

async function sessionOrThrow(sessionId: string, db: PrismaClient) {
  await assertSessionAvailable(sessionId, db);
  const session = await db.classSession.findUnique({
    where: { id: sessionId },
    select: { id: true, code: true, date: true, semesterId: true, classId: true },
  });
  if (!session) throw new ApiError("课次不存在", 404, "not_found", false);
  return session;
}

export async function getSessionFactsImpact(sessionId: string, db: PrismaClient = prisma) {
  const session = await sessionOrThrow(sessionId, db);
  const [metricCount, attendanceCount, eventCount, teacherHandlingCount, intakeRunCount] = await Promise.all([
    db.sessionMetric.count({ where: { sessionId } }),
    db.attendance.count({ where: { sessionId } }),
    db.event.count({ where: { sessionId } }),
    db.event.count({ where: { sessionId, type: "教师处理" } }),
    db.feedbackIntakeRun.count({ where: { sessionCode: session.code } }),
  ]);
  const intakeRunIds = (await db.feedbackIntakeRun.findMany({ where: { sessionCode: session.code }, select: { id: true } })).map((run) => run.id);
  const draftCount = intakeRunIds.length
    ? await db.draftRecord.count({
        where: {
          OR: [
            { intakeRunId: { in: intakeRunIds } },
            ...intakeRunIds.map((runId) => ({ rawText: { contains: `feedback-intake:${runId}` } })),
          ],
        },
      })
    : 0;
  return {
    session,
    metricCount,
    attendanceCount,
    eventCount,
    teacherHandlingCount,
    intakeRunCount,
    draftCount,
    preserved: {
      communications: await db.communication.count({ where: { sessionId } }),
      feedbackPlans: await db.feedbackPlan.count({
        where: { OR: [{ sessionId }, { rangeStartSessionId: sessionId }, { rangeEndSessionId: sessionId }] },
      }),
      commonMaterial: true,
      groupLessonLink: Boolean(await db.groupLessonSession.findUnique({ where: { sessionId }, select: { id: true } })),
    },
  };
}

export async function clearSessionFacts(sessionId: string, db: PrismaClient = prisma) {
  const impact = await getSessionFactsImpact(sessionId, db);
  const backup = await createDatabaseBackup({ prefix: `pre-session-facts-clear-${impact.session.code}` });
  await verifyDatabaseBackup(backup.backupPath);

  await db.$transaction(async (tx) => {
    const metrics = await tx.sessionMetric.findMany({ where: { sessionId }, select: { id: true } });
    for (const metric of metrics) await archiveMetricBeforeUpdate(metric.id, "clear", tx);

    const intakeRunIds = (await tx.feedbackIntakeRun.findMany({
      where: { sessionCode: impact.session.code },
      select: { id: true },
    })).map((run) => run.id);
    if (intakeRunIds.length) {
      await tx.draftRecord.deleteMany({
        where: {
          OR: [
            { intakeRunId: { in: intakeRunIds } },
            ...intakeRunIds.map((runId) => ({ rawText: { contains: `feedback-intake:${runId}` } })),
          ],
        },
      });
    }
    await tx.sessionMetric.deleteMany({ where: { sessionId } });
    await tx.attendance.deleteMany({ where: { sessionId } });
    await tx.event.deleteMany({ where: { sessionId } });
    await tx.feedbackIntakeRun.deleteMany({ where: { sessionCode: impact.session.code } });
    await tx.teachingSummaryCache.deleteMany({
      where: {
        OR: [
          { scopeType: "session", scopeKey: `session:${impact.session.code}` },
          { scopeType: "date", scopeKey: `date:${impact.session.semesterId}:${impact.session.date}` },
        ],
      },
    });
    await tx.systemLog.create({
      data: {
        action: "session.facts_cleared",
        targetType: "Session",
        targetId: sessionId,
        targetName: impact.session.code,
        detail: JSON.stringify({
          metricCount: impact.metricCount,
          attendanceCount: impact.attendanceCount,
          eventCount: impact.eventCount,
          teacherHandlingCount: impact.teacherHandlingCount,
          intakeRunCount: impact.intakeRunCount,
          draftCount: impact.draftCount,
        }),
      },
    });
  }, { timeout: 20_000 });

  return {
    success: true,
    cleared: {
      metrics: impact.metricCount,
      attendances: impact.attendanceCount,
      events: impact.eventCount,
      teacherHandling: impact.teacherHandlingCount,
      intakeRuns: impact.intakeRunCount,
      drafts: impact.draftCount,
    },
    backup: { verified: true, createdAt: backup.manifest.createdAt },
    preserved: impact.preserved,
  };
}
