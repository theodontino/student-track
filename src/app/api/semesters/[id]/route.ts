import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listSemesterClasses } from "@/services/student-enrollment-service";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";
import { assertSemesterAvailable, moveScopeToRecycleBin } from "@/services/academic-scope-recycle-service";

// GET /api/semesters/[id] - semester detail with session breakdown
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await assertSemesterAvailable(id);
    const semester = await prisma.semester.findUnique({
      where: { id },
      include: {
        sessions: {
          where: { OR: [{ classId: null }, { class: { deletedAt: null } }] },
          orderBy: { date: "desc" },
          include: {
            _count: { select: { attendances: true } },
            class: { select: { id: true, code: true, name: true } },
            groupLessonSession: { select: { groupLesson: { select: { id: true, sequence: true, title: true } } } },
          },
        },
        classes: { where: { deletedAt: null }, orderBy: { code: "asc" } },
      },
    });
    if (!semester) {
      return NextResponse.json({ error: "学期不存在" }, { status: 404 });
    }

    const classes = await listSemesterClasses(prisma, id);
    const totalStudents = await prisma.studentClassEnrollment.count({
      where: { semesterId: id, rosterStatus: "ACTIVE", class: { deletedAt: null } },
    });
    const totalSessions = semester.sessions.length;
    const attendances = await prisma.attendance.count({
      where: { session: { semesterId: id, OR: [{ classId: null }, { class: { deletedAt: null } }] } },
    });

    return NextResponse.json({
      ...semester,
      sessionCount: totalSessions,
      totalStudents,
      attendances,
      classes,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "获取学期详情失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    console.error("[/api/semesters/[id]] error:", error);
    const failure = safeApiError(error, "获取学期详情失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}

// PUT /api/semesters/[id] - update semester
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await assertSemesterAvailable(id);
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
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "更新失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    const failure = safeApiError(error, "更新失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}

// DELETE /api/semesters/[id] - delete semester
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await moveScopeToRecycleBin("semester", id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "删除失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    const failure = safeApiError(error, "删除失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
