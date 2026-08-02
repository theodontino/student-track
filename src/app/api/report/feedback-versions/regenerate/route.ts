import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { FEEDBACK_LENGTHS, FEEDBACK_STYLES } from "@/lib/feedback-sections";
import { regenerateFeedbackVersions } from "@/services/feedback-version-service";

const RequestSchema = z.object({
  profileId: z.string().trim().min(1).max(200),
  items: z.array(z.object({
    studentId: z.string().trim().min(1).max(200),
    sourceGenerationId: z.string().trim().min(1).max(200),
    style: z.enum(FEEDBACK_STYLES).optional(),
    length: z.enum(FEEDBACK_LENGTHS).optional(),
  }).strict()).min(1).max(100),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "反馈版本生成请求无效" }, { status: 400 });
    return NextResponse.json(await regenerateFeedbackVersions(parsed.data));
  } catch (error) {
    const failure = safeApiError(error, "生成反馈版本失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
