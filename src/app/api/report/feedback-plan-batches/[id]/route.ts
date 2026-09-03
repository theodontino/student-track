import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { FeedbackPlanBatchActionSchema, FeedbackPlanBatchPatchSchema } from "@/lib/feedback-plan-batch";
import { prisma } from "@/lib/prisma";
import { buildFeedbackPlanBatchExportWorkbook } from "@/services/feedback-export-service";
import {
  archiveFeedbackPlanBatch,
  cloneFeedbackPlanBatchDraft,
  continueFeedbackPlanBatch,
  getFeedbackPlanBatch,
  pauseFeedbackPlanBatch,
  renameFeedbackPlanBatch,
  retryFeedbackPlanBatch,
  startFeedbackPlanBatch,
  unarchiveFeedbackPlanBatch,
  updateFeedbackPlanBatchDraft,
} from "@/services/feedback-plan-batch-service";

type Context = { params: Promise<{ id: string }> };

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const batch = await getFeedbackPlanBatch(id);
    if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
    return NextResponse.json({ batch });
  } catch (error) {
    return errorResponse(error, "读取反馈批次失败");
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const parsed = FeedbackPlanBatchPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("反馈批次更新参数无效", 400, "invalid_request", false);
    const input = parsed.data;
    const batch = input.action === "plan_draft"
      ? await updateFeedbackPlanBatchDraft(id, input)
      : await renameFeedbackPlanBatch(id, input);
    return NextResponse.json({ batch });
  } catch (error) {
    return errorResponse(error, "更新反馈批次失败");
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const parsed = FeedbackPlanBatchActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("反馈批次操作无效", 400, "invalid_request", false);
    const input = parsed.data;
    if (input.action === "start") return NextResponse.json(await startFeedbackPlanBatch(id, undefined, input.expectedPlanRevision), { status: 202 });
    if (input.action === "pause") return NextResponse.json(await pauseFeedbackPlanBatch(id), { status: 202 });
    if (input.action === "continue") return NextResponse.json(await continueFeedbackPlanBatch(id), { status: 202 });
    if (input.action === "retry") return NextResponse.json(await retryFeedbackPlanBatch(id), { status: 202 });
    if (input.action === "archive") return NextResponse.json(await archiveFeedbackPlanBatch(id));
    if (input.action === "unarchive") return NextResponse.json({ batch: await unarchiveFeedbackPlanBatch(id) });
    if (input.action === "clone_draft") {
      const batch = await cloneFeedbackPlanBatchDraft({ batchId: id, displayName: input.displayName });
      return NextResponse.json({ batch }, { status: 201 });
    }
    const buffer = await buildFeedbackPlanBatchExportWorkbook(prisma, id, input.mode, { allowRepeat: input.allowRepeat === true });
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="feedback-batch_${id}.xlsx"`,
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, "反馈批次操作失败");
  }
}
