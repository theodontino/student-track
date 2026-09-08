import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { listFeedbackPlanBatches } from "@/services/feedback-plan-batch-service";

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const batches = await listFeedbackPlanBatches({
      semesterId: params.get("semesterId") ?? undefined,
      archived: params.has("archived") ? params.get("archived") === "true" : false,
    });
    return NextResponse.json({ batches });
  } catch (error) {
    return errorResponse(error, "读取反馈批次失败");
  }
}

export async function POST() {
  return errorResponse(new ApiError("请使用学生反馈计划入口创建，历史批次只读", 409, "conflict", false), "创建反馈批次失败");
}
