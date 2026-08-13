import { NextRequest, NextResponse } from "next/server";
import { createOrGetFeedbackIntakeRun, filesFromInbox, resolveFeedbackIntakeRun } from "@/services/feedback-intake-service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { sessionCode?: unknown };
    const sessionCode = typeof body.sessionCode === "string" ? body.sessionCode.trim() : "";
    if (!sessionCode) return NextResponse.json({ error: "请选择课次" }, { status: 400 });
    const files = await filesFromInbox();
    const result = await createOrGetFeedbackIntakeRun({ sessionCode, files });
    const run = await resolveFeedbackIntakeRun(result.run.id, { action: "apply" });
    return NextResponse.json({ ...result, run, source: "inbox" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "扫描反馈收件箱失败" }, { status: 400 });
  }
}
