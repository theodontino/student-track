import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processDraftReview } from "@/services/review-service";
import { ServiceError } from "@/services/service-error";
import { assertClassInSemester, requireSemesterId } from "@/services/student-enrollment-service";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { hasProductCapability } from "@/lib/product-edition";

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
        where: {
          semesterId,
          deletedAt: null,
          semester: { deletedAt: null },
          OR: [{ name: className }, { code: className }],
        },
        select: { id: true },
      });
      if (matches.length > 1) {
        return NextResponse.json({ error: "班级名称不唯一，请使用 classId" }, { status: 409 });
      }
      classFilterId = matches[0]?.id;
    }

    const drafts = await prisma.draftRecord.findMany({
      where: {
        status,
        ...(!hasProductCapability("wecomIntegration") ? { NOT: { id: { startsWith: "wcc-" } } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    let result = drafts.map((d) => ({
      ...d,
      parsedResult: JSON.parse(d.parsedResult),
      reviewResult: d.reviewResult ? JSON.parse(d.reviewResult) : null,
    }));

    const linkedSessionCodes = [...new Set(drafts.flatMap((draft) => draft.sessionCode ? [draft.sessionCode] : []))];
    const sessions = linkedSessionCodes.length
      ? await prisma.classSession.findMany({
        where: {
          code: { in: linkedSessionCodes },
          semester: { deletedAt: null },
          OR: [{ classId: null }, { class: { deletedAt: null } }],
          ...(semesterId ? { semesterId } : {}),
          ...(classFilterId ? { classId: classFilterId } : {}),
          ...(className && !classFilterId ? { class: { OR: [{ name: className }, { code: className }] } } : {}),
        },
        select: { code: true },
      })
      : [];
    const codes = new Set(sessions.map((session) => session.code));

    // Drafts tied to recycled scopes are hidden everywhere. Unbound drafts
    // remain visible only in the unscoped review queue.
    if (semesterId || className || classId) {
      result = result.filter((d) => d.sessionCode && codes.has(d.sessionCode));
    } else {
      result = result.filter((draft) => !draft.sessionCode || codes.has(draft.sessionCode));
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/review] error:", error);
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
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
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}
