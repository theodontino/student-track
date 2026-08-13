import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { GroupLessonSessionWriteSchema } from "@/lib/contracts/group-lessons";
import { linkGroupLessonSession, unlinkGroupLessonSession } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";

function failure(error: unknown, fallback: string) {
  if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "共同课课次参数无效" }, { status: 400 });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = GroupLessonSessionWriteSchema.parse(await request.json().catch(() => null));
    return NextResponse.json({ link: await linkGroupLessonSession(id, input) });
  } catch (error) {
    return failure(error, "关联共同课课次失败");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
    if (!sessionId) return NextResponse.json({ error: "缺少课次" }, { status: 400 });
    return NextResponse.json(await unlinkGroupLessonSession(id, sessionId));
  } catch (error) {
    return failure(error, "移除共同课课次失败");
  }
}
