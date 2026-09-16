import { NextRequest, NextResponse } from "next/server";
import { confirmGroupLesson } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ revision: await confirmGroupLesson(id) });
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "确认共同课失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    if (error instanceof ServiceError && error.status < 500) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("确认共同课失败", error);
    const failure = safeApiError(error, "确认共同课失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
