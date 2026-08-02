import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { listTeacherTasks } from "@/services/feedback-plan-service";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  try {
    const tasks = await listTeacherTasks({
      semesterId: url.searchParams.get("semesterId") || undefined,
      classId: url.searchParams.get("classId") || undefined,
      status: url.searchParams.get("status") || undefined,
    });
    return NextResponse.json({ tasks });
  } catch (error) {
    const failure = safeApiError(error, "读取教师任务失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
