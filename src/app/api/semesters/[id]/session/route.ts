import { NextRequest, NextResponse } from "next/server";
import { GroupProgressIntentSchema, SessionCreationRequestKeySchema } from "@/lib/contracts/session-creation";
import { createClassSession, deleteClassSession, getClassSessionCreationOptions } from "@/services/session-service";
import { ServiceError } from "@/services/service-error";

function parseDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

// GET /api/semesters/[id]/session - preview explicit progress choices before creation
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: semesterId } = await params;
    const { searchParams } = new URL(request.url);
    const rawDate = searchParams.get("date");
    const date = parseDate(rawDate);
    if (rawDate && !date) {
      return NextResponse.json({ error: "date 必须是 YYYY-MM-DD" }, { status: 400 });
    }
    const classId = searchParams.get("classId") || undefined;
    const classCode = searchParams.get("classCode") || searchParams.get("className") || undefined;
    return NextResponse.json(await getClassSessionCreationOptions({ semesterId, classId, classCode, date }));
  } catch (error) {
    console.error("GET session creation options error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "读取课次创建选项失败" }, { status: 500 });
  }
}

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
    const date = parseDate(body.date);
    if (body.date !== undefined && !date) {
      return NextResponse.json({ error: "date 必须是 YYYY-MM-DD" }, { status: 400 });
    }
    const parsedIntent = body.groupProgressIntent === undefined
      ? null
      : GroupProgressIntentSchema.safeParse(body.groupProgressIntent);
    if (parsedIntent && !parsedIntent.success) {
      return NextResponse.json({ error: "groupProgressIntent 参数无效" }, { status: 400 });
    }
    const parsedRequestKey = SessionCreationRequestKeySchema.safeParse(body.requestKey);
    if (!parsedRequestKey.success) {
      return NextResponse.json({ error: "requestKey 参数无效" }, { status: 400 });
    }
    const commonMaterialLessonNumber = body.commonMaterialLessonNumber === null
      ? null
      : body.commonMaterialLessonNumber === undefined
        ? undefined
        : Number(body.commonMaterialLessonNumber);
    if (commonMaterialLessonNumber !== undefined && commonMaterialLessonNumber !== null && (!Number.isInteger(commonMaterialLessonNumber) || commonMaterialLessonNumber < 1 || commonMaterialLessonNumber > 1000)) {
      return NextResponse.json({ error: "commonMaterialLessonNumber 必须是 1-1000 的整数或 null" }, { status: 400 });
    }
    const session = await createClassSession({
      semesterId,
      classId,
      classCode,
      date,
      requestKey: parsedRequestKey.data,
      groupProgressIntent: parsedIntent?.data,
      commonMaterialLessonNumber,
    });
    return NextResponse.json(session, { status: session.idempotentReplay ? 200 : 201 });
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
