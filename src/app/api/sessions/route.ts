import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/services/service-error";
import { assertClassInSemester, requireSemesterId } from "@/services/student-enrollment-service";

// GET /api/sessions?semesterId=&className=&date=
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const semesterId = searchParams.get("semesterId");
    const className = searchParams.get("className");
    const classId = searchParams.get("classId");
    const date = searchParams.get("date");

    const effectiveSemesterId = (classId || className) && !semesterId
      ? await requireSemesterId(prisma)
      : semesterId;
    const where: Record<string, unknown> = {};
    where.semester = { deletedAt: null };
    where.OR = [{ classId: null }, { class: { deletedAt: null } }];
    if (effectiveSemesterId) where.semesterId = effectiveSemesterId;
    if (date) where.date = date;
    if (classId) {
      if (!effectiveSemesterId) return NextResponse.json({ error: "使用 classId 时必须提供 semesterId" }, { status: 400 });
      await assertClassInSemester(prisma, classId, effectiveSemesterId);
      where.classId = classId;
    } else if (className) {
      const matches = await prisma.class.findMany({
        where: { ...(effectiveSemesterId ? { semesterId: effectiveSemesterId } : {}), deletedAt: null, semester: { deletedAt: null }, OR: [{ name: className }, { code: className }] },
        select: { id: true },
      });
      if (matches.length > 1) return NextResponse.json({ error: "班级名称不唯一，请使用 classId" }, { status: 409 });
      where.classId = matches[0]?.id ?? null;
    }

    const sessions = await prisma.classSession.findMany({
      where,
      orderBy: { code: "desc" },
      include: {
        _count: { select: { attendances: true } },
        class: { select: { code: true, name: true } },
      },
    });

    return NextResponse.json(
      sessions.map((s) => ({
        ...s,
        class: s.class?.name ?? s.class?.code ?? null,
        attendanceCount: s._count.attendances,
        _count: undefined,
      }))
    );
  } catch (error) {
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[/api/sessions] error:", error);
    return NextResponse.json({ error: "获取课次列表失败" }, { status: 500 });
  }
}
