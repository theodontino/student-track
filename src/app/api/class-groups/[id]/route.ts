import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ClassGroupWriteSchema } from "@/lib/contracts/group-lessons";
import { deleteClassGroup, updateClassGroup } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";

function failure(error: unknown, fallback: string) {
  if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "班级组参数无效" }, { status: 400 });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = ClassGroupWriteSchema.parse(await request.json().catch(() => null));
    return NextResponse.json({ group: await updateClassGroup(id, input) });
  } catch (error) {
    return failure(error, "更新班级组失败");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await deleteClassGroup(id));
  } catch (error) {
    return failure(error, "删除班级组失败");
  }
}
