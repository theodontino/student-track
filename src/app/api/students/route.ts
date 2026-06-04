import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/students - list all students
export async function GET() {
  try {
    const students = await prisma.student.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(
      students.map((s) => ({
        ...s,
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
    const { name, class: className, studentId, gender, labels } = body;

    if (!name || !className || !studentId || !gender) {
      return NextResponse.json(
        { error: "姓名、班级、学号、性别为必填项" },
        { status: 400 }
      );
    }

    const student = await prisma.student.create({
      data: {
        name,
        class: className,
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
