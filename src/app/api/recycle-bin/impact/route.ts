import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
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
    console.error("GET /api/recycle-bin/impact", error);
    const failure = safeApiError(error, "读取删除影响失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
