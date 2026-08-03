import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/services/service-error";
import { listSemesterClasses } from "@/services/student-enrollment-service";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const semester = await prisma.semester.findUnique({ where: { id }, select: { id: true } });
    if (!semester) return NextResponse.json({ error: "学期不存在" }, { status: 404 });
    return NextResponse.json(await listSemesterClasses(prisma, id));
  } catch (error) {
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("GET /api/semesters/[id]/classes", error);
    return NextResponse.json({ error: "获取学期班级失败" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: semesterId } = await params;
    const body = await request.json();
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const name = body.name === null || body.name === undefined ? null : String(body.name).trim();
    if (!code) return NextResponse.json({ error: "班级编号为必填项" }, { status: 400 });
    const semester = await prisma.semester.findUnique({ where: { id: semesterId }, select: { id: true } });
    if (!semester) return NextResponse.json({ error: "学期不存在" }, { status: 404 });
    const klass = await prisma.class.create({ data: { semesterId, code, name: name || null } });
    return NextResponse.json({ ...klass, activeStudentCount: 0, inactiveStudentCount: 0, sessionCount: 0 }, { status: 201 });
  } catch (error: any) {
    if (error?.code === "P2002") return NextResponse.json({ error: "该学期内班级编号已存在" }, { status: 409 });
    console.error("POST /api/semesters/[id]/classes", error);
    return NextResponse.json({ error: "创建班级失败" }, { status: 500 });
  }
}
