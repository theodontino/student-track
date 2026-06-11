import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { logAction } from "@/lib/logger";
import { recalculateScoreDForStudents } from "@/lib/scoreD";

// GET /api/quick-score?class=&date=&sessionCode= — get existing scores for a class/session
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const className = searchParams.get("class");
    const date = searchParams.get("date");
    const sessionCode = searchParams.get("sessionCode");

    if (!className || (!date && !sessionCode)) {
      return NextResponse.json({ error: "缺少 class 以及 date 或 sessionCode 参数" }, { status: 400 });
    }

    // Resolve classId from className (by name or code)
    const cls = await prisma.class.findFirst({
      where: { OR: [{ name: className }, { code: className }] },
    });
    const classId = cls?.id;
    if (!classId) {
      return NextResponse.json({ error: "班级不存在" }, { status: 404 });
    }

    let targetDate = date;
    let targetSession: { id: string; code: string; semesterNumber: number; date: string; classId: string | null } | null = null;

    if (sessionCode) {
      targetSession = await prisma.classSession.findUnique({
        where: { code: sessionCode },
        select: { id: true, code: true, semesterNumber: true, date: true, classId: true },
      });

      if (!targetSession) {
        return NextResponse.json({ error: "课次不存在" }, { status: 404 });
      }

      if (targetSession.classId && targetSession.classId !== classId) {
        return NextResponse.json({ error: "课次不属于当前班级" }, { status: 400 });
      }

      targetDate = targetSession.date;
    }

    if (!targetDate) {
      return NextResponse.json({ error: "缺少日期" }, { status: 400 });
    }

    const students = await prisma.student.findMany({
      where: { classId },
      select: { id: true, name: true },
    });

    const studentIds = students.map((s) => s.id);

    const metrics = targetSession
      ? await prisma.sessionMetric.findMany({
          where: { studentId: { in: studentIds }, sessionId: targetSession.id },
        })
      : await prisma.sessionMetric.findMany({
          where: { studentId: { in: studentIds }, date: targetDate, sessionId: null },
        });

    let sessions: { id: string; code: string; semesterNumber: number; date: string; classId: string | null }[] = [];
    let attendanceSessionId = targetSession?.id;

    if (targetSession) {
      sessions = [{
        id: targetSession.id, code: targetSession.code,
        semesterNumber: targetSession.semesterNumber, date: targetSession.date, classId: targetSession.classId,
      }];
    } else {
      sessions = await prisma.classSession.findMany({
        where: { date: targetDate, classId },
        select: { id: true, code: true, semesterNumber: true, date: true, classId: true },
        orderBy: { code: "desc" },
      });

      if (sessions.length === 1) {
        attendanceSessionId = sessions[0].id;
      }
    }

    const attendances = attendanceSessionId
      ? await prisma.attendance.findMany({
          where: { sessionId: attendanceSessionId, studentId: { in: studentIds } },
        })
      : [];

    const metricMap = new Map(metrics.map((m) => [m.studentId, m]));
    const attMap = new Map(attendances.map((a) => [a.studentId, a]));

    const result = students.map((s) => {
      const m = metricMap.get(s.id);
      const a = attMap.get(s.id);
      return {
        studentId: s.id,
        studentName: s.name,
        scoreA: m?.scoreA ?? 3,
        scoreB: m?.scoreB ?? 3,
        scoreC: m?.scoreC ?? 3,
        present: a?.present ?? true,
      };
    });

    return NextResponse.json({
      date: targetDate,
      className,
      session: targetSession ? { ...targetSession, class: className } : null,
      sessions: sessions.map(s => ({ ...s, class: className })),
      scores: result,
    });
  } catch (error) {
    console.error("[/api/quick-score] error:", error);
    return NextResponse.json({ error: "获取评分数据失败" }, { status: 500 });
  }
}

interface ScoreEntry {
  studentId: string;
  date: string;
  scoreA: number;
  scoreB: number;
  scoreC: number;
  note?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scores, sessionCode, attendances } = body as {
      scores: ScoreEntry[];
      sessionCode?: string;
      attendances?: { studentId: string; present: boolean }[];
    };

    if (!scores || !Array.isArray(scores) || scores.length === 0) {
      return NextResponse.json({ error: "请提交至少一条评分" }, { status: 400 });
    }

    let count = 0;

    let session: { id: string; semesterId: string; classId: string | null; date: string } | null = null;
    let sessionId: string | null = null;
    if (sessionCode) {
      session = await prisma.classSession.findUnique({
        where: { code: sessionCode },
        select: { id: true, semesterId: true, classId: true, date: true },
      });
      if (!session) {
        return NextResponse.json({ error: "课次不存在" }, { status: 404 });
      }
      sessionId = session.id;
    }

    const submittedStudentIds = Array.from(new Set([
      ...scores.map((score) => score.studentId).filter(Boolean),
      ...(attendances ?? []).map((attendance) => attendance.studentId).filter(Boolean),
    ]));
    if (submittedStudentIds.length > 0) {
      const validStudentCount = await prisma.student.count({
        where: {
          id: { in: submittedStudentIds },
          ...(session?.classId ? { classId: session.classId } : {}),
        },
      });
      if (validStudentCount !== submittedStudentIds.length) {
        return NextResponse.json({ error: "学生不存在或不属于当前课次班级" }, { status: 400 });
      }
    }

    for (const entry of scores) {
      if (!entry.studentId || (!session && !entry.date)) continue;
      const a = Math.max(0, Math.min(5, entry.scoreA ?? 3));
      const b = Math.max(0, Math.min(5, entry.scoreB ?? 3));
      const c = Math.max(0, Math.min(5, entry.scoreC ?? 3));

      const metricDate = session?.date ?? entry.date;

      if (sessionId) {
        const existing = await prisma.sessionMetric.findUnique({
          where: { studentId_sessionId: { studentId: entry.studentId, sessionId } },
        });
        if (existing) await archiveMetricBeforeUpdate(existing.id);
        await prisma.sessionMetric.upsert({
          where: { studentId_sessionId: { studentId: entry.studentId, sessionId } },
          create: { studentId: entry.studentId, date: metricDate, sessionId, scoreA: a, scoreB: b, scoreC: c, operator: "quickScore" },
          update: { scoreA: a, scoreB: b, scoreC: c },
        });
      } else {
        const existing = await prisma.sessionMetric.findFirst({
          where: { studentId: entry.studentId, date: entry.date, sessionId: null },
        });
        if (existing) {
          await archiveMetricBeforeUpdate(existing.id);
          await prisma.sessionMetric.update({ where: { id: existing.id }, data: { scoreA: a, scoreB: b, scoreC: c } });
        } else {
          await prisma.sessionMetric.create({
            data: { studentId: entry.studentId, date: entry.date, sessionId: null, scoreA: a, scoreB: b, scoreC: c, operator: "quickScore" },
          });
        }
      }

      if (entry.note && entry.note.trim() && sessionId) {
        await prisma.event.create({
          data: { studentId: entry.studentId, sessionId,
            type: "课堂表现", description: entry.note.trim(), rawText: entry.note.trim() },
        });
      }
      count++;
      // v0.11: log score update
      void logAction({
        action: "score.updated",
        targetType: "Student",
        targetId: entry.studentId,
        detail: { scoreA: a, scoreB: b, scoreC: c, operator: "quickScore", sessionCode },
      });
    }

    // Attendance + D recalc
    let attUpdated = 0;
    if (session) {
      if (attendances && Array.isArray(attendances)) {
        for (const a of attendances) {
          const result = await prisma.attendance.updateMany({
            where: { sessionId: session.id, studentId: a.studentId },
            data: { present: a.present },
          });
          attUpdated += result.count;
        }

        await recalculateScoreDForStudents({
          semesterId: session.semesterId,
          studentIds: attendances.map((attendance) => attendance.studentId),
          classId: session.classId,
          targetSessionId: session.id,
          targetDate: session.date,
          createMissingForTargetSession: true,
        });
      }
    }

    return NextResponse.json({ success: true, count, attUpdated });
  } catch (error) {
    console.error("[/api/quick-score] error:", error);
    return NextResponse.json({ error: "提交失败" }, { status: 500 });
  }
}
