import { NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { purgeExpiredRecycleBin } from "@/services/academic-scope-recycle-service";

export async function POST() {
  try {
    return NextResponse.json(await purgeExpiredRecycleBin());
  } catch (error) {
    console.error("POST /api/recycle-bin/purge-expired", error);
    const failure = safeApiError(error, "回收站到期清理失败，数据已保留，稍后可重试");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
