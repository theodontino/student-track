import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/students/[id]/history — 查看评分版本历史
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const history = await prisma.sessionMetricHistory.findMany({
      where: { studentId: id },
      orderBy: { archivedAt: "desc" },
    });
    const linkedSessionIds = [...new Set(history.flatMap((item) => item.sessionId ? [item.sessionId] : []))];
    const availableSessionIds = linkedSessionIds.length
      ? new Set((await prisma.classSession.findMany({
          where: {
            id: { in: linkedSessionIds },
            semester: { deletedAt: null },
            OR: [{ classId: null }, { class: { deletedAt: null } }],
          },
          select: { id: true },
        })).map((session) => session.id))
      : new Set<string>();
    return NextResponse.json(history.filter((item) => !item.sessionId || availableSessionIds.has(item.sessionId)));
  } catch (error) {
    console.error("[/api/students/[id]/history] error:", error);
    return NextResponse.json({ error: "获取历史失败" }, { status: 500 });
  }
}
