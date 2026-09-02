import { NextRequest, NextResponse } from "next/server";
import {
  createOrGetFeedbackIntakeRun,
  filesFromInbox,
  prepareFeedbackIntakeFromExistingFacts,
} from "@/services/feedback-intake-service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { sessionCode?: unknown; runId?: unknown; useExistingFacts?: unknown };
    const sessionCode = typeof body.sessionCode === "string" ? body.sessionCode.trim() : "";
    if (!sessionCode) return NextResponse.json({ error: "请选择课次" }, { status: 400 });
    const useExistingFacts = body.useExistingFacts === true;
    const runId = typeof body.runId === "string" ? body.runId.trim() : undefined;
    const result = useExistingFacts
      ? await prepareFeedbackIntakeFromExistingFacts({ sessionCode, runId })
      : await createOrGetFeedbackIntakeRun({ sessionCode, files: await filesFromInbox(), runId });
    return NextResponse.json({ ...result, source: useExistingFacts ? "existing_facts" : "inbox" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "准备反馈材料失败" }, { status: 400 });
  }
}
