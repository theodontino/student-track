import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processDraftReview } from "@/services/review-service";
import { ServiceError } from "@/services/service-error";

// GET /api/review - list all drafts
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "pending";
    const className = searchParams.get("className");

    const drafts = await prisma.draftRecord.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
    });

    let result = drafts.map((d) => ({
      ...d,
      parsedResult: JSON.parse(d.parsedResult),
      reviewResult: d.reviewResult ? JSON.parse(d.reviewResult) : null,
    }));

    // v0.12: 按班级筛选
    if (className) {
      const sessions = await prisma.classSession.findMany({
        where: {
          OR: [
            { class: { name: className } },
            { class: { code: className } },
          ],
        },
        select: { code: true },
      });
      const codes = new Set(sessions.map((s) => s.code));
      result = result.filter((d) => d.sessionCode && codes.has(d.sessionCode));
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/review] error:", error);
    return NextResponse.json({ error: "获取草稿列表失败" }, { status: 500 });
  }
}

// POST /api/review - confirm or reject a draft
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    return NextResponse.json(await processDraftReview({ draftId: body.draftId, action: body.action, edits: body.edits }));
  } catch (error) {
    console.error("[/api/review] error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}
