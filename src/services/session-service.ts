import type { Prisma } from "@/generated/prisma/client";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { logAction } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { recalculateScoreDForStudents } from "@/lib/scoreD";
import { ServiceError } from "@/services/service-error";

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function reorderSemesterNumbers(
  tx: Prisma.TransactionClient,
  semesterId: string,
  classId: string | null,
) {
  const sessions = await tx.classSession.findMany({
    where: { semesterId, classId },
    orderBy: { code: "asc" },
    select: { id: true },
  });
  for (let index = 0; index < sessions.length; index++) {
    await tx.classSession.update({
      where: { id: sessions[index].id },
      data: { semesterNumber: index + 1 },
    });
  }
}

/** Creates a session, its initial attendance roster, and derived D scores atomically. */
export async function createClassSession(input: {
  semesterId: string;
  classCode?: string;
  date?: string;
}) {
  const date = input.date ?? localDate();
  const result = await prisma.$transaction(async (tx) => {
    const semester = await tx.semester.findUnique({
      where: { id: input.semesterId },
      select: { id: true },
    });
    if (!semester) throw new ServiceError("学期不存在", 404);

    const selectedClass = input.classCode
      ? await tx.class.findFirst({
          where: { OR: [{ code: input.classCode }, { name: input.classCode }] },
          select: { id: true, code: true, name: true },
        })
      : null;
    if (input.classCode && !selectedClass) throw new ServiceError("班级不存在", 404);
    const classId = selectedClass?.id ?? null;

    const dateCode = date.replaceAll("-", "");
    const latestTodaySession = await tx.classSession.findFirst({
      where: { code: { startsWith: dateCode } },
      orderBy: { code: "desc" },
      select: { code: true },
    });
    const sequence = latestTodaySession
      ? Number.parseInt(latestTodaySession.code.slice(-2), 10) + 1
      : 1;
    if (!Number.isInteger(sequence) || sequence > 99) {
      throw new ServiceError("今日课次已达上限（99）", 400);
    }
    const code = `${dateCode}${String(sequence).padStart(2, "0")}`;

    const lastClassSession = await tx.classSession.findFirst({
      where: { semesterId: input.semesterId, classId },
      orderBy: { semesterNumber: "desc" },
      select: { semesterNumber: true },
    });
    const session = await tx.classSession.create({
      data: {
        code,
        semesterId: input.semesterId,
        semesterNumber: (lastClassSession?.semesterNumber ?? 0) + 1,
        date,
        classId,
      },
    });

    const students = await tx.student.findMany({
      where: classId ? { classId } : {},
      select: { id: true },
    });
    if (students.length > 0) {
      await tx.attendance.createMany({
        data: students.map((student) => ({
          sessionId: session.id,
          studentId: student.id,
          present: true,
        })),
      });
    }

    await recalculateScoreDForStudents({
      semesterId: input.semesterId,
      classId,
      targetSessionId: session.id,
      targetDate: date,
      updateLatestInSemester: true,
    }, tx);

    return { session, studentCount: students.length, className: selectedClass?.name ?? selectedClass?.code };
  }, { timeout: 15_000 });

  void logAction({
    action: "session.created",
    targetType: "Session",
    targetId: result.session.id,
    targetName: result.session.code,
    detail: { date, class: result.className, studentCount: result.studentCount },
  });

  return { ...result.session, studentCount: result.studentCount };
}

/** Archives metrics, deletes a session, resequences its class, and recalculates D atomically. */
export async function deleteClassSession(input: { semesterId: string; code: string }) {
  const deleted = await prisma.$transaction(async (tx) => {
    const session = await tx.classSession.findUnique({ where: { code: input.code } });
    if (!session || session.semesterId !== input.semesterId) {
      throw new ServiceError("课次不存在或不属于该学期", 404);
    }

    const metrics = await tx.sessionMetric.findMany({
      where: { sessionId: session.id },
      select: { id: true },
    });
    for (const metric of metrics) {
      await archiveMetricBeforeUpdate(metric.id, "delete", tx);
    }

    await tx.classSession.delete({ where: { id: session.id } });
    await reorderSemesterNumbers(tx, input.semesterId, session.classId);
    await recalculateScoreDForStudents({
      semesterId: input.semesterId,
      classId: session.classId,
      updateLatestInSemester: true,
    }, tx);
    return session;
  }, { timeout: 15_000 });

  void logAction({
    action: "session.deleted",
    targetType: "Session",
    targetId: deleted.id,
    targetName: deleted.code,
    detail: { date: deleted.date, semesterNumber: deleted.semesterNumber },
  });
  return { success: true };
}
