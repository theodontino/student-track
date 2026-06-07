import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/students - list all students
export async function GET() {
  try {
    const students = await prisma.student.findMany({
      orderBy: { createdAt: "desc" },
      include: { class: { select: { id: true, code: true, name: true } } },
    });
    return NextResponse.json(
      students.map((s) => ({
        ...s,
        class: s.class.name ?? s.class.code,
        classCode: s.class.code,
        labels: JSON.parse(s.labels),
      }))
    );
  } catch (error) {
    console.error("GET /api/students error:", error);
    return NextResponse.json({ error: "获取学生列表失败" }, { status: 500 });
  }
}

// POST /api/students - create a new student
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, classCode, class: className, studentId, gender, labels } = body;
    const code = classCode || className;  // accept both classCode (new) and class (legacy)

    if (!name || !code || !studentId || !gender) {
      return NextResponse.json(
        { error: "姓名、班级编号、学号、性别为必填项" },
        { status: 400 }
      );
    }

    // Find or create class by code/name
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
        labels: JSON.stringify(labels || []),
      },
    });

    return NextResponse.json(
      { ...student, labels: JSON.parse(student.labels) },
      { status: 201 }
    );
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json({ error: "学号已存在" }, { status: 409 });
    }
    console.error("POST /api/students error:", error);
    return NextResponse.json({ error: "创建学生失败" }, { status: 500 });
  }
}
