import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setSessionCommonMaterial } from "@/services/common-material-service";
import { ServiceError } from "@/services/service-error";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { lessonNumber?: unknown; material?: unknown };
    if (body.material !== undefined) {
      const material = LessonFeedbackMaterialSchema.safeParse(body.material);
      if (!material.success) {
        return NextResponse.json({ error: "material 必须是有效的课次课程材料" }, { status: 400 });
      }
      return NextResponse.json(await setSessionCommonMaterial(id, material.data, prisma));
    }
    const lessonNumber = body.lessonNumber === null ? null : Number(body.lessonNumber);
    if (lessonNumber !== null && (!Number.isInteger(lessonNumber) || lessonNumber < 1 || lessonNumber > 1000)) {
      return NextResponse.json({ error: "lessonNumber 必须是 1-1000 的整数或 null" }, { status: 400 });
    }
    return NextResponse.json(await setSessionCommonMaterial(id, lessonNumber, prisma));
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "保存课次公共材料失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    if (error instanceof ServiceError && error.status < 500) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const failure = safeApiError(error, "保存课次公共材料失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
