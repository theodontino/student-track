import { NextRequest, NextResponse } from "next/server";
import {
  createFeedbackGroupIntake,
  parseFeedbackGroupRunIds,
  parseFeedbackGroupSessionCodes,
  prepareFeedbackGroupIntakeFromExistingFacts,
} from "@/services/feedback-group-intake-service";
import { filesFromInbox } from "@/services/feedback-intake-service";
import { ServiceError } from "@/services/service-error";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { groupLessonId?: unknown; sessionCodes?: unknown; runIds?: unknown; useExistingFacts?: unknown } | null;
    const groupLessonId = typeof body?.groupLessonId === "string" ? body.groupLessonId.trim() : "";
    if (!groupLessonId) return NextResponse.json({ error: "请选择共同课" }, { status: 400 });
    const sessionCodes = parseFeedbackGroupSessionCodes(body?.sessionCodes);
    const runIds = parseFeedbackGroupRunIds(body?.runIds);
    const useExistingFacts = body?.useExistingFacts === true;
    const result = useExistingFacts
      ? await prepareFeedbackGroupIntakeFromExistingFacts({
          groupLessonId,
          ...(sessionCodes ? { sessionCodes } : {}),
          ...(runIds ? { runIds } : {}),
        })
      : await createFeedbackGroupIntake({
          groupLessonId,
          files: await filesFromInbox(),
          ...(sessionCodes ? { sessionCodes } : {}),
          ...(runIds ? { runIds } : {}),
        });
    return NextResponse.json({ ...result, source: useExistingFacts ? "existing_facts" : "inbox" });
  } catch (error) {
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST /api/feedback/intake/group-scan", error);
    return NextResponse.json({ error: "准备班级组反馈材料失败" }, { status: 500 });
  }
}
