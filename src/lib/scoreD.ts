import type { Prisma } from "@/generated/prisma/client";
import { calculateAttendanceScore, SCORE_RULES } from "@/config/rules";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { prisma } from "@/lib/prisma";

interface RecalculateScoreDOptions {
  semesterId: string;
  studentIds?: string[];
  classId?: string | null;
  targetSessionId?: string | null;
  targetDate?: string;
  createMissingForTargetSession?: boolean;
  updateLatestInSemester?: boolean;
}

function uniqueIds(ids?: string[]) {
  return Array.from(new Set((ids ?? []).filter(Boolean)));
}

export async function recalculateScoreDForStudents({
  semesterId,
  studentIds,
  classId,
  targetSessionId,
  targetDate,
  createMissingForTargetSession = false,
  updateLatestInSemester = false,
}: RecalculateScoreDOptions, db: Prisma.TransactionClient = prisma) {
  const ids = uniqueIds(studentIds);
  const studentWhere = {
    ...(ids.length > 0 ? { id: { in: ids } } : {}),
    ...(classId ? { classId } : {}),
  };

  const students = await db.student.findMany({
    where: studentWhere,
    select: { id: true, classId: true },
  });

  let changed = 0;

  for (const student of students) {
    const scopedSessions = await db.classSession.findMany({
      where: {
        semesterId,
        OR: [{ classId: student.classId }, { classId: null }],
      },
      select: { id: true },
    });
    const scopedSessionIds = scopedSessions.map((session) => session.id);
    if (scopedSessionIds.length === 0) continue;

    const presentCount = await db.attendance.count({
      where: {
        studentId: student.id,
        present: true,
        sessionId: { in: scopedSessionIds },
      },
    });
    const scoreD = calculateAttendanceScore(presentCount, scopedSessionIds.length);

    const currentMetric = targetSessionId
      ? await db.sessionMetric.findUnique({
          where: { studentId_sessionId: { studentId: student.id, sessionId: targetSessionId } },
        })
      : null;

    const targetMetric = currentMetric ?? (updateLatestInSemester
      ? await db.sessionMetric.findFirst({
          where: { studentId: student.id, sessionId: { in: scopedSessionIds } },
          orderBy: { createdAt: "desc" },
        })
      : null);

    if (targetMetric) {
      if (targetMetric.scoreD === scoreD) continue;
      await archiveMetricBeforeUpdate(targetMetric.id, "update", db);
      await db.sessionMetric.update({
        where: { id: targetMetric.id },
        data: { scoreD },
      });
      changed++;
      continue;
    }

    if (targetSessionId && targetDate && createMissingForTargetSession) {
      await db.sessionMetric.create({
        data: {
          studentId: student.id,
          date: targetDate,
          sessionId: targetSessionId,
          scoreA: SCORE_RULES.default,
          scoreB: SCORE_RULES.default,
          scoreC: SCORE_RULES.default,
          scoreD,
          operator: "system",
        },
      });
      changed++;
    }
  }

  return changed;
}
