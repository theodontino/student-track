import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/semesters/[id]/session - create today's class session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: semesterId } = await params;
    const body = await request.json().catch(() => ({}));
    const className: string | undefined = body.className || undefined;
    const today = new Date().toISOString().split("T")[0];

    // Generate code: YYYYMMDDNN
    const dateCode = today.replace(/-/g, ""); // "20260604"
    // Find existing sessions for today to determine sequence number
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

    // Check if this specific code already exists (safety)
    const existing = await prisma.classSession.findUnique({ where: { code } });
    if (existing) {
      return NextResponse.json({ error: "课次编码已存在", existing }, { status: 409 });
    }

    // Get next semester number
    const lastSession = await prisma.classSession.findFirst({
      where: { semesterId },
      orderBy: { semesterNumber: "desc" },
    });
    const nextNumber = (lastSession?.semesterNumber ?? 0) + 1;

    // Create session
    const session = await prisma.classSession.create({
      data: {
        code,
        semesterId,
        semesterNumber: nextNumber,
        date: today,
        class: className ?? null,
      },
    });

    // Auto-create attendance: scoped to class if specified
    const studentWhere = className ? { class: className } : {};
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

    // Recalculate scoreD for students in this semester
    await recalculateScoreD(semesterId, today);

    return NextResponse.json(
      {
        ...session,
        studentCount: students.length,
      },
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

    // Delete session (cascade deletes attendance)
    await prisma.classSession.delete({ where: { code } });

    // Reorder semester numbers
    await reorderSemesterNumbers(semesterId);

    // Recalculate D
    await recalculateScoreD(semesterId, today);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE session error:", error);
    return NextResponse.json({ error: "删除课次失败" }, { status: 500 });
  }
}

// Helper: reorder semesterNumber for all sessions in a semester (by code order)
async function reorderSemesterNumbers(semesterId: string) {
  const sessions = await prisma.classSession.findMany({
    where: { semesterId },
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

// Helper: recalculate scoreD = ROUND(5 * present_count / total_sessions)
// Using date-based current semester detection
async function recalculateScoreD(semesterId: string, date: string) {
  const totalSessions = await prisma.classSession.count({
    where: { semesterId },
  });
  if (totalSessions === 0) return;

  // Get students who have attendance in this semester
  const students = await prisma.student.findMany({
    select: { id: true },
  });

  for (const student of students) {
    const presentCount = await prisma.attendance.count({
      where: {
        studentId: student.id,
        present: true,
        session: { semesterId },
      },
    });

    const scoreD = Math.round((5 * presentCount) / totalSessions);

    // scoreD protection: only touch scoreD, not A/B/C
    await prisma.dailyMetric.upsert({
      where: { studentId_date: { studentId: student.id, date } },
      create: {
        studentId: student.id,
        date,
        scoreA: 0,
        scoreB: 0,
        scoreC: 0,
        scoreD,
      },
      update: { scoreD },
    });
  }
}
