import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processDraftReview } from "@/services/review-service";
import { ServiceError } from "@/services/service-error";
import { assertClassInSemester, requireSemesterId } from "@/services/student-enrollment-service";

// GET /api/review - list all drafts
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "pending";
    const className = searchParams.get("className");
    const classId = searchParams.get("classId");
    const requestedSemesterId = searchParams.get("semesterId");
    const semesterId = (className || classId) && !requestedSemesterId
      ? await requireSemesterId(prisma)
      : requestedSemesterId;

    if (classId && !semesterId) {
      return NextResponse.json({ error: "使用 classId 时必须提供 semesterId" }, { status: 400 });
    }
    if (classId && semesterId) await assertClassInSemester(prisma, classId, semesterId);

    let classFilterId = classId;
    if (className && semesterId && !classId) {
      const matches = await prisma.class.findMany({
        where: { semesterId, OR: [{ name: className }, { code: className }] },
        select: { id: true },
      });
      if (matches.length > 1) {
        return NextResponse.json({ error: "班级名称不唯一，请使用 classId" }, { status: 409 });
      }
      classFilterId = matches[0]?.id;
    }

    const drafts = await prisma.draftRecord.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
    });

    let result = drafts.map((d) => ({
      ...d,
      parsedResult: JSON.parse(d.parsedResult),
      reviewResult: d.reviewResult ? JSON.parse(d.reviewResult) : null,
    }));

    // A draft is scoped by the semester of its linked session. Drafts without
    // a session cannot be safely projected into a selected term.
    if (semesterId || className || classId) {
      const sessions = await prisma.classSession.findMany({
        where: {
          ...(semesterId ? { semesterId } : {}),
          ...(classFilterId ? { classId: classFilterId } : {}),
          ...(className && !classFilterId ? { class: { OR: [{ name: className }, { code: className }] } } : {}),
        },
        select: { code: true },
      });
      const codes = new Set(sessions.map((s) => s.code));
      result = result.filter((d) => d.sessionCode && codes.has(d.sessionCode));
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/review] error:", error);
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "获取草稿列表失败" }, { status: 500 });
  }
}

// POST /api/review - confirm or reject a draft
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    return NextResponse.json(await processDraftReview({ draftId: body.draftId, action: body.action, edits: body.edits, semesterId: body.semesterId }));
  } catch (error) {
    console.error("[/api/review] error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}
