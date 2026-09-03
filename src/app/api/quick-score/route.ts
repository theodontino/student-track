import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  submitQuickScores,
  type QuickAttendanceEntry,
  type QuickScoreEntry,
} from "@/services/quick-score-service";
import { ServiceError } from "@/services/service-error";
import { requireSemesterId } from "@/services/student-enrollment-service";
import { assertClassAvailable, assertSessionAvailable } from "@/services/academic-scope-recycle-service";
import { ApiError, apiErrorBody } from "@/lib/api-errors";

// GET /api/quick-score?class=&date=&sessionCode= — get existing scores for a class/session
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const className = searchParams.get("class");
    const requestedClassId = searchParams.get("classId");
    const requestedSemesterId = searchParams.get("semesterId");
    const date = searchParams.get("date");
    const sessionCode = searchParams.get("sessionCode");

    if ((!className && !requestedClassId) || (!date && !sessionCode)) {
      return NextResponse.json({ error: "缺少 class 以及 date 或 sessionCode 参数" }, { status: 400 });
    }

    const semesterId = await requireSemesterId(prisma, requestedSemesterId);
    // Resolve classId inside the selected semester; classId is preferred.
    const classMatches = requestedClassId
      ? []
      : await prisma.class.findMany({ where: { semesterId, OR: [{ name: className ?? "" }, { code: className ?? "" }] } });
    const cls = requestedClassId
      ? await prisma.class.findUnique({ where: { id: requestedClassId } })
      : classMatches.length === 1 ? classMatches[0] : null;
    const classId = cls?.id;
    if (!classId) {
      return NextResponse.json({ error: "班级不存在" }, { status: 404 });
    }
    await assertClassAvailable(classId);
    if (cls.semesterId !== semesterId) return NextResponse.json({ error: "班级不属于所选学期" }, { status: 409 });

    let targetDate = date;
    let targetSession: { id: string; code: string; semesterNumber: number; date: string; classId: string | null; semesterId: string } | null = null;

    if (sessionCode) {
      targetSession = await prisma.classSession.findUnique({
        where: { code: sessionCode },
        select: { id: true, code: true, semesterNumber: true, date: true, classId: true, semesterId: true },
      });

      if (!targetSession) {
        return NextResponse.json({ error: "课次不存在" }, { status: 404 });
      }
      await assertSessionAvailable(targetSession.id);

      if (targetSession.semesterId !== semesterId) {
        return NextResponse.json({ error: "课次不属于所选学期" }, { status: 409 });
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
      where: {
        OR: [
          { enrollments: { some: { semesterId, classId, rosterStatus: "ACTIVE" } } },
          ...(targetSession
            ? [
                { sessionMetrics: { some: { sessionId: targetSession.id } } },
                { attendances: { some: { sessionId: targetSession.id } } },
              ]
            : [
                { sessionMetrics: { some: { date: targetDate, sessionId: null } } },
              ]),
        ],
      },
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

    let sessions: { id: string; code: string; semesterNumber: number; date: string; classId: string | null; semesterId?: string }[] = [];
    let attendanceSessionId = targetSession?.id;

    if (targetSession) {
      sessions = [{
        id: targetSession.id, code: targetSession.code,
        semesterNumber: targetSession.semesterNumber, date: targetSession.date, classId: targetSession.classId, semesterId,
      }];
    } else {
      sessions = await prisma.classSession.findMany({
        where: { date: targetDate, semesterId, classId },
        select: { id: true, code: true, semesterNumber: true, date: true, classId: true, semesterId: true },
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
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    return NextResponse.json({ error: "获取评分数据失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scores, sessionCode, attendances } = body as {
      scores: QuickScoreEntry[];
      sessionCode?: string;
      attendances?: QuickAttendanceEntry[];
    };
    return NextResponse.json(await submitQuickScores({ scores, sessionCode, attendances }));
  } catch (error) {
    console.error("[/api/quick-score] error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    return NextResponse.json({ error: "提交失败" }, { status: 500 });
  }
}
