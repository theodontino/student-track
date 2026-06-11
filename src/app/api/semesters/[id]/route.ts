import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
            class: { select: { code: true, name: true } },
          },
        },
      },
    });
    if (!semester) {
      return NextResponse.json({ error: "学期不存在" }, { status: 404 });
    }

    const totalStudents = await prisma.student.count();
    const totalSessions = semester.sessions.length;
    const attendances = await prisma.attendance.count({
      where: { session: { semesterId: id } },
    });

    return NextResponse.json({
      ...semester,
      sessionCount: totalSessions,
      totalStudents,
      attendances,
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
    await prisma.semester.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
