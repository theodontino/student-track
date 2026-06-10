import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { logAction } from "@/lib/logger";

// POST /api/semesters/[id]/session - create today's class session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: semesterId } = await params;
    const body = await request.json().catch(() => ({}));
    const classCode: string | undefined = body.classCode || body.className || undefined;
    const today = new Date().toISOString().split("T")[0];

    // Resolve classId from classCode or className
    let classId: string | null = null;
    if (classCode) {
      const cls = await prisma.class.findFirst({
        where: { OR: [{ code: classCode }, { name: classCode }] },
      });
      classId = cls?.id ?? null;
    }

    // Generate code: YYYYMMDDNN
    const dateCode = today.replace(/-/g, "");
    const todaySessions = await prisma.classSession.findMany({
      where: { code: { startsWith: dateCode } },
      orderBy: { code: "desc" },
      take: 1,
    });

    let seq = 1;
    if (todaySessions.length > 0) {
      const lastSeq = parseInt(todaySessions[0].code.slice(-2), 10);
      seq = lastSeq + 1;
    }
    if (seq > 99) {
      return NextResponse.json({ error: "今日课次已达上限（99）" }, { status: 400 });
    }
    const code = dateCode + String(seq).padStart(2, "0");

    const existing = await prisma.classSession.findUnique({ where: { code } });
    if (existing) {
      return NextResponse.json({ error: "课次编码已存在", existing }, { status: 409 });
    }

    // Get next semester number (per-classId within semester)
    const lastSession = await prisma.classSession.findFirst({
      where: { semesterId, classId },
      orderBy: { semesterNumber: "desc" },
    });
    const nextNumber = (lastSession?.semesterNumber ?? 0) + 1;

    // Create session
    const session = await prisma.classSession.create({
      data: { code, semesterId, semesterNumber: nextNumber, date: today, classId },
    });

    // Auto-create attendance: scoped to class if specified
    const studentWhere = classId ? { classId } : {};
    const students = await prisma.student.findMany({
      where: studentWhere,
      select: { id: true },
    });

    if (students.length > 0) {
      await prisma.attendance.createMany({
        data: students.map((s) => ({
          sessionId: session.id,
          studentId: s.id,
          present: true,
        })),
      });
    }

    await recalculateScoreD(semesterId, today);

    // v0.11: log session creation
    logAction({
      action: "session.created",
      targetType: "Session",
      targetId: session.id,
      targetName: code,
      detail: { date: today, class: classCode, studentCount: students.length },
    });

    return NextResponse.json(
      { ...session, studentCount: students.length },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST session error:", error);
    return NextResponse.json({ error: "创建课次失败" }, { status: 500 });
  }
}

// DELETE /api/semesters/[id]/session - delete a session by code
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: semesterId } = await params;
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");

    if (!code) {
      return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });
    }

    const session = await prisma.classSession.findUnique({ where: { code } });
    if (!session || session.semesterId !== semesterId) {
      return NextResponse.json({ error: "课次不存在或不属于该学期" }, { status: 404 });
    }

    const today = new Date().toISOString().split("T")[0];

    // v0.11: log session deletion
    logAction({
      action: "session.deleted",
      targetType: "Session",
      targetId: session.id,
      targetName: code,
      detail: { date: session.date, semesterNumber: session.semesterNumber },
    });

    await prisma.classSession.delete({ where: { code } });
    await reorderSemesterNumbers(semesterId);
    await recalculateScoreD(semesterId, today);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE session error:", error);
    return NextResponse.json({ error: "删除课次失败" }, { status: 500 });
  }
}

// Helper: reorder semesterNumber per-classId (each class has independent numbering)
async function reorderSemesterNumbers(semesterId: string) {
  const classIds = await prisma.classSession.findMany({
    where: { semesterId },
    select: { classId: true },
    distinct: ["classId"],
  });

  for (const { classId } of classIds) {
    const sessions = await prisma.classSession.findMany({
      where: { semesterId, classId },
      orderBy: { code: "asc" },
      select: { code: true },
    });
    for (let i = 0; i < sessions.length; i++) {
      await prisma.classSession.update({
        where: { code: sessions[i].code },
        data: { semesterNumber: i + 1 },
      });
    }
  }
}

// Helper: recalculate scoreD = ROUND(5 * present_count / total_sessions)
// v0.11.4: 按学生班级过滤分母（含全校课次 classId=null），修复多班 D 分失真
async function recalculateScoreD(semesterId: string, date: string) {
  const students = await prisma.student.findMany({
    select: { id: true, classId: true },
  });

  for (const student of students) {
    const totalSessions = await prisma.classSession.count({
      where: {
        semesterId,
        OR: [
          { classId: student.classId },
          { classId: null },
        ],
      },
    });
    if (totalSessions === 0) continue;

    const presentCount = await prisma.attendance.count({
      where: {
        studentId: student.id,
        present: true,
        session: {
          semesterId,
          OR: [
            { classId: student.classId },
            { classId: null },
          ],
        },
      },
    });

    const scoreD = Math.round((5 * presentCount) / totalSessions);

    const latestMetric = await prisma.sessionMetric.findFirst({
      where: { studentId: student.id },
      orderBy: { createdAt: "desc" },
    });
    if (latestMetric) {
      await archiveMetricBeforeUpdate(latestMetric.id);
      await prisma.sessionMetric.update({ where: { id: latestMetric.id }, data: { scoreD } });
    } else {
      await prisma.sessionMetric.create({
        data: { studentId: student.id, date, sessionId: null, scoreA: 3, scoreB: 3, scoreC: 3, scoreD, operator: "system" },
      });
    }
  }
}
