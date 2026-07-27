import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { TeachingSummaryRequestSchema } from "@/lib/contracts/teaching-summary";
import { generateTeachingSummary, getTeachingSummary } from "@/services/teaching-summary-service";

const QuerySchema = z.object({
  scope: z.enum(["session", "date"]),
  sessionCode: z.string().optional(),
  semesterId: z.string().optional(),
  date: z.string().optional(),
  includeCommunications: z.enum(["0", "1"]).default("1"),
}).superRefine((value, context) => {
  if (value.scope === "session" && !value.sessionCode) context.addIssue({ code: "custom", path: ["sessionCode"], message: "缺少课次" });
  if (value.scope === "date" && (!value.semesterId || !value.date)) context.addIssue({ code: "custom", path: ["date"], message: "缺少学期或日期" });
});

function mapServiceError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (["session_not_found", "semester_not_found"].includes(code)) return new ApiError("课次或学期不存在", 404, "not_found", false);
  if (code === "date_outside_semester") return new ApiError("日期不在所选学期内", 400, "invalid_request", false);
  if (code === "llm_output_truncated") {
    return new ApiError("AI 解读输出未完成；已保留课堂事实，请重新生成", 422, "llm_schema_invalid", true);
  }
  if (code === "llm_output_empty") {
    return new ApiError("AI 未返回可用解读；请检查当前模型后重试", 422, "llm_schema_invalid", true);
  }
  if (code === "llm_reference_invalid" || error instanceof z.ZodError) {
    return new ApiError("AI 解读未通过来源校验", 422, "llm_schema_invalid", true);
  }
  return safeApiError(error, "生成教学总结失败");
}

export async function GET(request: NextRequest) {
  try {
    const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const input = TeachingSummaryRequestSchema.parse({
      scope: query.scope === "session"
        ? { type: "session", sessionCode: query.sessionCode }
        : { type: "date", semesterId: query.semesterId, date: query.date },
      includeCommunications: query.includeCommunications === "1",
    });
    return NextResponse.json(await getTeachingSummary(input));
  } catch (error) {
    const safe = error instanceof z.ZodError
      ? new ApiError("教学总结参数不完整", 400, "invalid_request", false)
      : mapServiceError(error);
    return NextResponse.json(apiErrorBody(safe), { status: safe.status });
  }
}

export async function POST(request: NextRequest) {
  const parsed = TeachingSummaryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const safe = new ApiError("教学总结参数不完整", 400, "invalid_request", false);
    return NextResponse.json(apiErrorBody(safe), { status: safe.status });
  }
  try {
    return NextResponse.json(await generateTeachingSummary(parsed.data));
  } catch (error) {
    const safe = mapServiceError(error);
    console.error(`[/api/report/teaching-summary] POST error (${safe.diagnosticId ?? "no-diagnostic-id"}):`, error);
    return NextResponse.json(apiErrorBody(safe), { status: safe.status });
  }
}
