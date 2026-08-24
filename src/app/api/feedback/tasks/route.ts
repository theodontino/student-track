import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { FeedbackTaskRequestSchema, createFeedbackTask } from "@/services/feedback-task-service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const parsed = FeedbackTaskRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "反馈任务参数无效", details: parsed.error.flatten() }, { status: 400 });
    const result = await createFeedbackTask(parsed.data);
    const status = result.generationStatus === "existing" ? 200 : result.generationStatus === "start_failed" ? 202 : 201;
    return NextResponse.json(result, { status });
  } catch (error) {
    const failure = safeApiError(error, "创建反馈任务失败");
    return NextResponse.json({
      ...apiErrorBody(failure),
      ...(failure.status < 500 && failure.details ? { details: failure.details } : {}),
    }, { status: failure.status });
  }
}
