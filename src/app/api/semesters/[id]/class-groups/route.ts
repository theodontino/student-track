import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ClassGroupWriteSchema } from "@/lib/contracts/group-lessons";
import { createClassGroup, listSemesterClassGroups } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";

function failure(error: unknown, fallback: string) {
  if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "班级组参数无效" }, { status: 400 });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ groups: await listSemesterClassGroups(id) });
  } catch (error) {
    return failure(error, "读取班级组失败");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = ClassGroupWriteSchema.parse(await request.json().catch(() => null));
    return NextResponse.json({ group: await createClassGroup(id, input) }, { status: 201 });
  } catch (error) {
    return failure(error, "创建班级组失败");
  }
}
