import { normalizeDimensionScore } from "@/config/rules";
import { prisma } from "@/lib/prisma";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { logAction } from "@/lib/logger";
import { recalculateScoreDForStudents } from "@/lib/scoreD";
import { ServiceError } from "@/services/service-error";

export interface QuickScoreEntry {
  studentId: string;
  date?: string;
  scoreA: number;
  scoreB: number;
  scoreC: number;
  note?: string;
}

export interface QuickAttendanceEntry {
  studentId: string;
  present: boolean;
}

export interface SubmitQuickScoresInput {
  scores: QuickScoreEntry[];
  sessionCode?: string;
  attendances?: QuickAttendanceEntry[];
}

function normalizeScore(value: unknown) {
  const score = normalizeDimensionScore(value);
  if (score === null) throw new ServiceError("评分必须是有效数字", 400);
  return score;
}

/**
 * Persists one quick-score submission atomically, including metric history,
 * classroom notes, attendance, and the derived D score.
 */
export async function submitQuickScores(input: SubmitQuickScoresInput) {
  if (!Array.isArray(input.scores) || input.scores.length === 0) {
    throw new ServiceError("请提交至少一条评分", 400);
  }
  if (input.attendances !== undefined && !Array.isArray(input.attendances)) {
    throw new ServiceError("考勤数据格式错误", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const session = input.sessionCode
      ? await tx.classSession.findUnique({
          where: { code: input.sessionCode },
          select: { id: true, semesterId: true, classId: true, date: true },
        })
      : null;
    if (input.sessionCode && !session) throw new ServiceError("课次不存在", 404);

    const submittedStudentIds = Array.from(new Set([
      ...input.scores.map((score) => score.studentId),
      ...(input.attendances ?? []).map((attendance) => attendance.studentId),
    ]));
    if (submittedStudentIds.some((id) => typeof id !== "string" || !id)) {
      throw new ServiceError("学生 ID 不能为空", 400);
    }

    const validStudentCount = await tx.student.count({
      where: {
        id: { in: submittedStudentIds },
        ...(session?.classId ? { classId: session.classId } : {}),
      },
    });
    if (validStudentCount !== submittedStudentIds.length) {
      throw new ServiceError("学生不存在或不属于当前课次班级", 400);
    }

    const logEntries: Array<{
      studentId: string;
      scoreA: number;
      scoreB: number;
      scoreC: number;
    }> = [];

    for (const entry of input.scores) {
      if (!session && !entry.date) throw new ServiceError("无课次评分必须提供日期", 400);
      const scoreA = normalizeScore(entry.scoreA);
      const scoreB = normalizeScore(entry.scoreB);
      const scoreC = normalizeScore(entry.scoreC);
      const metricDate = session?.date ?? entry.date!;

      if (session) {
        const existing = await tx.sessionMetric.findUnique({
          where: { studentId_sessionId: { studentId: entry.studentId, sessionId: session.id } },
        });
        if (existing) await archiveMetricBeforeUpdate(existing.id, "update", tx);
        await tx.sessionMetric.upsert({
          where: { studentId_sessionId: { studentId: entry.studentId, sessionId: session.id } },
          create: {
            studentId: entry.studentId,
            date: metricDate,
            sessionId: session.id,
            scoreA,
            scoreB,
            scoreC,
            operator: "quickScore",
          },
          update: { scoreA, scoreB, scoreC },
        });
      } else {
        const existing = await tx.sessionMetric.findFirst({
          where: { studentId: entry.studentId, date: metricDate, sessionId: null },
          orderBy: { createdAt: "desc" },
        });
        if (existing) {
          await archiveMetricBeforeUpdate(existing.id, "update", tx);
          await tx.sessionMetric.update({
            where: { id: existing.id },
            data: { scoreA, scoreB, scoreC },
          });
        } else {
          await tx.sessionMetric.create({
            data: {
              studentId: entry.studentId,
              date: metricDate,
              sessionId: null,
              scoreA,
              scoreB,
              scoreC,
              operator: "quickScore",
            },
          });
        }
      }

      const note = entry.note?.trim();
      if (note && session) {
        await tx.event.upsert({
          where: {
            studentId_sessionId_description: {
              studentId: entry.studentId,
              sessionId: session.id,
              description: note,
            },
          },
          create: {
            studentId: entry.studentId,
            sessionId: session.id,
            type: "课堂表现",
            description: note,
            rawText: note,
          },
          update: {},
        });
      }
      logEntries.push({ studentId: entry.studentId, scoreA, scoreB, scoreC });
    }

    if (session && input.attendances) {
      for (const attendance of input.attendances) {
        if (typeof attendance.present !== "boolean") {
          throw new ServiceError("考勤状态必须是布尔值", 400);
        }
        await tx.attendance.upsert({
          where: {
            sessionId_studentId: {
              sessionId: session.id,
              studentId: attendance.studentId,
            },
          },
          create: {
            sessionId: session.id,
            studentId: attendance.studentId,
            present: attendance.present,
          },
          update: { present: attendance.present },
        });
      }

      await recalculateScoreDForStudents({
        semesterId: session.semesterId,
        studentIds: input.attendances.map((attendance) => attendance.studentId),
        classId: session.classId,
        targetSessionId: session.id,
        targetDate: session.date,
        createMissingForTargetSession: true,
      }, tx);
    }

    return {
      count: input.scores.length,
      attUpdated: session ? input.attendances?.length ?? 0 : 0,
      logEntries,
    };
  });

  for (const entry of result.logEntries) {
    void logAction({
      action: "score.updated",
      targetType: "Student",
      targetId: entry.studentId,
      detail: { ...entry, operator: "quickScore", sessionCode: input.sessionCode },
    });
  }

  return { success: true, count: result.count, attUpdated: result.attUpdated };
}
