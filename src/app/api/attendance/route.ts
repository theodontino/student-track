import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/attendance?sessionId=xxx - get attendance for a session
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");

    if (!sessionId) {
      return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
    }

    const records = await prisma.attendance.findMany({
      where: { sessionId },
      include: { student: { select: { name: true, class: true } } },
      orderBy: { student: { name: "asc" } },
    });

    return NextResponse.json(records);
  } catch (error) {
    console.error("GET /api/attendance error:", error);
    return NextResponse.json({ error: "获取考勤失败" }, { status: 500 });
  }
}

// PUT /api/attendance - batch update attendance
export async function PUT(request: NextRequest) {
  try {
    const { sessionId, updates } = await request.json();
    // updates: { studentId: string, present: boolean }[]

    if (!sessionId || !updates || !Array.isArray(updates)) {
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }

    for (const u of updates) {
      await prisma.attendance.updateMany({
        where: { sessionId, studentId: u.studentId },
        data: { present: u.present },
      });
    }

    // Recalculate scoreD for affected students using date-based semester
    const today = new Date().toISOString().split("T")[0];

    // Find current semester by date (not createdAt)
    const semester = await prisma.semester.findFirst({
      where: {
        startDate: { lte: today },
        endDate: { gte: today },
      },
    });

    // If no semester covers today, fall back to the most recent
    const activeSemester = semester || await prisma.semester.findFirst({
      orderBy: { createdAt: "desc" },
    });

    if (activeSemester) {
      const totalSessions = await prisma.classSession.count({
        where: { semesterId: activeSemester.id },
      });

      for (const u of updates) {
        const presentCount = await prisma.attendance.count({
          where: {
            studentId: u.studentId,
            present: true,
            session: { semesterId: activeSemester.id },
          },
        });

        const scoreD = totalSessions > 0
          ? Math.round((5 * presentCount) / totalSessions)
          : 3;

        // v0.4: update scoreD on student's latest metric (don't create A/B/C=0 rows)
        const latestMetric = await prisma.dailyMetric.findFirst({
          where: { studentId: u.studentId },
          orderBy: { createdAt: "desc" },
        });
        if (latestMetric) {
          await prisma.dailyMetric.update({ where: { id: latestMetric.id }, data: { scoreD } });
        } else {
          await prisma.dailyMetric.create({
            data: { studentId: u.studentId, date: today, sessionId: null, scoreA: 3, scoreB: 3, scoreC: 3, scoreD },
          });
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("PUT /api/attendance error:", error);
    return NextResponse.json({ error: "更新考勤失败" }, { status: 500 });
  }
}
