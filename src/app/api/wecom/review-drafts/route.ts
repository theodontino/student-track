import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processDraftReview } from "@/services/review-service";
import { assignWccDraftSession } from "@/services/wecom-handoff-consumer-service";
import { readPreReviewSuggestion } from "@/services/wecom-prereview-service";

function parsed(value: string) {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const rawLimit = Number(search.get("limit") ?? DEFAULT_PAGE_SIZE);
  const rawOffset = Number(search.get("offset") ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(rawLimit))) : DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const query = (search.get("q") || "").trim();
  const verdictFilter = (search.get("verdict") || "").trim();
  const includeAllStatuses = search.get("status") === "all";
  const missingSessionOnly = search.get("missingSession") === "1";

  const where: Record<string, unknown> = { id: { startsWith: "wcc-" } };
  if (!includeAllStatuses) where.status = "pending";
  if (missingSessionOnly) where.sessionCode = null;

  const drafts = await prisma.draftRecord.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  const studentIds = [...new Set(drafts.map((draft) => draft.studentId).filter((id): id is string => Boolean(id)))];
  const students = studentIds.length
    ? await prisma.student.findMany({
        where: { id: { in: studentIds } },
        include: { enrollments: { include: { class: true, semester: true }, orderBy: { semester: { startDate: "desc" } } } },
      })
    : [];
  const studentsById = new Map(students.map((student) => [student.id, student]));
  const classIds = [...new Set(students.flatMap((student) => student.enrollments.map((enrollment) => enrollment.classId)))];
  const allSessions = classIds.length
    ? await prisma.classSession.findMany({
        where: { classId: { in: classIds } },
        select: { code: true, date: true, semesterNumber: true, classId: true, semesterId: true },
        orderBy: { date: "desc" },
      })
    : [];

  const output = [];
  for (const draft of drafts) {
    const student = draft.studentId ? studentsById.get(draft.studentId) ?? null : null;
    const result = parsed(draft.parsedResult);
    const source = result.wccSource && typeof result.wccSource === "object"
      ? result.wccSource as Record<string, unknown>
      : {};
    const semesterSuggestion = typeof source.semesterSuggestion === "string"
      ? source.semesterSuggestion
      : undefined;
    const eligibleEnrollments = student
      ? student.enrollments.filter((enrollment) => !semesterSuggestion || enrollment.semesterId === semesterSuggestion)
      : [];
    const sessions = student
      ? allSessions
        .filter((session) => eligibleEnrollments.some((enrollment) => enrollment.classId === session.classId && enrollment.semesterId === session.semesterId))
        .map(({ code, date, semesterNumber }) => ({ code, date, semesterNumber }))
      : [];
    const suggestion = readPreReviewSuggestion(draft.reviewResult);
    const row = {
      id: draft.id,
      kind: draft.kind,
      supersedesDraftId: draft.supersedesDraftId,
      communicationId: draft.communicationId,
      sessionCode: draft.sessionCode,
      student: student ? {
        ...student,
        classId: eligibleEnrollments[0]?.classId ?? null,
        class: eligibleEnrollments[0]?.class ?? null,
        enrollments: undefined,
      } : null,
      parsedResult: result,
      source,
      sessions,
      createdAt: draft.createdAt,
      preReview: suggestion,
    };
    if (query) {
      const haystack = [
        student?.name || "",
        student?.studentId || "",
        source?.conversation && typeof source.conversation === "object"
          ? String((source.conversation as Record<string, unknown>).title || "")
          : "",
      ].join(" ").toLowerCase();
      if (!haystack.includes(query.toLowerCase())) continue;
    }
    if (verdictFilter && (!suggestion || suggestion.verdict !== verdictFilter)) continue;
    output.push(row);
  }
  const total = output.length;
  const items = output.slice(offset, offset + limit);
  return NextResponse.json({ items, total, limit, offset });
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
    if (body.action !== "confirm" && body.action !== "reject") {
      throw new Error("invalid_action");
    }
    if (body.action === "confirm") {
      const draft = await prisma.draftRecord.findUnique({ where: { id: body.draftId } });
      if (!draft?.sessionCode) throw new Error("session_required_before_confirmation");
    }
    return NextResponse.json(await processDraftReview({
      draftId: body.draftId,
      action: body.action,
      edits: body.edits,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "review_failed" }, { status: 400 });
  }
}
