import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildFeedbackPlanExportWorkbook, buildWeComDraftPackage } from "@/services/feedback-export-service";
import { assertFeedbackPlanAvailable } from "@/services/academic-scope-recycle-service";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { assertProductCapability } from "@/lib/product-capability-guard";
import {
  FeedbackPlanAssessmentEvidenceSchema,
  FeedbackPlanCloneDraftSchema,
  FeedbackPlanDraftPatchSchema,
  FeedbackPlanItemPatchSchema,
  FeedbackPlanRenameSchema,
} from "@/lib/feedback-plan";
import { FeedbackGenerationApproachSchema } from "@/lib/feedback-generation-approach";
import {
  approveFeedbackPlanItems,
  archiveFeedbackPlan,
  continueFeedbackPlanGeneration,
  cloneFeedbackPlanDraft,
  createTeacherTask,
  deleteFeedbackPlan,
  getFeedbackPlan,
  patchFeedbackPlanItem,
  pauseFeedbackPlanGeneration,
  retainStaleFeedbackPlanItems,
  renameFeedbackPlan,
  saveFeedbackPlanAs,
  retryFeedbackPlanGeneration,
  retryFeedbackPlanGenerationWithFree,
  startFeedbackPlanGeneration,
  toFeedbackPlanDetail,
  toFeedbackPlanItemView,
  unarchiveFeedbackPlan,
  updateFeedbackPlanDraft,
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
    await assertFeedbackPlanAvailable(id);
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
    await assertFeedbackPlanAvailable(id);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") throw new ApiError("反馈计划更新参数无效", 400, "invalid_request", false);
    if (body.action === "plan_draft") {
      const parsed = FeedbackPlanDraftPatchSchema.safeParse(body.patch ?? {});
      if (!parsed.success) throw new ApiError("反馈计划草稿参数无效", 400, "invalid_request", false);
      const plan = await updateFeedbackPlanDraft(id, parsed.data);
      return NextResponse.json({ plan: toFeedbackPlanDetail(plan) });
    }
    if (body.action === "rename") {
      const parsed = FeedbackPlanRenameSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("反馈计划名称参数无效", 400, "invalid_request", false);
      const plan = await renameFeedbackPlan(id, parsed.data);
      return NextResponse.json({ plan: toFeedbackPlanDetail(plan) });
    }
    if (body.action !== "item" || typeof body.itemId !== "string") throw new ApiError("反馈计划更新参数无效", 400, "invalid_request", false);
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
    await assertFeedbackPlanAvailable(id);
    return NextResponse.json(await deleteFeedbackPlan(id));
  } catch (error) {
    return errorResponse(error, "删除反馈计划失败");
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (body?.action === "export_wecom_drafts") assertProductCapability("wecomDraftExport");
    await assertFeedbackPlanAvailable(id);
    if (!body || typeof body.action !== "string") throw new ApiError("反馈计划操作无效", 400, "invalid_request", false);
    if (body.action === "clone_draft") {
      const parsed = FeedbackPlanCloneDraftSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("修正计划参数无效", 400, "invalid_request", false);
      const plan = await cloneFeedbackPlanDraft({ planId: id, ...parsed.data });
      return NextResponse.json({ plan: toFeedbackPlanDetail(plan) }, { status: 201 });
    }
    if (body.action === "save_as") {
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      const parsed = FeedbackPlanDraftPatchSchema.safeParse({
        ...(body.patch && typeof body.patch === "object" ? body.patch : {}),
        displayName,
        expectedPlanRevision: typeof body.expectedPlanRevision === "number" ? body.expectedPlanRevision : 1,
      });
      if (!displayName || !parsed.success) throw new ApiError("另存计划参数无效", 400, "invalid_request", false);
      const plan = await saveFeedbackPlanAs({ planId: id, displayName, patch: parsed.data });
      return NextResponse.json({ plan: toFeedbackPlanDetail(plan) }, { status: 201 });
    }
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
    if (body.action === "start_generation") {
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((value): value is string => typeof value === "string") : undefined;
      const assessmentEvidence = FeedbackPlanAssessmentEvidenceSchema.safeParse(body.assessmentEvidence ?? {});
      if (!assessmentEvidence.success) throw new ApiError("测评证据参数无效", 400, "invalid_request", false);
      const generationApproach = body.generationApproach === undefined
        ? undefined
        : FeedbackGenerationApproachSchema.safeParse(body.generationApproach);
      if (generationApproach && !generationApproach.success) throw new ApiError("反馈生成方式参数无效", 400, "invalid_request", false);
      const expectedPlanRevision = typeof body.expectedPlanRevision === "number" && Number.isInteger(body.expectedPlanRevision) && body.expectedPlanRevision > 0
        ? body.expectedPlanRevision
        : undefined;
      const result = await startFeedbackPlanGeneration({
        planId: id,
        itemIds,
        assessmentEvidence: assessmentEvidence.data,
        generationApproach: generationApproach?.data,
        expectedPlanRevision,
      });
      return NextResponse.json(result, { status: 202 });
    }
    if (body.action === "pause_generation") {
      return NextResponse.json(await pauseFeedbackPlanGeneration(id), { status: 202 });
    }
    if (body.action === "continue_generation") {
      return NextResponse.json(await continueFeedbackPlanGeneration(id), { status: 202 });
    }
    if (body.action === "retry_generation") {
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((value): value is string => typeof value === "string") : undefined;
      return NextResponse.json(await retryFeedbackPlanGeneration({ planId: id, itemIds }), { status: 202 });
    }
    if (body.action === "retry_with_free") {
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((value): value is string => typeof value === "string") : undefined;
      return NextResponse.json(await retryFeedbackPlanGenerationWithFree({ planId: id, itemIds }), { status: 202 });
    }
    if (body.action === "archive") {
      await archiveFeedbackPlan(id);
      const plan = await getFeedbackPlan(id);
      return NextResponse.json({ plan: plan ? toFeedbackPlanDetail(plan) : null });
    }
    if (body.action === "unarchive") {
      await unarchiveFeedbackPlan(id);
      const plan = await getFeedbackPlan(id);
      return NextResponse.json({ plan: plan ? toFeedbackPlanDetail(plan) : null });
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
