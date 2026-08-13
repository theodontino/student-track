import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { FeedbackPlanBatchCreateSchema } from "@/lib/feedback-plan-batch";
import { createFeedbackPlanBatch, listFeedbackPlanBatches } from "@/services/feedback-plan-batch-service";

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

export async function POST(request: NextRequest) {
  try {
    const parsed = FeedbackPlanBatchCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("反馈批次参数无效", 400, "invalid_request", false);
    const batch = await createFeedbackPlanBatch(parsed.data);
    return NextResponse.json({ batch }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "创建反馈批次失败");
  }
}
