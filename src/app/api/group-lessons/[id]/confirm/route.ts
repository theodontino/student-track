import { NextRequest, NextResponse } from "next/server";
import { confirmGroupLesson } from "@/services/group-lesson-service";
import { ServiceError } from "@/services/service-error";
import { ApiError, apiErrorBody } from "@/lib/api-errors";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ revision: await confirmGroupLesson(id) });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("确认共同课失败", error);
    return NextResponse.json({ error: "确认共同课失败" }, { status: 500 });
  }
}
