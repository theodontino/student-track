import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processDraftReview } from "@/services/review-service";
import { assignWccDraftSession } from "@/services/wecomcatch-integration-service";

function parsed(value: string) {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

export async function GET() {
  const drafts = await prisma.draftRecord.findMany({
    where: { status: "pending", id: { startsWith: "wcc-" } },
    orderBy: { createdAt: "desc" },
  });
  const output = [];
  for (const draft of drafts) {
    const student = draft.studentId
      ? await prisma.student.findUnique({
        where: { id: draft.studentId },
        select: { id: true, name: true, studentId: true, classId: true },
      })
      : null;
    const result = parsed(draft.parsedResult);
    const source = result.wccSource && typeof result.wccSource === "object"
      ? result.wccSource as Record<string, unknown>
      : {};
    const semesterSuggestion = typeof source.semesterSuggestion === "string"
      ? source.semesterSuggestion
      : undefined;
    const sessions = student
      ? await prisma.classSession.findMany({
        where: {
          classId: student.classId,
          ...(semesterSuggestion ? { semesterId: semesterSuggestion } : {}),
        },
        select: { code: true, date: true, semesterNumber: true },
        orderBy: { date: "desc" },
      })
      : [];
    output.push({
      id: draft.id,
      sessionCode: draft.sessionCode,
      student,
      parsedResult: result,
      source,
      sessions,
      createdAt: draft.createdAt,
    });
  }
  return NextResponse.json(output);
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as { draftId?: string; sessionCode?: string };
    if (!body.draftId || !body.sessionCode) throw new Error("draft_and_session_required");
    const draft = await assignWccDraftSession(prisma, body.draftId, body.sessionCode);
    return NextResponse.json({ id: draft.id, sessionCode: draft.sessionCode });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "update_failed" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { draftId?: string; action?: "confirm" | "reject"; edits?: unknown };
    if (!body.draftId || !body.draftId.startsWith("wcc-")) throw new Error("invalid_draft");
    if (body.action === "confirm") {
      const draft = await prisma.draftRecord.findUnique({ where: { id: body.draftId } });
      if (!draft?.sessionCode) throw new Error("session_required_before_confirmation");
    }
    return NextResponse.json(await processDraftReview({
      draftId: body.draftId,
      action: body.action === "reject" ? "reject" : "confirm",
      edits: body.edits,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "review_failed" }, { status: 400 });
  }
}
