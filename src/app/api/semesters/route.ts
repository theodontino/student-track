import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/semesters - list all semesters
export async function GET() {
  try {
    const semesters = await prisma.semester.findMany({
      include: { sessions: { orderBy: { date: "desc" } } },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(
      semesters.map((sem) => ({
        ...sem,
        sessionCount: sem.sessions.length,
        sessions: undefined,
      }))
    );
  } catch (error) {
    console.error("GET /api/semesters error:", error);
    return NextResponse.json({ error: "获取学期列表失败" }, { status: 500 });
  }
}

// POST /api/semesters - create a new semester
export async function POST(request: NextRequest) {
  try {
    const { name, startDate, endDate } = await request.json();
    if (!name || !startDate || !endDate) {
      return NextResponse.json({ error: "学期名称、起止日期为必填项" }, { status: 400 });
    }
    const semester = await prisma.semester.create({
      data: { name, startDate, endDate },
    });
    return NextResponse.json(semester, { status: 201 });
  } catch (error) {
    console.error("POST /api/semesters error:", error);
    return NextResponse.json({ error: "创建学期失败" }, { status: 500 });
  }
}
