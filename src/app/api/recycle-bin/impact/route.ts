import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { getRecycleImpact } from "@/services/academic-scope-recycle-service";

export async function GET(request: NextRequest) {
  try {
    const kind = request.nextUrl.searchParams.get("kind");
    const id = request.nextUrl.searchParams.get("id")?.trim();
    if ((kind !== "class" && kind !== "semester") || !id) {
      return NextResponse.json({ error: "kind 与 id 为必填项" }, { status: 400 });
    }
    return NextResponse.json(await getRecycleImpact(kind, id));
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    console.error("GET /api/recycle-bin/impact", error);
    return NextResponse.json({ error: "读取删除影响失败" }, { status: 500 });
  }
}
