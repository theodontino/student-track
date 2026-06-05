import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/sessions?semesterId=&className=&date=
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const semesterId = searchParams.get("semesterId");
    const className = searchParams.get("className");
    const date = searchParams.get("date");

    const where: Record<string, unknown> = {};
    if (semesterId) where.semesterId = semesterId;
    if (date) where.date = date;
    if (className) {
      // Look up class by name or code to get classId
      const cls = await prisma.class.findFirst({
        where: { OR: [{ name: className }, { code: className }] },
      });
      where.classId = cls?.id ?? null;
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
    console.error("GET /api/sessions error:", error);
    return NextResponse.json({ error: "获取课次列表失败" }, { status: 500 });
  }
}
