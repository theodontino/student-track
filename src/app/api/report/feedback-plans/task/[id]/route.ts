import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { updateTeacherTaskStatus } from "@/services/feedback-plan-service";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { status?: string } | null;
  if (body?.status !== "pending" && body?.status !== "completed" && body?.status !== "cancelled") {
    const failure = new ApiError("任务状态无效", 400, "invalid_request", false);
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
  try {
    return NextResponse.json({ task: await updateTeacherTaskStatus(id, body.status) });
  } catch (error) {
    const failure = safeApiError(error, "更新教师任务失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
