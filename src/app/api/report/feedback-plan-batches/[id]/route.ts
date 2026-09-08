import { copyHistoricalFeedbackBatch } from "@/services/feedback-plan/student-plan";
import { toFeedbackPlanDetail } from "@/services/feedback-plan/view";
import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { FeedbackPlanBatchActionSchema, FeedbackPlanBatchDraftPatchSchema, FeedbackPlanBatchPatchSchema } from "@/lib/feedback-plan-batch";
import { prisma } from "@/lib/prisma";
import { buildFeedbackPlanBatchExportWorkbook } from "@/services/feedback-export-service";
import { assertFeedbackBatchAvailable } from "@/services/academic-scope-recycle-service";
import {
  archiveFeedbackPlanBatch,
  getFeedbackPlanBatch,
  renameFeedbackPlanBatch,
  unarchiveFeedbackPlanBatch,
} from "@/services/feedback-plan-batch-service";

type Context = { params: Promise<{ id: string }> };

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    await assertFeedbackBatchAvailable(id);
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
    await assertFeedbackBatchAvailable(id);
    const parsed = FeedbackPlanBatchPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("反馈批次更新参数无效", 400, "invalid_request", false);
    const input = parsed.data;
    if (input.action === "plan_draft") throw new ApiError("历史批次只读，请复制为学生计划", 409, "conflict", false);
    const batch = await renameFeedbackPlanBatch(id, input);
    return NextResponse.json({ batch });
  } catch (error) {
    return errorResponse(error, "更新反馈批次失败");
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    await assertFeedbackBatchAvailable(id);
    const parsed = FeedbackPlanBatchActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("反馈批次操作无效", 400, "invalid_request", false);
    const input = parsed.data;
    if (["start", "pause", "continue", "force_stop", "retry", "retry_with_free"].includes(input.action)) throw new ApiError("历史批次只读，请复制为学生计划", 409, "conflict", false);
    if (input.action === "archive") return NextResponse.json(await archiveFeedbackPlanBatch(id));
    if (input.action === "unarchive") return NextResponse.json({ batch: await unarchiveFeedbackPlanBatch(id) });
    if (input.action === "clone_draft" || input.action === "save_as") {
      const patch = input.action === "save_as" ? FeedbackPlanBatchDraftPatchSchema.safeParse(input.patch) : undefined;
      if (patch && !patch.success) throw new ApiError("另存计划参数无效", 400, "invalid_request", false);
      const fields = patch?.data;
      const plan = await copyHistoricalFeedbackBatch({ batchId: id, displayName: input.displayName,
        generationApproach: input.action === "clone_draft" ? input.generationApproach : fields?.generationApproach,
        patch: fields ? { outputRequirement: fields.outputRequirement, generationApproach: fields.generationApproach,
          generationPreferences: fields.generationPreferences, classOverrides: fields.classOverrides,
          studentIds: fields.studentSelections?.flatMap((selection) => selection.studentIds), studentOverrides: fields.studentOverrides } : undefined,
      });
      return NextResponse.json({ plan: toFeedbackPlanDetail(plan) }, { status: 201 });
    }
    if (input.action !== "export") throw new ApiError("反馈批次操作无效", 400, "invalid_request", false);
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
