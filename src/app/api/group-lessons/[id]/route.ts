import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { GroupLessonUpdateSchema } from "@/lib/contracts/group-lessons";
import { deleteGroupLesson, reapplyGroupLessonSemesterMaterial, updateGroupLesson } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";

function failure(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    const failure = safeApiError(error, fallback);
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
  if (error instanceof ServiceError && error.status < 500) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "共同课参数无效" }, { status: 400 });
  console.error(fallback, error);
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

const GroupLessonActionSchema = z.object({
  action: z.literal("reapply_semester_material"),
  replaceExisting: z.boolean().default(false),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = GroupLessonActionSchema.parse(await request.json().catch(() => null));
    return NextResponse.json({ lesson: await reapplyGroupLessonSemesterMaterial(id, input.replaceExisting) });
  } catch (error) {
    return failure(error, "重新套用同号材料失败");
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = GroupLessonUpdateSchema.parse(await request.json().catch(() => null));
    return NextResponse.json({ lesson: await updateGroupLesson(id, input) });
  } catch (error) {
    return failure(error, "更新共同课失败");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await deleteGroupLesson(id));
  } catch (error) {
    return failure(error, "删除共同课失败");
  }
}
