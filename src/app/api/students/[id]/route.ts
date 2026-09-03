import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAction, logStudentEnrollmentTransfer } from "@/lib/logger";
import { ServiceError } from "@/services/service-error";
import { localDate } from "@/services/semester-service";
import { getStudentSemesterSummaries } from "@/services/student-semester-summary-service";
import {
  assertClassInSemester,
  changeStudentEnrollmentClass,
  projectStudentEnrollment,
  requireSemesterId,
} from "@/services/student-enrollment-service";

function studentInclude(semesterId: string) {
  return {
    enrollments: {
      where: { semesterId, semester: { deletedAt: null }, class: { deletedAt: null } },
      include: { class: { select: { id: true, code: true, name: true, semesterId: true } } },
    },
    studentLabels: { include: { label: { select: { id: true, name: true } } } },
  } as const;
}

function serializeStudent(student: any) {
  const projection = projectStudentEnrollment(student.enrollments ?? []);
  return {
    ...student,
    enrollments: undefined,
    class: projection.class?.name ?? projection.class?.code ?? "",
    classId: projection.classId,
    classCode: projection.classCode,
    rosterStatus: projection.rosterStatus,
    statusEffectiveAt: projection.statusEffectiveAt,
    labels: (student.studentLabels ?? []).map((sl: any) => ({ id: sl.label.id, name: sl.label.name })),
    studentLabels: undefined,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const semesterId = await requireSemesterId(prisma, url.searchParams.get("semesterId"));
    const eventLimit = Math.min(parseInt(url.searchParams.get("eventLimit") || "20"), 100);
    const eventOffset = parseInt(url.searchParams.get("eventOffset") || "0");
    const commLimit = Math.min(parseInt(url.searchParams.get("commLimit") || "20"), 100);
    const commOffset = parseInt(url.searchParams.get("commOffset") || "0");
    const semesterSummary = url.searchParams.get("semesterSummary") === "true";

    const student = await prisma.student.findUnique({
      where: { id },
      include: studentInclude(semesterId),
    });
    if (!student) return NextResponse.json({ error: "学生不存在" }, { status: 404 });

    const semesterResult = semesterSummary
      ? await getStudentSemesterSummaries([id], { semesterId })
      : null;
    const asOfDate = localDate(new Date());
    // The detail page is semester-scoped even when a legacy caller omitted
    // semesterId: requireSemesterId has already resolved the current term.
    const sessionFilter = {
      semesterId,
      date: { lte: asOfDate },
      semester: { deletedAt: null },
      OR: [{ classId: null }, { class: { deletedAt: null } }],
    };
    const relatedSessionFilter = { session: sessionFilter };
    const metricSessionFilter = { session: { is: sessionFilter } };

    const [events, communications, sessionMetrics, attendances] = await Promise.all([
      prisma.event.findMany({
        where: { studentId: id, ...relatedSessionFilter },
        include: { session: { select: { date: true, code: true, semesterNumber: true } } },
        orderBy: { createdAt: "desc" }, take: eventLimit + 1, skip: eventOffset,
      }),
      prisma.communication.findMany({
        where: { studentId: id, ...relatedSessionFilter },
        include: { session: { select: { date: true, code: true } } },
        orderBy: { createdAt: "desc" }, take: commLimit + 1, skip: commOffset,
      }),
      prisma.sessionMetric.findMany({
        where: { studentId: id, ...metricSessionFilter },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 365,
      }),
      semesterSummary
        ? prisma.attendance.findMany({
            where: { studentId: id, session: sessionFilter },
            include: { session: { select: { date: true, semesterNumber: true, code: true } } },
            orderBy: [{ session: { date: "desc" } }, { createdAt: "desc" }],
          })
        : Promise.resolve(undefined),
    ]);

    return NextResponse.json({
      ...serializeStudent(student),
      sessionMetrics,
      events: events.slice(0, eventLimit),
      communications: communications.slice(0, commLimit),
      ...(semesterSummary && { semesterSummary: semesterResult?.summaries.get(id) ?? null, attendances: attendances ?? [] }),
      _pagination: { eventHasMore: events.length > eventLimit, commHasMore: communications.length > commLimit },
    });
  } catch (error) {
    console.error("[/api/students/[id]] error:", error);
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "获取学生详情失败" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const semesterId = await requireSemesterId(prisma, body.semesterId);
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.student.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new ServiceError("学生不存在", 404);
      await tx.student.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.studentId !== undefined && { studentId: body.studentId }),
          ...(body.gender !== undefined && { gender: body.gender }),
        },
      });

      let enrollmentChange: Awaited<ReturnType<typeof changeStudentEnrollmentClass>> | null = null;
      const classId = typeof body.classId === "string" ? body.classId : undefined;
      const classCode = typeof (body.classCode || body.class) === "string" ? String(body.classCode || body.class).trim() : "";
      if (classId || classCode) {
        let selectedClass = classId ? await assertClassInSemester(tx, classId, semesterId) : null;
        if (!selectedClass) {
          const matches = await tx.class.findMany({
            where: { semesterId, OR: [{ code: classCode }, { name: classCode }] },
            select: { id: true, code: true, name: true, semesterId: true },
          });
          if (matches.length > 1) throw new ServiceError("班级名称不唯一，请使用 classId", 409);
          selectedClass = matches[0] ?? null;
        }
        if (!selectedClass) throw new ServiceError("班级不存在", 404);
        enrollmentChange = await changeStudentEnrollmentClass(tx, { studentId: id, semesterId, classId: selectedClass.id }, { createIfMissing: true });
      }

      if (body.labelNames !== undefined) {
        await tx.studentLabel.deleteMany({ where: { studentId: id } });
        for (const rawName of Array.isArray(body.labelNames) ? body.labelNames : []) {
          if (typeof rawName !== "string" || !rawName.trim()) continue;
          let label = await tx.label.findUnique({ where: { name: rawName.trim() } });
          if (!label) label = await tx.label.create({ data: { name: rawName.trim() } });
          await tx.studentLabel.create({ data: { studentId: id, labelId: label.id } });
        }
      }
      return {
        student: await tx.student.findUniqueOrThrow({ where: { id }, include: studentInclude(semesterId) }),
        enrollmentChange,
      };
    });
    if (result.enrollmentChange?.changed && result.enrollmentChange.previousClass) {
      await logStudentEnrollmentTransfer({
        studentId: result.student.id,
        studentName: result.student.name,
        semesterId,
        previousClass: result.enrollmentChange.previousClass,
        currentClass: result.enrollmentChange.enrollment.class,
      });
    }
    return NextResponse.json(serializeStudent(result.student));
  } catch (error: any) {
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error?.code === "P2002") return NextResponse.json({ error: "学号已存在" }, { status: 409 });
    if (error?.code === "P2025") return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    console.error("[/api/students/[id]] error:", error);
    return NextResponse.json({ error: "更新学生失败" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const student = await prisma.student.findUnique({ where: { id }, select: { name: true, studentId: true } });
    await prisma.student.delete({ where: { id } });
    if (student) void logAction({ action: "student.deleted", targetType: "Student", targetId: id, targetName: student.name, detail: { studentId: student.studentId } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error?.code === "P2025") return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    console.error("[/api/students/[id]] error:", error);
    return NextResponse.json({ error: "删除学生失败" }, { status: 500 });
  }
}
