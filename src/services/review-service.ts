import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { logAction } from "@/lib/logger";
import type { ParseResult, ParsedStudent } from "@/lib/parser";
import { prisma } from "@/lib/prisma";
import { recalculateScoreDForStudents } from "@/lib/scoreD";
import { ServiceError } from "@/services/service-error";

type ReviewAction = "confirm" | "reject";

interface ProcessDraftInput {
  draftId: string;
  action: ReviewAction;
  edits?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalScore(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new ServiceError("评分必须是有效数字", 400);
  return Math.round(Math.max(0, Math.min(5, numeric)));
}

function normalizeStudent(value: unknown): ParsedStudent {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new ServiceError("草案中的学生姓名无效", 400);
  }
  if (!isRecord(value.scores)) throw new ServiceError(`${value.name} 的评分格式无效`, 400);

  const events = Array.isArray(value.events)
    ? Array.from(new Set(value.events.filter((event): event is string => (
        typeof event === "string" && Boolean(event.trim())
      )).map((event) => event.trim())))
    : [];

  let communication: ParsedStudent["communication"] = null;
  if (value.communication !== null && value.communication !== undefined) {
    if (
      !isRecord(value.communication)
      || typeof value.communication.type !== "string"
      || typeof value.communication.summary !== "string"
    ) {
      throw new ServiceError(`${value.name} 的沟通记录格式无效`, 400);
    }
    communication = {
      type: value.communication.type.trim(),
      summary: value.communication.summary.trim(),
    };
  }

  return {
    name: value.name.trim(),
    scores: {
      A: normalizeOptionalScore(value.scores.A),
      B: normalizeOptionalScore(value.scores.B),
      C: normalizeOptionalScore(value.scores.C),
    },
    events,
    communication,
    ...(typeof value.present === "boolean" ? { present: value.present } : {}),
  };
}

function normalizeParsedData(value: unknown): ParseResult {
  if (!isRecord(value) || !Array.isArray(value.students)) {
    throw new ServiceError("草案内容格式无效", 400);
  }
  return {
    students: value.students.map(normalizeStudent),
    alert_suggestion: typeof value.alert_suggestion === "string" ? value.alert_suggestion : "",
  };
}

function inferEventType(description: string): string {
  const lower = description.toLowerCase();
  if (lower.includes("测验") || lower.includes("考试") || lower.includes("成绩")) return "测验成绩";
  if (lower.includes("作业") || lower.includes("笔记") || lower.includes("预习")) return "课后任务";
  if (lower.includes("情绪") || lower.includes("心理") || lower.includes("低")) return "心理状态";
  if (lower.includes("家长") || lower.includes("电话") || lower.includes("沟通")) return "家校沟通";
  return "课堂表现";
}

/**
 * Confirms or rejects a pending NL draft. Confirming is atomic across all
 * business records and cannot be repeated after the draft leaves pending.
 */
export async function processDraftReview(input: ProcessDraftInput) {
  if (!input.draftId) throw new ServiceError("draftId 和 action 为必填项", 400);
  if (input.action !== "confirm" && input.action !== "reject") {
    throw new ServiceError("action 必须是 confirm 或 reject", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const draft = await tx.draftRecord.findUnique({ where: { id: input.draftId } });
    if (!draft) throw new ServiceError("草稿不存在", 404);
    if (draft.status !== "pending") throw new ServiceError("草稿已经处理，不能重复提交", 409);

    if (input.action === "reject") {
      await tx.draftRecord.update({
        where: { id: draft.id },
        data: { status: "rejected" },
      });
      return { status: "rejected" as const, warnings: [], logs: [] };
    }

    let source: unknown = input.edits;
    if (source === undefined) {
      try {
        source = JSON.parse(draft.parsedResult);
      } catch {
        throw new ServiceError("草稿内容已损坏，无法确认", 422);
      }
    }
    const parsedData = normalizeParsedData(source);
    const today = new Date().toISOString().split("T")[0];
    const session = draft.sessionCode
      ? await tx.classSession.findUnique({
          where: { code: draft.sessionCode },
          select: { id: true, date: true, semesterId: true, classId: true },
        })
      : null;
    if (draft.sessionCode && !session) {
      throw new ServiceError(`关联课次 ${draft.sessionCode} 已被删除，请重新录入`, 409);
    }

    const names = Array.from(new Set(parsedData.students.map((student) => student.name)));
    const matchingStudents = await tx.student.findMany({
      where: {
        name: { in: names },
        ...(session?.classId ? { classId: session.classId } : {}),
      },
      select: { id: true, name: true },
    });
    const studentsByName = new Map<string, typeof matchingStudents>();
    for (const student of matchingStudents) {
      studentsByName.set(student.name, [...(studentsByName.get(student.name) ?? []), student]);
    }

    const warnings: string[] = [];
    const affectedStudentIds: string[] = [];
    const logs: Array<{ studentId: string; studentName: string; scores: ParsedStudent["scores"] }> = [];

    for (const parsedStudent of parsedData.students) {
      const matches = studentsByName.get(parsedStudent.name) ?? [];
      if (matches.length === 0) {
        warnings.push(`未找到学生 ${parsedStudent.name}，相关内容未写入`);
        continue;
      }
      if (matches.length > 1) {
        throw new ServiceError(`学生姓名 ${parsedStudent.name} 存在重名，无法安全确认`, 409);
      }
      const student = matches[0];
      affectedStudentIds.push(student.id);
      const hasScores = Object.values(parsedStudent.scores).some((score) => score !== null);

      if (hasScores) {
        const scoreA = parsedStudent.scores.A ?? 3;
        const scoreB = parsedStudent.scores.B ?? 3;
        const scoreC = parsedStudent.scores.C ?? 3;
        if (session) {
          const existing = await tx.sessionMetric.findUnique({
            where: { studentId_sessionId: { studentId: student.id, sessionId: session.id } },
          });
          if (existing) await archiveMetricBeforeUpdate(existing.id, "update", tx);
          await tx.sessionMetric.upsert({
            where: { studentId_sessionId: { studentId: student.id, sessionId: session.id } },
            create: {
              studentId: student.id,
              date: session.date,
              sessionId: session.id,
              scoreA,
              scoreB,
              scoreC,
              operator: "nlReview",
            },
            update: { scoreA, scoreB, scoreC },
          });
        } else {
          const existing = await tx.sessionMetric.findFirst({
            where: { studentId: student.id, date: today, sessionId: null },
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
                studentId: student.id,
                date: today,
                sessionId: null,
                scoreA,
                scoreB,
                scoreC,
                operator: "nlReview",
              },
            });
          }
        }
        logs.push({ studentId: student.id, studentName: student.name, scores: parsedStudent.scores });
      }

      if (session && typeof parsedStudent.present === "boolean") {
        await tx.attendance.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: student.id } },
          create: { sessionId: session.id, studentId: student.id, present: parsedStudent.present },
          update: { present: parsedStudent.present },
        });
      }

      if (parsedStudent.events.length > 0) {
        if (!session) {
          warnings.push(`${student.name} 的 ${parsedStudent.events.length} 个事件因无课次关联被跳过`);
        } else {
          for (const description of parsedStudent.events) {
            await tx.event.upsert({
              where: {
                studentId_sessionId_description: {
                  studentId: student.id,
                  sessionId: session.id,
                  description,
                },
              },
              create: {
                studentId: student.id,
                sessionId: session.id,
                type: inferEventType(description),
                description,
                rawText: draft.rawText,
              },
              update: {},
            });
          }
        }
      }

      if (parsedStudent.communication) {
        if (!session) {
          warnings.push(`${student.name} 的家校沟通记录因无课次关联被跳过`);
        } else {
          await tx.communication.create({
            data: {
              studentId: student.id,
              sessionId: session.id,
              target: parsedStudent.communication.type.includes("家长")
                ? "家长"
                : parsedStudent.communication.type,
              summary: parsedStudent.communication.summary,
            },
          });
        }
      }
    }

    if (session && affectedStudentIds.length > 0) {
      await recalculateScoreDForStudents({
        semesterId: session.semesterId,
        studentIds: affectedStudentIds,
        classId: session.classId,
        targetSessionId: session.id,
        targetDate: session.date,
        createMissingForTargetSession: false,
      }, tx);
    }

    await tx.draftRecord.update({
      where: { id: draft.id },
      data: { status: "confirmed", parsedResult: JSON.stringify(parsedData) },
    });

    return { status: "confirmed" as const, warnings, logs };
  }, { timeout: 15_000 });

  for (const entry of result.logs) {
    void logAction({
      action: "score.updated",
      targetType: "Student",
      targetId: entry.studentId,
      targetName: entry.studentName,
      detail: { ...entry.scores, operator: "nlReview" },
    });
  }

  return {
    success: true,
    status: result.status,
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}
