import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import {
  FeedbackGenerationPreferencesSchema,
  FeedbackPlanAssessmentEvidenceSchema,
  defaultFeedbackGenerationPreferences,
  type FeedbackGenerationPreferences,
} from "@/lib/feedback-plan";
import { prisma } from "@/lib/prisma";
import { createFeedbackPlanBatch, startFeedbackPlanBatch } from "@/services/feedback-plan-batch-service";
import { startFeedbackPlanGeneration } from "@/services/feedback-plan-service";
import { resolveFeedbackIntakeRun, type FeedbackIntakeRunView } from "@/services/feedback-intake-service";

const MaterialSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("linked_revision"), revisionId: z.string().trim().min(1).max(200) }),
  z.object({ mode: z.literal("session_snapshot") }),
  z.object({ mode: z.literal("none") }),
]);

export const FeedbackTaskRequestSchema = z.object({
  mode: z.enum(["single", "group"]),
  groupLessonId: z.string().trim().min(1).max(200).optional(),
  runIds: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  requestKey: z.string().trim().min(8).max(200).optional(),
  generationMode: z.enum(["standard", "fast"]).default("standard"),
  type: z.enum(["event_micro", "stage_trend"]).default("event_micro"),
  outputRequirement: z.string().trim().min(1).max(2000).default("为每名入选学生生成一条可复核的家长反馈"),
  materialSelection: MaterialSelectionSchema.optional(),
  preferences: FeedbackGenerationPreferencesSchema.optional(),
});

export type FeedbackTaskRequest = z.infer<typeof FeedbackTaskRequestSchema>;

type ScopeConfirmation = {
  classId: string;
  sessionCode: string;
  studentIds: string[];
  confirmedAt: string;
};

function parsedSnapshot(value: unknown): { scopeConfirmation?: ScopeConfirmation; assessmentEvidence?: Record<string, unknown> } {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === "object"
      ? parsed as { scopeConfirmation?: ScopeConfirmation; assessmentEvidence?: Record<string, unknown> }
      : {};
  } catch {
    return {};
  }
}

function preferencesFor(input: FeedbackTaskRequest): FeedbackGenerationPreferences {
  return FeedbackGenerationPreferencesSchema.parse(input.preferences ?? defaultFeedbackGenerationPreferences(input.type));
}

function assertScope(run: { status: string; sessionCode: string }, scope: ScopeConfirmation | undefined) {
  if (run.status !== "applied") throw new ApiError("请先确认本班材料与事实", 409, "conflict", false);
  if (!scope || scope.sessionCode !== run.sessionCode || !scope.classId || !scope.studentIds.length) {
    throw new ApiError("请先确认班级、课次和反馈对象", 409, "conflict", false);
  }
}

async function findExistingTask(
  mode: FeedbackTaskRequest["mode"],
  runs: Array<{ id: string; planId: string | null }>,
  db: PrismaClient,
) {
  const linkedIds = [...new Set(runs.flatMap((run) => run.planId ? [run.planId] : []))];
  if (!linkedIds.length) return null;
  const plans = await db.feedbackPlan.findMany({
    where: { id: { in: linkedIds }, archivedAt: null },
    select: { id: true, batchId: true },
  });
  if (!plans.length) return null;
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const livePlans = runs.flatMap((run) => run.planId && planById.has(run.planId) ? [planById.get(run.planId)!] : []);

  if (mode === "single" && runs.length === 1 && livePlans.length === 1) {
    const plan = livePlans[0];
    if (!plan.batchId) return { taskType: "plan" as const, planId: plan.id, batchId: null, generationStatus: "existing" as const };
    const batch = await db.feedbackPlanBatch.findFirst({
      where: { id: plan.batchId, archivedAt: null },
      include: { plans: { orderBy: { batchOrder: "asc" }, select: { id: true } } },
    });
    if (batch) return { taskType: "batch" as const, planId: null, batchId: batch.id, firstPlanId: batch.plans[0]?.id ?? plan.id, generationStatus: "existing" as const };
  }

  const batchIds = [...new Set(livePlans.flatMap((plan) => plan.batchId ? [plan.batchId] : []))];
  if (mode === "group" && livePlans.length === runs.length && batchIds.length === 1 && livePlans.every((plan) => plan.batchId === batchIds[0])) {
    const batch = await db.feedbackPlanBatch.findFirst({
      where: { id: batchIds[0], archivedAt: null },
      include: { plans: { orderBy: { batchOrder: "asc" }, select: { id: true } } },
    });
    const requestedPlanIds = livePlans.map((plan) => plan.id).sort();
    const batchPlanIds = batch?.plans.map((plan) => plan.id).sort() ?? [];
    if (batch && requestedPlanIds.length === batchPlanIds.length && requestedPlanIds.every((id, index) => id === batchPlanIds[index])) {
      return { taskType: "batch" as const, planId: null, batchId: batch.id, firstPlanId: batch.plans[0]?.id ?? null, generationStatus: "existing" as const };
    }
  }

  throw new ApiError(
    "本轮材料已经属于其他未归档反馈任务，请先打开或归档现有任务",
    409,
    "conflict",
    false,
    { reason: "active_task_conflict", planIds: livePlans.map((plan) => plan.id), batchIds },
  );
}

async function createSingleTask(input: FeedbackTaskRequest, run: FeedbackIntakeRunView, db: PrismaClient) {
  const snapshot = parsedSnapshot(run.appliedSummary);
  assertScope(run, snapshot.scopeConfirmation);
  const result = await resolveFeedbackIntakeRun(run.id, {
    action: "create_plan",
    plan: {
      type: input.type,
      outputRequirement: input.outputRequirement,
      generationMode: input.generationMode,
      studentIds: snapshot.scopeConfirmation!.studentIds,
      generationPreferences: preferencesFor(input),
      commonMaterial: input.materialSelection ?? { mode: "none" as const },
    } as never,
  }, db);
  const planId = ("plan" in result && result.plan?.id) || ("planId" in result ? result.planId : undefined);
  if (!planId) throw new ApiError("FeedbackPlan 创建后没有返回计划 ID", 500, "internal_error", true);
  try {
    await startFeedbackPlanGeneration({
      planId,
      generationMode: input.generationMode,
      assessmentEvidence: FeedbackPlanAssessmentEvidenceSchema.safeParse(snapshot.assessmentEvidence ?? {}).success
        ? FeedbackPlanAssessmentEvidenceSchema.parse(snapshot.assessmentEvidence ?? {})
        : {},
    }, db);
    return { taskType: "plan" as const, planId, batchId: null, generationStatus: "started" as const };
  } catch (error) {
    return {
      taskType: "plan" as const,
      planId,
      batchId: null,
      generationStatus: "start_failed" as const,
      warning: error instanceof Error ? error.message : "生成尚未启动，请在工作室重试",
    };
  }
}

export async function createFeedbackTask(raw: FeedbackTaskRequest, db: PrismaClient = prisma) {
  const input = FeedbackTaskRequestSchema.parse(raw);
  const uniqueRunIds = [...new Set(input.runIds)];
  if (uniqueRunIds.length !== input.runIds.length) throw new ApiError("反馈任务不能重复使用同一材料运行", 400, "invalid_request", false);
  const runs = await db.feedbackIntakeRun.findMany({ where: { id: { in: uniqueRunIds } } });
  if (runs.length !== uniqueRunIds.length) throw new ApiError("有班级的材料运行不存在", 404, "not_found", false);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const orderedRuns = uniqueRunIds.map((id) => runById.get(id)!);
  const existing = await findExistingTask(input.mode, orderedRuns, db);
  if (existing) return existing;

  if (input.mode === "single") {
    if (orderedRuns.length !== 1) throw new ApiError("单班任务只能包含一个材料运行", 400, "invalid_request", false);
    const run = orderedRuns[0];
    return createSingleTask(input, {
      id: run.id,
      sessionCode: run.sessionCode,
      status: run.status,
      sourceFingerprint: run.sourceFingerprint,
      sourceManifest: JSON.parse(run.sourceManifest),
      appliedSummary: JSON.parse(run.appliedSummary),
      issues: JSON.parse(run.issues),
      planId: run.planId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }, db);
  }

  if (!input.groupLessonId) throw new ApiError("班级组任务缺少共同课", 400, "invalid_request", false);
  const sessionCodes = orderedRuns.map((run) => run.sessionCode);
  const sessions = await db.classSession.findMany({
    where: { code: { in: sessionCodes } },
    select: { id: true, code: true, classId: true, semesterId: true, groupLessonSession: { select: { groupLessonId: true } } },
  });
  const sessionByCode = new Map(sessions.map((session) => [session.code, session]));
  const semesterId = sessions[0]?.semesterId;
  if (!semesterId || sessions.length !== orderedRuns.length || sessions.some((session) => session.semesterId !== semesterId)) {
    throw new ApiError("班级组课次不存在或不属于同一学期", 409, "conflict", false);
  }
  const preferences = preferencesFor(input);
  const plans = orderedRuns.map((run) => {
    const snapshot = parsedSnapshot(run.appliedSummary);
    assertScope(run, snapshot.scopeConfirmation);
    const session = sessionByCode.get(run.sessionCode);
    if (!session?.classId || session.groupLessonSession?.groupLessonId !== input.groupLessonId) {
      throw new ApiError("所有班级必须属于同一共同课", 409, "conflict", false);
    }
    if (snapshot.scopeConfirmation!.classId !== session.classId) throw new ApiError("班级范围确认与真实课次不一致", 409, "conflict", false);
    return {
      classId: session.classId,
      sessionId: session.id,
      intakeRunId: run.id,
      studentIds: snapshot.scopeConfirmation!.studentIds,
      generationPreferences: preferences,
    };
  });
  const materialSelection = input.materialSelection ?? { mode: "none" as const };
  if (materialSelection.mode === "session_snapshot") throw new ApiError("班级组只能使用共同课修订或明确不使用公共材料", 400, "invalid_request", false);
  const batch = await createFeedbackPlanBatch({
    requestKey: input.requestKey ?? randomUUID(),
    semesterId,
    type: input.type,
    outputRequirement: input.outputRequirement,
    generationMode: input.generationMode,
    groupLessonId: input.groupLessonId,
    ...(materialSelection.mode === "linked_revision" ? { sharedLessonRevisionId: materialSelection.revisionId, sharedMaterialConfirmed: true } : {}),
    plans,
  }, db);
  try {
    await startFeedbackPlanBatch(batch.id, db);
    return { taskType: "batch" as const, planId: null, batchId: batch.id, firstPlanId: batch.plans[0]?.id ?? null, generationStatus: "started" as const };
  } catch (error) {
    return {
      taskType: "batch" as const,
      planId: null,
      batchId: batch.id,
      firstPlanId: batch.plans[0]?.id ?? null,
      generationStatus: "start_failed" as const,
      warning: error instanceof Error ? error.message : "批次已创建，请在工作室重试",
    };
  }
}
