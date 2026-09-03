import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { assertClassAvailable, moveScopeToRecycleBin } from "@/services/academic-scope-recycle-service";

const STEP_ROSTER_FORMAT = "student-track.step-roster.v1";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await assertClassAvailable(id);
    const klass = await prisma.class.findUnique({
      where: { id },
      select: {
        code: true,
        name: true,
        enrollments: {
          where: { rosterStatus: "ACTIVE" },
          orderBy: [{ createdAt: "asc" }, { student: { studentId: "asc" } }],
          select: { student: { select: { studentId: true, name: true } } },
        },
      },
    });
    if (!klass) return NextResponse.json({ error: "班级不存在" }, { status: 404 });
    const classCode = klass.code.trim();
    const className = klass.name?.trim();
    if (!classCode || !className) return NextResponse.json({ error: "请先补齐班号和班级名称，再导出到 STEP" }, { status: 409 });
    const students = klass.enrollments.map(({ student }) => ({
      studentId: student.studentId.trim(),
      name: student.name.trim(),
    }));
    if (students.some((student) => !student.studentId || !student.name)) {
      return NextResponse.json({ error: "班级花名册存在空的学号或姓名，无法导出" }, { status: 409 });
    }
    if (students.length < 1 || students.length > 60) {
      return NextResponse.json({ error: "STEP 初版支持 1 到 60 名学生，当前班级无法导出" }, { status: 409 });
    }
    const studentIds = new Set(students.map((student) => student.studentId));
    if (studentIds.size !== students.length) {
      return NextResponse.json({ error: "班级花名册存在重复学号，无法导出" }, { status: 409 });
    }
    const body = {
      format: STEP_ROSTER_FORMAT,
      exportedAt: new Date().toISOString(),
      class: { code: classCode, name: className },
      students,
    };
    const filename = `${classCode}.step-roster.json`.replace(/[\\/:*?"<>|]/g, "-");
    return NextResponse.json(body, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    console.error("GET /api/classes/[id] step-roster", error);
    return NextResponse.json({ error: "导出 STEP 花名册失败" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await assertClassAvailable(id);
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
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
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
    const result = await moveScopeToRecycleBin("class", id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    console.error("DELETE /api/classes/[id]", error);
    return NextResponse.json({ error: "删除班级失败" }, { status: 500 });
  }
}
