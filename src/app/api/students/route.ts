import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/services/service-error";
import { getStudentSemesterSummaries } from "@/services/student-semester-summary-service";

// v0.13: include labels from StudentLabel + Label
const studentInclude = {
  class: { select: { id: true, code: true, name: true } },
  studentLabels: { include: { label: { select: { id: true, name: true } } } },
};

// GET /api/students - list all students  [?summary=true]
export async function GET(request: NextRequest) {
  try {
    const summary = new URL(request.url).searchParams.get("summary") === "true";
    const semesterSummary = new URL(request.url).searchParams.get("semesterSummary") === "true";
    const semesterId = new URL(request.url).searchParams.get("semesterId") || undefined;

    const students = await prisma.student.findMany({
      orderBy: { createdAt: "desc" },
      include: studentInclude,
    });

    let scores: Map<string, { scoreA: number; scoreB: number; scoreC: number; scoreD: number }> | null = null;
    const semesterResult = semesterSummary
      ? await getStudentSemesterSummaries(students.map((student) => student.id), { semesterId })
      : null;

    if (summary) {
      const latestMetrics = await prisma.sessionMetric.groupBy({
        by: ["studentId"],
        _max: { createdAt: true },
        where: { studentId: { in: students.map((s) => s.id) } },
      });
      const metricIds = latestMetrics
        .map((m) => ({ studentId: m.studentId, createdAt: m._max.createdAt! }))
        .filter((m) => m.createdAt);
      if (metricIds.length > 0) {
        const metrics = await prisma.sessionMetric.findMany({
          where: { OR: metricIds.map((m) => ({ studentId: m.studentId, createdAt: m.createdAt })) },
          select: { studentId: true, scoreA: true, scoreB: true, scoreC: true, scoreD: true },
        });
        scores = new Map(metrics.map((m) => [m.studentId, m]));
      }
    }

    return NextResponse.json(
      students.map((s) => ({
        ...s,
        class: s.class.name ?? s.class.code,
        classCode: s.class.code,
        labels: s.studentLabels.map((sl) => ({ id: sl.label.id, name: sl.label.name })),
        studentLabels: undefined,
        ...(scores && {
          scores: scores.get(s.id) ?? null,
        }),
        ...(semesterSummary && {
          semesterSummary: semesterResult?.summaries.get(s.id) ?? null,
        }),
      }))
    );
  } catch (error) {
    console.error("[/api/students] error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "获取学生列表失败" }, { status: 500 });
  }
}

// POST /api/students - create a new student
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, classCode, class: className, studentId, gender, labelNames } = body;
    const code = classCode || className;

    if (!name || !code || !studentId || !gender) {
      return NextResponse.json(
        { error: "姓名、班级编号、学号、性别为必填项" },
        { status: 400 }
      );
    }

    let cls = await prisma.class.findFirst({
      where: { OR: [{ code }, { name: code }] },
    });
    if (!cls) {
      cls = await prisma.class.create({ data: { code } });
    }

    const student = await prisma.student.create({
      data: {
        name,
        classId: cls.id,
        studentId,
        gender,
        studentLabels: {
          create: await resolveLabelNames(labelNames || []),
        },
      },
      include: studentInclude,
    });

    return NextResponse.json(
      {
        ...student,
        class: student.class.name ?? student.class.code,
        labels: student.studentLabels.map((sl) => ({ id: sl.label.id, name: sl.label.name })),
        studentLabels: undefined,
      },
      { status: 201 }
    );
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json({ error: "学号已存在" }, { status: 409 });
    }
    console.error("[/api/students] error:", error);
    return NextResponse.json({ error: "创建学生失败" }, { status: 500 });
  }
}

// v0.13: resolve label names to Prisma create payload
async function resolveLabelNames(names: string[]) {
  const result: { labelId: string }[] = [];
  for (const name of names) {
    let label = await prisma.label.findUnique({ where: { name } });
    if (!label) label = await prisma.label.create({ data: { name } });
    result.push({ labelId: label.id });
  }
  return result;
}
