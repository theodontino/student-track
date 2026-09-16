import { NextResponse } from "next/server";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";
import { restoreScope } from "@/services/academic-scope-recycle-service";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await restoreScope("class", id));
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "恢复班级失败", "api.classes");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    console.error("POST /api/classes/[id]/restore", error);
    const failure = safeApiError(error, "恢复班级失败", "api.classes");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
