import { NextRequest, NextResponse } from "next/server";
import {
  createFeedbackGroupIntake,
  parseFeedbackGroupRunIds,
} from "@/services/feedback-group-intake-service";
import { filesFromInbox } from "@/services/feedback-intake-service";
import { ServiceError } from "@/services/service-error";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { groupLessonId?: unknown; runIds?: unknown; useExistingFacts?: unknown } | null;
    const groupLessonId = typeof body?.groupLessonId === "string" ? body.groupLessonId.trim() : "";
    if (!groupLessonId) return NextResponse.json({ error: "请选择共同课" }, { status: 400 });
    const runIds = parseFeedbackGroupRunIds(body?.runIds);
    const files = body?.useExistingFacts === true ? [] : await filesFromInbox();
    return NextResponse.json(await createFeedbackGroupIntake({
      groupLessonId,
      files,
      ...(runIds ? { runIds } : {}),
    }));
  } catch (error) {
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST /api/feedback/intake/group-scan", error);
    return NextResponse.json({ error: "扫描班级组反馈收件箱失败" }, { status: 500 });
  }
}
