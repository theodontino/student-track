import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateSessionAttendance, type AttendanceUpdate } from "@/services/attendance-service";
import { ServiceError } from "@/services/service-error";
import { requireSemesterId } from "@/services/student-enrollment-service";

// GET /api/attendance?sessionId=xxx - get attendance for a session
// GET /api/attendance?studentId=xxx - get attendance history for a student
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");
    const studentId = searchParams.get("studentId");
    const requestedSemesterId = searchParams.get("semesterId");

    if (!sessionId && !studentId) {
      return NextResponse.json({ error: "缺少 sessionId 或 studentId" }, { status: 400 });
    }

    if (studentId) {
      const semesterId = requestedSemesterId ? await requireSemesterId(prisma, requestedSemesterId) : undefined;
      const records = await prisma.attendance.findMany({
        where: { studentId, ...(sessionId ? { sessionId } : {}), ...(semesterId ? { session: { semesterId } } : {}) },
        include: { session: { select: { date: true, semesterNumber: true, code: true } } },
        orderBy: { createdAt: "desc" },
      });

      records.sort((a, b) => (
        b.session.date.localeCompare(a.session.date)
        || b.createdAt.getTime() - a.createdAt.getTime()
      ));

      return NextResponse.json(records);
    }

    if (!sessionId) {
      return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
    }

    const session = await prisma.classSession.findUnique({ where: { id: sessionId }, select: { semesterId: true } });
    if (!session) return NextResponse.json({ error: "课次不存在" }, { status: 404 });
    const records = await prisma.attendance.findMany({
      where: { sessionId },
      include: {
        student: {
          select: {
            name: true,
            enrollments: {
              where: { semesterId: session.semesterId },
              include: { class: { select: { name: true, code: true } } },
            },
          },
        },
      },
      orderBy: { student: { name: "asc" } },
    });

    return NextResponse.json(records.map((record) => ({
      ...record,
      student: {
        ...record.student,
        class: record.student.enrollments[0]?.class ?? null,
        enrollments: undefined,
      },
    })));
  } catch (error) {
    console.error("[/api/attendance] error:", error);
    return NextResponse.json({ error: "获取考勤失败" }, { status: 500 });
  }
}

// PUT /api/attendance - batch update attendance
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as { sessionId: string; updates: AttendanceUpdate[] };
    return NextResponse.json(await updateSessionAttendance(body.sessionId, body.updates));
  } catch (error) {
    console.error("[/api/attendance] error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "更新考勤失败" }, { status: 500 });
  }
}
