import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";
import { listFeedbackAbTestCandidates, runFeedbackAbTest } from "@/services/feedback-ab-test-service";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

export async function GET() {
  try {
    return NextResponse.json({ plans: await listFeedbackAbTestCandidates() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "读取反馈实验候选失败");
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (typeof body?.planId !== "string" || typeof body.planItemId !== "string") {
      throw new ApiError("请选择反馈计划和学生条目", 400, "invalid_request", false);
    }
    return NextResponse.json(await runFeedbackAbTest({ planId: body.planId, planItemId: body.planItemId }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "运行反馈 A/B 实验失败");
  }
}
