import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { selectFeedbackVersion } from "@/services/feedback-version-service";

const RequestSchema = z.object({
  sessionCode: z.string().trim().min(1).max(128),
  studentId: z.string().trim().min(1).max(200),
  generationId: z.string().trim().min(1).max(200),
}).strict();

export async function PUT(request: NextRequest) {
  try {
    const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "反馈版本选择请求无效" }, { status: 400 });
    return NextResponse.json(await selectFeedbackVersion(parsed.data));
  } catch (error) {
    const failure = safeApiError(error, "选择反馈版本失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
