import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/students/[id] - get student with metrics, events, communications
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const student = await prisma.student.findUnique({
      where: { id },
      include: {
        metrics: { orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 30 },
        events: { orderBy: { date: "desc" } },
        communications: { orderBy: { date: "desc" } },
      },
    });

    if (!student) {
      return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    }

    return NextResponse.json({
      ...student,
      labels: JSON.parse(student.labels),
    });
  } catch (error) {
    console.error("GET /api/students/[id] error:", error);
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
    const { name, class: className, studentId, gender, labels } = body;

    const student = await prisma.student.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(className !== undefined && { class: className }),
        ...(studentId !== undefined && { studentId }),
        ...(gender !== undefined && { gender }),
        ...(labels !== undefined && { labels: JSON.stringify(labels) }),
      },
    });

    return NextResponse.json({
      ...student,
      labels: JSON.parse(student.labels),
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json({ error: "学号已存在" }, { status: 409 });
    }
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    }
    console.error("PUT /api/students/[id] error:", error);
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
    await prisma.student.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    }
    console.error("DELETE /api/students/[id] error:", error);
    return NextResponse.json({ error: "删除学生失败" }, { status: 500 });
  }
}
