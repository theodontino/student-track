import { normalizeDimensionScore, normalizeScoreA, SCORE_RULES } from "@/config/rules";
import { prisma } from "@/lib/prisma";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { logAction } from "@/lib/logger";
import { recalculateScoreDForStudents } from "@/lib/scoreD";
import { ServiceError } from "@/services/service-error";
import { invalidateFeedbackPlans } from "@/services/feedback-plan-invalidation-service";
import { assertSessionAvailable } from "@/services/academic-scope-recycle-service";

export interface QuickScoreEntry {
  studentId: string;
  date?: string;
  scoreA?: number;
  scoreB?: number;
  scoreC?: number;
  note?: string;
}

export interface QuickAttendanceEntry {
  studentId: string;
  present: boolean;
}

export interface SubmitQuickScoresInput {
  scores?: QuickScoreEntry[];
  sessionCode?: string;
  attendances?: QuickAttendanceEntry[];
}

function normalizeScore(value: unknown, dimension: "A" | "B" | "C") {
  const score = dimension === "A" ? normalizeScoreA(value) : normalizeDimensionScore(value);
  if (score === null) throw new ServiceError("评分必须是有效数字", 400);
  return score;
}

/**
 * Persists one quick-score submission atomically, including metric history,
 * classroom notes, attendance, and the derived D score.
 */
export async function submitQuickScores(input: SubmitQuickScoresInput) {
  const scores = input.scores ?? [];
  if (!Array.isArray(scores)) throw new ServiceError("评分数据格式错误", 400);
  if (input.attendances !== undefined && !Array.isArray(input.attendances)) {
    throw new ServiceError("考勤数据格式错误", 400);
  }
  if (scores.length === 0 && !(input.sessionCode && input.attendances?.length)) {
    throw new ServiceError("请提交至少一项评分、考勤或备注修改", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const session = input.sessionCode
      ? await tx.classSession.findUnique({
          where: { code: input.sessionCode },
          select: { id: true, semesterId: true, classId: true, date: true },
        })
      : null;
    if (input.sessionCode && !session) throw new ServiceError("课次不存在", 404);
    if (session) await assertSessionAvailable(session.id, tx);

    const submittedStudentIds = Array.from(new Set([
      ...scores.map((score) => score.studentId),
      ...(input.attendances ?? []).map((attendance) => attendance.studentId),
    ]));
    if (submittedStudentIds.some((id) => typeof id !== "string" || !id)) {
      throw new ServiceError("学生 ID 不能为空", 400);
    }

    const validStudentCount = await tx.student.count({
      where: {
        id: { in: submittedStudentIds },
        ...(session?.classId ? {
          OR: [
            { enrollments: { some: { semesterId: session.semesterId, classId: session.classId, rosterStatus: "ACTIVE" } } },
            { sessionMetrics: { some: { sessionId: session.id } } },
            { attendances: { some: { sessionId: session.id } } },
            { events: { some: { sessionId: session.id } } },
            { communications: { some: { sessionId: session.id } } },
          ],
        } : {}),
      },
    });
    if (validStudentCount !== submittedStudentIds.length) {
      throw new ServiceError("学生不存在或不属于当前课次班级", 400);
    }

    const logEntries: QuickScoreEntry[] = [];

    for (const entry of scores) {
      if (!session && !entry.date) throw new ServiceError("无课次评分必须提供日期", 400);
      const changes = {
        ...(entry.scoreA !== undefined ? { scoreA: normalizeScore(entry.scoreA, "A") } : {}),
        ...(entry.scoreB !== undefined ? { scoreB: normalizeScore(entry.scoreB, "B") } : {}),
        ...(entry.scoreC !== undefined ? { scoreC: normalizeScore(entry.scoreC, "C") } : {}),
      };
      const hasScores = Object.keys(changes).length > 0;
      const note = entry.note?.trim();
      if (!hasScores && !(note && session)) throw new ServiceError("请提供要修改的评分或课次备注", 400);
      const initialScores = { scoreA: SCORE_RULES.default, scoreB: SCORE_RULES.default, scoreC: SCORE_RULES.default, ...changes };
      const metricDate = session?.date ?? entry.date!;

      if (hasScores && session) {
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
            ...initialScores,
            operator: "quickScore",
          },
          update: changes,
        });
      } else if (hasScores) {
        const existing = await tx.sessionMetric.findFirst({
          where: { studentId: entry.studentId, date: metricDate, sessionId: null },
          orderBy: { createdAt: "desc" },
        });
        if (existing) {
          await archiveMetricBeforeUpdate(existing.id, "update", tx);
          await tx.sessionMetric.update({
            where: { id: existing.id },
            data: changes,
          });
        } else {
          await tx.sessionMetric.create({
            data: {
              studentId: entry.studentId,
              date: metricDate,
              sessionId: null,
              ...initialScores,
              operator: "quickScore",
            },
          });
        }
      }

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
      if (hasScores) logEntries.push({ studentId: entry.studentId, ...changes });
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

    if (session) {
      await invalidateFeedbackPlans({
        classId: session.classId ?? undefined,
        semesterId: session.semesterId,
        sessionId: session.id,
        studentIds: submittedStudentIds,
      }, tx);
    }

    return {
      count: scores.length,
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
