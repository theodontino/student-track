import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { listFeedbackVersions } from "@/services/feedback-version-service";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const sessionCode = url.searchParams.get("sessionCode")?.trim() ?? "";
    const studentId = url.searchParams.get("studentId")?.trim() || undefined;
    if (!sessionCode) return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });
    return NextResponse.json(await listFeedbackVersions({ sessionCode, studentId }));
  } catch (error) {
    const failure = safeApiError(error, "读取反馈版本失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
