import { StudentRosterStatus, type Prisma } from "@/generated/prisma/client";
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

/**
 * Recalculates D using sessions applicable to each student's class, including
 * whole-school sessions. Existing metrics are archived only when D changes.
 * A transaction client may be supplied so callers can include this work in a
 * larger atomic operation.
 */
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
  const enrollmentScope = {
    semesterId,
    ...(classId ? { classId } : {}),
    ...(ids.length > 0 ? {} : { rosterStatus: StudentRosterStatus.ACTIVE }),
  };
  const studentWhere = {
    ...(ids.length > 0 ? { id: { in: ids } } : {}),
    ...(targetSessionId
      ? {
          // Historical sessions remain editable after a transfer or
          // deactivation. Existing evidence on the target session is enough
          // to keep the student in the recalculation set.
          OR: [
            { enrollments: { some: enrollmentScope } },
            { sessionMetrics: { some: { sessionId: targetSessionId } } },
            { attendances: { some: { sessionId: targetSessionId } } },
          ],
        }
      : { enrollments: { some: enrollmentScope } }),
  };

  const students = await db.student.findMany({
    where: studentWhere,
    select: { id: true },
  });
  const enrollmentRows = students.length > 0
    ? await db.studentClassEnrollment.findMany({
        where: { semesterId, studentId: { in: students.map((student) => student.id) } },
        select: { studentId: true, classId: true },
      })
    : [];
  const enrollmentClassByStudent = new Map(enrollmentRows.map((row) => [row.studentId, row.classId]));

  let changed = 0;

  for (const student of students) {
    // A historical session keeps the class context that produced its
    // evidence. When a student has since transferred, do not recalculate D
    // against the new enrollment's class sessions while editing that old
    // record. For ordinary latest-in-term recalculation, use the current
    // enrollment as before.
    const scopedClassId = targetSessionId && classId
      ? classId
      : enrollmentClassByStudent.get(student.id) ?? classId;
    const scopedSessions = await db.classSession.findMany({
      where: {
        semesterId,
        OR: [{ classId: scopedClassId ?? "" }, { classId: null }],
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
