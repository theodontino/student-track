import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setGroupLessonCommonMaterial } from "@/services/common-material-service";
import { ServiceError } from "@/services/service-error";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { lessonNumber?: unknown };
    const lessonNumber = body.lessonNumber === null ? null : Number(body.lessonNumber);
    if (lessonNumber !== null && (!Number.isInteger(lessonNumber) || lessonNumber < 1 || lessonNumber > 1000)) {
      return NextResponse.json({ error: "lessonNumber 必须是 1-1000 的整数或 null" }, { status: 400 });
    }
    return NextResponse.json(await setGroupLessonCommonMaterial(id, lessonNumber, prisma));
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "保存共同课公共材料失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    if (error instanceof ServiceError && error.status < 500) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const failure = safeApiError(error, "保存共同课公共材料失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
