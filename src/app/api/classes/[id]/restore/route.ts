import { NextResponse } from "next/server";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { restoreScope } from "@/services/academic-scope-recycle-service";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await restoreScope("class", id));
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    console.error("POST /api/classes/[id]/restore", error);
    return NextResponse.json({ error: "恢复班级失败" }, { status: 500 });
  }
}
