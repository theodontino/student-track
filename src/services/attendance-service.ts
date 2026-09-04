import { prisma } from "@/lib/prisma";
import { recalculateScoreDForStudents } from "@/lib/scoreD";
import { ServiceError } from "@/services/service-error";
import { invalidateFeedbackPlans } from "@/services/feedback-plan-service";
import { assertSessionAvailable } from "@/services/academic-scope-recycle-service";

export interface AttendanceUpdate {
  studentId: string;
  present: boolean;
}

/** Updates a session's attendance and derived D scores in one transaction. */
export async function updateSessionAttendance(sessionId: string, updates: AttendanceUpdate[]) {
  if (!sessionId || !Array.isArray(updates)) throw new ServiceError("参数错误", 400);

  return prisma.$transaction(async (tx) => {
    const session = await tx.classSession.findUnique({
      where: { id: sessionId },
      select: { id: true, semesterId: true, classId: true, date: true },
    });
    if (!session) throw new ServiceError("课次不存在", 404);
    await assertSessionAvailable(session.id, tx);

    const studentIds = Array.from(new Set(updates.map((update) => update.studentId)));
    if (
      studentIds.some((id) => typeof id !== "string" || !id)
      || updates.some((update) => typeof update.present !== "boolean")
    ) {
      throw new ServiceError("考勤数据格式错误", 400);
    }

    const validStudentCount = await tx.student.count({
      where: {
        id: { in: studentIds },
        ...(session.classId ? {
          OR: [
            { enrollments: { some: { semesterId: session.semesterId, classId: session.classId, rosterStatus: "ACTIVE" } } },
            { attendances: { some: { sessionId } } },
            { sessionMetrics: { some: { sessionId } } },
            { events: { some: { sessionId } } },
            { communications: { some: { sessionId } } },
          ],
        } : {}),
      },
    });
    if (validStudentCount !== studentIds.length) {
      throw new ServiceError("学生不存在或不属于当前课次班级", 400);
    }

    for (const update of updates) {
      await tx.attendance.upsert({
        where: { sessionId_studentId: { sessionId, studentId: update.studentId } },
        create: { sessionId, studentId: update.studentId, present: update.present },
        update: { present: update.present },
      });
    }
    await recalculateScoreDForStudents({
      semesterId: session.semesterId,
      studentIds,
      classId: session.classId,
      targetSessionId: session.id,
      targetDate: session.date,
      createMissingForTargetSession: true,
    }, tx);
    await invalidateFeedbackPlans({
      classId: session.classId ?? undefined,
      semesterId: session.semesterId,
      sessionId: session.id,
      studentIds,
    }, tx);
    return { success: true };
  }, { timeout: 15_000 });
}
