import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const data: { code?: string; name?: string | null } = {};
    if (body.code !== undefined) {
      if (typeof body.code !== "string" || !body.code.trim()) {
        return NextResponse.json({ error: "班级编号不能为空" }, { status: 400 });
      }
      data.code = body.code.trim();
    }
    if (body.name !== undefined) data.name = body.name === null ? null : String(body.name).trim() || null;
    const klass = await prisma.class.update({ where: { id }, data });
    return NextResponse.json(klass);
  } catch (error: any) {
    if (error?.code === "P2025") return NextResponse.json({ error: "班级不存在" }, { status: 404 });
    if (error?.code === "P2002") return NextResponse.json({ error: "该学期内班级编号已存在" }, { status: 409 });
    console.error("PUT /api/classes/[id]", error);
    return NextResponse.json({ error: "更新班级失败" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const [klass, sessions, enrollments, plans, tasks, compactions, memories, generations] = await Promise.all([
      prisma.class.findUnique({ where: { id }, select: { id: true } }),
      prisma.classSession.count({ where: { classId: id } }),
      prisma.studentClassEnrollment.count({ where: { classId: id } }),
      prisma.feedbackPlan.count({ where: { classId: id } }),
      prisma.teacherTask.count({ where: { classId: id } }),
      prisma.memoryCompactionRun.count({ where: { classId: id } }),
      prisma.teachingMemory.count({ where: { scopeType: "class", scopeId: id } }),
      prisma.generationRecord.count({ where: { classId: id } }),
    ]);
    if (!klass) return NextResponse.json({ error: "班级不存在" }, { status: 404 });
    if (sessions || enrollments || plans || tasks || compactions || memories || generations) {
      return NextResponse.json({ error: "班级已有业务记录，不能直接删除" }, { status: 409 });
    }
    await prisma.class.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/classes/[id]", error);
    return NextResponse.json({ error: "删除班级失败" }, { status: 500 });
  }
}
