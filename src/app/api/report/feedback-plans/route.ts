import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { FeedbackPlanCreateSchema } from "@/lib/feedback-plan";
import { createFeedbackPlan, listFeedbackPlans, toFeedbackPlanDetail } from "@/services/feedback-plan-service";

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const plans = await listFeedbackPlans({
      classId: params.get("classId") ?? undefined,
      semesterId: params.get("semesterId") ?? undefined,
      sessionId: params.get("sessionId") ?? undefined,
      studentId: params.get("studentId") ?? undefined,
      date: params.get("date") ?? undefined,
      status: params.get("status") ?? undefined,
      archived: params.has("archived") ? params.get("archived") === "true" : false,
      type: params.get("type") ?? undefined,
    });
    return NextResponse.json({ plans });
  } catch (error) {
    return errorResponse(error, "读取反馈计划失败");
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = FeedbackPlanCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("反馈计划参数无效", 400, "invalid_request", false);
    const plan = await createFeedbackPlan(parsed.data);
    return NextResponse.json({ plan: toFeedbackPlanDetail(plan) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "创建反馈计划失败");
  }
}
