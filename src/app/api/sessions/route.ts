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
    if (className) where.class = className;
    if (date) where.date = date;

    const sessions = await prisma.classSession.findMany({
      where,
      orderBy: { code: "desc" },
      include: {
        _count: { select: { attendances: true } },
      },
    });

    return NextResponse.json(
      sessions.map((s) => ({
        ...s,
        attendanceCount: s._count.attendances,
        _count: undefined,
      }))
    );
  } catch (error) {
    console.error("GET /api/sessions error:", error);
    return NextResponse.json({ error: "获取课次列表失败" }, { status: 500 });
  }
}
