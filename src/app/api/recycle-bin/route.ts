import { NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { listRecycleBin } from "@/services/academic-scope-recycle-service";

export async function GET() {
  try {
    return NextResponse.json(await listRecycleBin());
  } catch (error) {
    console.error("GET /api/recycle-bin", error);
    const failure = safeApiError(error, "读取回收站失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
