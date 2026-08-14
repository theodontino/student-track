import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listSemesterClasses } from "@/services/student-enrollment-service";

// GET /api/semesters/[id] - semester detail with session breakdown
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const semester = await prisma.semester.findUnique({
      where: { id },
      include: {
        sessions: {
          orderBy: { date: "desc" },
          include: {
            _count: { select: { attendances: true } },
            class: { select: { id: true, code: true, name: true } },
            groupLessonSession: { select: { groupLesson: { select: { id: true, sequence: true, title: true } } } },
          },
        },
        classes: { orderBy: { code: "asc" } },
      },
    });
    if (!semester) {
      return NextResponse.json({ error: "学期不存在" }, { status: 404 });
    }

    const classes = await listSemesterClasses(prisma, id);
    const totalStudents = await prisma.studentClassEnrollment.count({
      where: { semesterId: id, rosterStatus: "ACTIVE" },
    });
    const totalSessions = semester.sessions.length;
    const attendances = await prisma.attendance.count({
      where: { session: { semesterId: id } },
    });

    return NextResponse.json({
      ...semester,
      sessionCount: totalSessions,
      totalStudents,
      attendances,
      classes,
    });
  } catch (error) {
    console.error("[/api/semesters/[id]] error:", error);
    return NextResponse.json({ error: "获取学期详情失败" }, { status: 500 });
  }
}

// PUT /api/semesters/[id] - update semester
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { name, startDate, endDate } = await request.json();
    const semester = await prisma.semester.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(startDate !== undefined && { startDate }),
        ...(endDate !== undefined && { endDate }),
      },
    });
    return NextResponse.json(semester);
  } catch {
    return NextResponse.json({ error: "更新失败" }, { status: 500 });
  }
}

// DELETE /api/semesters/[id] - delete semester
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const [classes, enrollments, sessions, plans, memories, tasks, compactions, generations] = await Promise.all([
      prisma.class.count({ where: { semesterId: id } }),
      prisma.studentClassEnrollment.count({ where: { semesterId: id } }),
      prisma.classSession.count({ where: { semesterId: id } }),
      prisma.feedbackPlan.count({ where: { semesterId: id } }),
      prisma.teachingMemory.count({ where: { semesterId: id } }),
      prisma.teacherTask.count({ where: { plan: { semesterId: id } } }),
      prisma.memoryCompactionRun.count({ where: { semesterId: id } }),
      prisma.generationRecord.count({ where: { semesterId: id } }),
    ]);
    if (classes || enrollments || sessions || plans || memories || tasks || compactions || generations) {
      return NextResponse.json({ error: "学期已有班级或业务记录，不能直接删除" }, { status: 409 });
    }
    await prisma.semester.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
