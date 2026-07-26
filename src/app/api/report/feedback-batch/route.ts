import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { FeedbackBatchPostSchema } from "@/lib/contracts/feedback";
import {
  buildFeedbackBatchExport,
  executeFeedbackBatch,
  parseFeedbackHistoryModule,
} from "@/services/feedback-batch-service";

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

// GET /api/report/feedback-batch?sessionCode=xxx&module=feedback
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionCode = searchParams.get("sessionCode")?.trim();
    if (!sessionCode) {
      throw new ApiError("缺少课次编码", 400, "invalid_request", false);
    }
    const historyModule = parseFeedbackHistoryModule(searchParams.get("module"));
    if (!historyModule) {
      throw new ApiError("无效的历史模块", 400, "invalid_request", false);
    }
    const buffer = await buildFeedbackBatchExport(sessionCode, historyModule);
    return new Response(buffer as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="feedback_${sessionCode}.xlsx"`,
      },
    });
  } catch (error) {
    return errorResponse(error, "反馈导出失败");
  }
}

// POST /api/report/feedback-batch — NDJSON streaming with persistent result history.
export async function POST(request: NextRequest) {
  try {
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = FeedbackBatchPostSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiError("反馈请求格式无效", 400, "invalid_request", false, parsed.error.flatten());
    }
    const result = await executeFeedbackBatch(parsed.data, request.signal);
    if (result.kind === "json") return NextResponse.json(result.body);
    return new Response(result.stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error, "批量生成失败");
  }
}
