import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildFeedbackPlanExportWorkbook, buildWeComDraftPackage } from "@/services/feedback-export-service";
import { apiErrorBody, apiStreamErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { FeedbackPlanAssessmentEvidenceSchema, FeedbackPlanItemPatchSchema } from "@/lib/feedback-plan";
import {
  approveFeedbackPlanItems,
  createTeacherTask,
  deleteFeedbackPlan,
  generateFeedbackPlanItems,
  getFeedbackPlan,
  patchFeedbackPlanItem,
  retainStaleFeedbackPlanItems,
  toFeedbackPlanDetail,
  toFeedbackPlanItemView,
  updateTeacherTaskStatus,
} from "@/services/feedback-plan-service";

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const plan = await getFeedbackPlan(id);
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    return NextResponse.json({ plan: toFeedbackPlanDetail(plan) });
  } catch (error) {
    return errorResponse(error, "读取反馈计划失败");
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || body.action !== "item" || typeof body.itemId !== "string") {
      throw new ApiError("反馈计划更新参数无效", 400, "invalid_request", false);
    }
    const parsed = FeedbackPlanItemPatchSchema.safeParse(body.patch ?? {});
    if (!parsed.success) throw new ApiError("反馈计划条目参数无效", 400, "invalid_request", false);
    const plan = await getFeedbackPlan(id);
    if (!plan || !plan.items.some((item) => item.id === body.itemId)) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
    const item = await patchFeedbackPlanItem(body.itemId, parsed.data);
    return NextResponse.json({ item: toFeedbackPlanItemView(item, plan.type) });
  } catch (error) {
    return errorResponse(error, "更新反馈计划失败");
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await deleteFeedbackPlan(id));
  } catch (error) {
    return errorResponse(error, "删除反馈计划失败");
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") throw new ApiError("反馈计划操作无效", 400, "invalid_request", false);
    if (body.action === "approve") {
      const plan = await approveFeedbackPlanItems({
        planId: id,
        itemIds: Array.isArray(body.itemIds) ? body.itemIds.filter((value): value is string => typeof value === "string") : undefined,
        expectedHashes: body.expectedHashes && typeof body.expectedHashes === "object" ? body.expectedHashes as Record<string, string> : undefined,
      });
      return NextResponse.json({ plan: toFeedbackPlanDetail(plan) });
    }
    if (body.action === "export") {
      const mode = body.mode === "approved_only" ? "approved_only" : "complete";
      const buffer = await buildFeedbackPlanExportWorkbook(prisma, id, mode, { allowRepeat: body.allowRepeat === true });
      return new Response(buffer, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="feedback-plan_${id}.xlsx"`,
          "Content-Length": String(buffer.byteLength),
          "Cache-Control": "no-store",
        },
      });
    }
    if (body.action === "export_wecom_drafts") {
      const draftPackage = await buildWeComDraftPackage(prisma, id);
      const body = JSON.stringify(draftPackage, null, 2);
      return new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="wecom-drafts_${id}.json"`,
          "Content-Length": String(Buffer.byteLength(body)),
          "Cache-Control": "no-store",
        },
      });
    }
    if (body.action === "generate") {
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((value): value is string => typeof value === "string") : undefined;
      const parsedAssessmentEvidence = body.assessmentEvidence === undefined
        ? { success: true as const, data: undefined }
        : FeedbackPlanAssessmentEvidenceSchema.safeParse(body.assessmentEvidence);
      if (!parsedAssessmentEvidence.success) throw new ApiError("反馈计划测评证据参数无效", 400, "invalid_request", false);
      if (body.stream === true) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const write = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
            void generateFeedbackPlanItems({
              planId: id,
              itemIds,
              assessmentEvidence: parsedAssessmentEvidence.data,
              signal: request.signal,
              onProgress: write,
            }).then(() => controller.close()).catch((error) => {
              write({ type: "error", ...apiStreamErrorBody(safeApiError(error, "反馈计划生成失败")) });
              controller.close();
            });
          },
        });
        return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
      }
      const items = await generateFeedbackPlanItems({ planId: id, itemIds, assessmentEvidence: parsedAssessmentEvidence.data, signal: request.signal });
      const plan = await getFeedbackPlan(id);
      return NextResponse.json({ items: plan ? plan.items.map((item) => toFeedbackPlanItemView(item, plan.type)) : items });
    }
    if (body.action === "retain_stale") {
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((value): value is string => typeof value === "string") : undefined;
      const plan = await retainStaleFeedbackPlanItems({ planId: id, itemIds });
      return NextResponse.json({ plan: toFeedbackPlanDetail(plan) });
    }
    if (body.action === "task" && typeof body.itemId === "string") {
      const task = await createTeacherTask({
        planItemId: body.itemId,
        action: typeof body.taskAction === "string" ? body.taskAction : "",
        dueType: body.dueType === "session" ? "session" : "date",
        dueDate: typeof body.dueDate === "string" ? body.dueDate : undefined,
        dueSessionId: typeof body.dueSessionId === "string" ? body.dueSessionId : undefined,
        estimatedMinutes: typeof body.estimatedMinutes === "number" ? body.estimatedMinutes : undefined,
        promiseExcerpt: typeof body.promiseExcerpt === "string" ? body.promiseExcerpt : undefined,
      });
      return NextResponse.json({ task }, { status: 201 });
    }
    if (body.action === "task_status" && typeof body.taskId === "string") {
      const status = body.status === "completed" || body.status === "cancelled" ? body.status : "pending";
      const task = await updateTeacherTaskStatus(body.taskId, status);
      return NextResponse.json({ task });
    }
    throw new ApiError("不支持的反馈计划操作", 400, "invalid_request", false);
  } catch (error) {
    return errorResponse(error, "反馈计划操作失败");
  }
}
