import { NextRequest, NextResponse } from "next/server";
import { createClassSession, deleteClassSession } from "@/services/session-service";
import { ServiceError } from "@/services/service-error";

// POST /api/semesters/[id]/session - create today's class session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: semesterId } = await params;
    const body = await request.json().catch(() => ({}));
    const classCode: string | undefined = body.classCode || body.className || undefined;
    const session = await createClassSession({ semesterId, classCode });
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
