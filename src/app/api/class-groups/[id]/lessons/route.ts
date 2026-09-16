import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { GroupLessonCreateSchema } from "@/lib/contracts/group-lessons";
import { createGroupLesson } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = GroupLessonCreateSchema.parse(await request.json().catch(() => null));
    return NextResponse.json({ lesson: await createGroupLesson(id, input) }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "创建共同课失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }
    if (error instanceof ServiceError && error.status < 500) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ZodError) return NextResponse.json({ error: "共同课参数无效" }, { status: 400 });
    console.error("创建共同课失败", error);
    const failure = safeApiError(error, "创建共同课失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
