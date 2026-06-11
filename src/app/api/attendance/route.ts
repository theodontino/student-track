import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recalculateScoreDForStudents } from "@/lib/scoreD";

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
      include: { student: { select: { name: true, class: { select: { name: true } } } } },
      orderBy: { student: { name: "asc" } },
    });

    return NextResponse.json(records);
  } catch (error) {
    console.error("[/api/attendance] error:", error);
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

    const session = await prisma.classSession.findUnique({
      where: { id: sessionId },
      select: { id: true, semesterId: true, classId: true, date: true },
    });
    if (!session) {
      return NextResponse.json({ error: "课次不存在" }, { status: 404 });
    }

    const studentIds = Array.from(new Set(updates.map((update) => update.studentId).filter(Boolean)));
    if (studentIds.length > 0) {
      const validStudentCount = await prisma.student.count({
        where: {
          id: { in: studentIds },
          ...(session.classId ? { classId: session.classId } : {}),
        },
      });
      if (validStudentCount !== studentIds.length) {
        return NextResponse.json({ error: "学生不存在或不属于当前课次班级" }, { status: 400 });
      }
    }

    for (const u of updates) {
      await prisma.attendance.updateMany({
        where: { sessionId, studentId: u.studentId },
        data: { present: u.present },
      });
    }

    await recalculateScoreDForStudents({
      semesterId: session.semesterId,
      studentIds,
      classId: session.classId,
      targetSessionId: session.id,
      targetDate: session.date,
      createMissingForTargetSession: true,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[/api/attendance] error:", error);
    return NextResponse.json({ error: "更新考勤失败" }, { status: 500 });
  }
}
