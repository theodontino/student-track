import { NextRequest, NextResponse } from "next/server";
import { getSessionGroupProgress, setSessionGroupProgress } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";

function failure(error: unknown) {
  if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("session group progress error", error);
  return NextResponse.json({ error: "更新班级组共同进度失败" }, { status: 500 });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ progress: await getSessionGroupProgress(id) });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null) as { groupLessonId?: unknown } | null;
    if (!body || (body.groupLessonId !== null && typeof body.groupLessonId !== "string")) {
      return NextResponse.json({ error: "共同课参数无效" }, { status: 400 });
    }
    return NextResponse.json(await setSessionGroupProgress({ sessionId: id, groupLessonId: body.groupLessonId }));
  } catch (error) {
    return failure(error);
  }
}
