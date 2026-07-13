import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/logger";
import { ServiceError } from "@/services/service-error";
import { localDate } from "@/services/semester-service";
import { getStudentSemesterSummaries } from "@/services/student-semester-summary-service";

// GET /api/students/[id] - get student with metrics, events, communications
// v0.11: events/communications 支持分页参数 ?eventLimit=20&eventOffset=0&commLimit=20&commOffset=0
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const eventLimit = Math.min(parseInt(url.searchParams.get("eventLimit") || "20"), 100);
    const eventOffset = parseInt(url.searchParams.get("eventOffset") || "0");
    const commLimit = Math.min(parseInt(url.searchParams.get("commLimit") || "20"), 100);
    const commOffset = parseInt(url.searchParams.get("commOffset") || "0");
    const semesterSummary = url.searchParams.get("semesterSummary") === "true";
    const semesterId = url.searchParams.get("semesterId") || undefined;

    const student = await prisma.student.findUnique({
      where: { id },
      include: {
        class: { select: { id: true, code: true, name: true } },
        studentLabels: { include: { label: { select: { id: true, name: true } } } },
      },
    });

    if (!student) {
      return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    }

    const semesterResult = semesterSummary
      ? await getStudentSemesterSummaries([id], { semesterId })
      : null;
    const resolvedSemesterId = semesterResult?.semester?.id;
    const asOfDate = localDate(new Date());
    const sessionFilter = resolvedSemesterId
      ? { semesterId: resolvedSemesterId, date: { lte: asOfDate } }
      : undefined;
    const relatedSessionFilter = sessionFilter ? { session: sessionFilter } : {};
    const metricSessionFilter = sessionFilter ? { session: { is: sessionFilter } } : {};

    // Fetch one extra to determine hasMore after semester filtering.
    const [events, communications, sessionMetrics, attendances] = await Promise.all([
      prisma.event.findMany({
        where: { studentId: id, ...relatedSessionFilter },
        include: { session: { select: { date: true, code: true, semesterNumber: true } } },
        orderBy: { createdAt: "desc" },
        take: eventLimit + 1,
        skip: eventOffset,
      }),
      prisma.communication.findMany({
        where: { studentId: id, ...relatedSessionFilter },
        include: { session: { select: { date: true, code: true } } },
        orderBy: { createdAt: "desc" },
        take: commLimit + 1,
        skip: commOffset,
      }),
      prisma.sessionMetric.findMany({
        where: { studentId: id, ...metricSessionFilter },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 365,
      }),
      semesterSummary && sessionFilter
        ? prisma.attendance.findMany({
            where: { studentId: id, ...relatedSessionFilter },
            include: { session: { select: { date: true, semesterNumber: true, code: true } } },
            orderBy: [{ session: { date: "desc" } }, { createdAt: "desc" }],
          })
        : Promise.resolve(undefined),
    ]);

    return NextResponse.json({
      ...student,
      sessionMetrics,
      class: student.class?.name ?? student.class?.code ?? "",
      labels: student.studentLabels.map((sl) => ({ id: sl.label.id, name: sl.label.name })),
      events: events.slice(0, eventLimit),
      communications: communications.slice(0, commLimit),
      ...(semesterSummary && {
        semesterSummary: semesterResult?.summaries.get(id) ?? null,
        attendances: attendances ?? [],
      }),
      _pagination: {
        eventHasMore: events.length > eventLimit,
        commHasMore: communications.length > commLimit,
      },
    });
  } catch (error) {
    console.error("[/api/students/[id]] error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "获取学生详情失败" }, { status: 500 });
  }
}

// PUT /api/students/[id] - update student
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, classCode, class: className, studentId, gender, labelNames } = body;
    const code = classCode || className;

    let classId: string | undefined;
    if (code) {
      const cls = await prisma.class.findFirst({
        where: { OR: [{ code }, { name: code }] },
      });
      if (!cls) return NextResponse.json({ error: "班级不存在" }, { status: 400 });
      classId = cls.id;
    }

    // v0.13: sync labels via StudentLabel
    if (labelNames !== undefined) {
      await prisma.studentLabel.deleteMany({ where: { studentId: id } });
      for (const name of labelNames) {
        let label = await prisma.label.findUnique({ where: { name } });
        if (!label) label = await prisma.label.create({ data: { name } });
        await prisma.studentLabel.create({ data: { studentId: id, labelId: label.id } });
      }
    }

    await prisma.student.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(classId !== undefined && { classId }),
        ...(studentId !== undefined && { studentId }),
        ...(gender !== undefined && { gender }),
      },
    });

    const student = await prisma.student.findUnique({
      where: { id },
      include: {
        class: { select: { code: true, name: true } },
        studentLabels: { include: { label: { select: { id: true, name: true } } } },
      },
    });

    return NextResponse.json({
      ...student,
      class: student?.class?.name ?? student?.class?.code ?? "",
      labels: (student?.studentLabels || []).map((sl) => ({ id: sl.label.id, name: sl.label.name })),
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json({ error: "学号已存在" }, { status: 409 });
    }
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    }
    console.error("[/api/students/[id]] error:", error);
    return NextResponse.json({ error: "更新学生失败" }, { status: 500 });
  }
}

// DELETE /api/students/[id] - delete student
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // v0.11: fetch name before delete for logging
    const student = await prisma.student.findUnique({ where: { id }, select: { name: true, studentId: true } });
    await prisma.student.delete({ where: { id } });
    if (student) {
      void logAction({
        action: "student.deleted",
        targetType: "Student",
        targetId: id,
        targetName: student.name,
        detail: { studentId: student.studentId },
      });
    }
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    }
    console.error("[/api/students/[id]] error:", error);
    return NextResponse.json({ error: "删除学生失败" }, { status: 500 });
  }
}
