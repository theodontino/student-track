import { NextRequest, NextResponse } from "next/server";
import { createClassSession, deleteClassSession } from "@/services/session-service";
import { ServiceError } from "@/services/service-error";

// POST /api/semesters/[id]/session - create a class session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: semesterId } = await params;
    const body = await request.json().catch(() => ({}));
    const classId: string | undefined = typeof body.classId === "string" ? body.classId : undefined;
    const classCode: string | undefined = body.classCode || body.className || undefined;
    const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : undefined;
    const groupProgressMode = body.groupProgressMode === "independent" ? "independent" as const : "auto" as const;
    const commonMaterialLessonNumber = body.commonMaterialLessonNumber === null
      ? null
      : body.commonMaterialLessonNumber === undefined
        ? undefined
        : Number(body.commonMaterialLessonNumber);
    if (commonMaterialLessonNumber !== undefined && commonMaterialLessonNumber !== null && (!Number.isInteger(commonMaterialLessonNumber) || commonMaterialLessonNumber < 1 || commonMaterialLessonNumber > 1000)) {
      return NextResponse.json({ error: "commonMaterialLessonNumber 必须是 1-1000 的整数或 null" }, { status: 400 });
    }
    const session = await createClassSession({ semesterId, classId, classCode, date, groupProgressMode, commonMaterialLessonNumber });
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    console.error("POST session error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "创建课次失败" }, { status: 500 });
  }
}

// DELETE /api/semesters/[id]/session - delete a session by code
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: semesterId } = await params;
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");

    if (!code) {
      return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });
    }

    return NextResponse.json(await deleteClassSession({ semesterId, code }));
  } catch (error) {
    console.error("DELETE session error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "删除课次失败" }, { status: 500 });
  }
}
