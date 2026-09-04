import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/services/service-error";
import { getStudentSemesterSummaries } from "@/services/student-semester-summary-service";
import {
  assertClassInSemester,
  projectStudentEnrollment,
  requireSemesterId,
  semesterStudentWhere,
} from "@/services/student-enrollment-service";

function studentInclude(semesterId: string) {
  return {
    enrollments: {
      where: { semesterId, class: { deletedAt: null, semester: { deletedAt: null } } },
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

// GET /api/students - list students projected into a semester.
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const summary = url.searchParams.get("summary") === "true";
    const semesterSummary = url.searchParams.get("semesterSummary") === "true";
    const resolvedSemesterId = await requireSemesterId(prisma, url.searchParams.get("semesterId"));
    const scope = url.searchParams.get("scope") || "all";
    if (!['active', 'all'].includes(scope)) {
      return NextResponse.json({ error: "学生范围无效" }, { status: 400 });
    }

    const scopedStudents = await prisma.student.findMany({
      where: semesterStudentWhere({ semesterId: resolvedSemesterId, activeOnly: scope === "active" }),
      orderBy: { createdAt: "desc" },
      include: studentInclude(resolvedSemesterId),
    });
    const students = scopedStudents;

    let scores: Map<string, { scoreA: number; scoreB: number; scoreC: number; scoreD: number }> | null = null;
    const semesterResult = semesterSummary
      ? await getStudentSemesterSummaries(students.map((student) => student.id), { semesterId: resolvedSemesterId })
      : null;

    if (summary && students.length > 0) {
      const latestMetrics = await prisma.sessionMetric.groupBy({
        by: ["studentId"],
        _max: { createdAt: true },
        where: {
          studentId: { in: students.map((s) => s.id) },
          session: { semesterId: resolvedSemesterId, OR: [{ classId: null }, { class: { deletedAt: null } }] },
        },
      });
      const metricIds = latestMetrics
        .map((m) => ({ studentId: m.studentId, createdAt: m._max.createdAt! }))
        .filter((m) => m.createdAt);
      if (metricIds.length > 0) {
        const metrics = await prisma.sessionMetric.findMany({
          where: {
            OR: metricIds.map((m) => ({ studentId: m.studentId, createdAt: m.createdAt })),
            session: { semesterId: resolvedSemesterId, OR: [{ classId: null }, { class: { deletedAt: null } }] },
          },
          select: { studentId: true, scoreA: true, scoreB: true, scoreC: true, scoreD: true },
        });
        scores = new Map(metrics.map((m) => [m.studentId, m]));
      }
    }

    return NextResponse.json(students.map((student) => ({
      ...serializeStudent(student),
      ...(scores && { scores: scores.get(student.id) ?? null }),
      ...(semesterSummary && { semesterSummary: semesterResult?.summaries.get(student.id) ?? null }),
    })));
  } catch (error) {
    console.error("[/api/students] error:", error);
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "获取学生列表失败" }, { status: 500 });
  }
}

// POST /api/students - create a stable profile plus one semester enrollment.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const semesterId = await requireSemesterId(prisma, body.semesterId);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const studentId = typeof body.studentId === "string" ? body.studentId.trim() : "";
    const gender = typeof body.gender === "string" ? body.gender.trim() : "";
    const classId = typeof body.classId === "string" ? body.classId : undefined;
    const code = typeof (body.classCode || body.class) === "string" ? String(body.classCode || body.class).trim() : "";
    if (!name || (!classId && !code) || !studentId || !gender) {
      return NextResponse.json({ error: "姓名、学期、班级、学号、性别为必填项" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      let selectedClass = classId ? await assertClassInSemester(tx, classId, semesterId) : null;
      if (!selectedClass) {
        const matches = await tx.class.findMany({
          where: { semesterId, OR: [{ code }, { name: code }] },
          select: { id: true, code: true, name: true, semesterId: true },
        });
        if (matches.length > 1) throw new ServiceError("班级名称不唯一，请使用 classId", 409);
        selectedClass = matches[0]
          ? await assertClassInSemester(tx, matches[0].id, semesterId)
          : null;
      }
      if (!selectedClass) throw new ServiceError("班级不存在", 404);
      const student = await tx.student.create({ data: { name, studentId, gender } });
      await tx.studentClassEnrollment.create({
        data: { studentId: student.id, semesterId, classId: selectedClass.id },
      });
      const labelNames = Array.isArray(body.labelNames) ? body.labelNames : [];
      for (const labelName of labelNames) {
        if (typeof labelName !== "string" || !labelName.trim()) continue;
        let label = await tx.label.findUnique({ where: { name: labelName.trim() } });
        if (!label) label = await tx.label.create({ data: { name: labelName.trim() } });
        await tx.studentLabel.create({ data: { studentId: student.id, labelId: label.id } });
      }
      return tx.student.findUniqueOrThrow({ where: { id: student.id, }, include: studentInclude(semesterId) });
    });
    return NextResponse.json(serializeStudent(result), { status: 201 });
  } catch (error: any) {
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error?.code === "P2002") return NextResponse.json({ error: "学号已存在" }, { status: 409 });
    console.error("[/api/students] error:", error);
    return NextResponse.json({ error: "创建学生失败" }, { status: 500 });
  }
}
