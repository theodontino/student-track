import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { GroupLessonUpdateSchema } from "@/lib/contracts/group-lessons";
import { deleteGroupLesson, updateGroupLesson } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";

function failure(error: unknown, fallback: string) {
  if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "共同课参数无效" }, { status: 400 });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
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
