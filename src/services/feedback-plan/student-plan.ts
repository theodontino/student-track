import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import { FeedbackPlanBatchCreateSchema, type FeedbackPlanBatchCreateInput } from "@/lib/feedback-plan-batch";
import { FeedbackPlanAssessmentEvidenceSchema, type FeedbackPlanDraftPatch, FeedbackPlanInputSnapshotV2Schema, normalizeFeedbackGenerationPreferences } from "@/lib/feedback-plan";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import { prisma } from "@/lib/prisma";
import { prepareFeedbackPlanCreation, updateFeedbackPlanDraft } from "./lifecycle";
import { buildFeedbackPlanFrozenInput, defaultLessonMaterial, resolveSession } from "./evidence";
import { json, parseJson, parseGenerationConfigSnapshot } from "./model";
import { getFeedbackPlan } from "./query";

export type StudentPlanCreateInput = Omit<FeedbackPlanBatchCreateInput, "plans"> & { scopes: FeedbackPlanBatchCreateInput["plans"] };

/** Class scopes organize material intake; only one plan and student items are written. */
export async function createStudentFeedbackPlan(raw: StudentPlanCreateInput, db: PrismaClient = prisma) {
  const parsed = FeedbackPlanBatchCreateSchema.safeParse({ ...raw, plans: raw.scopes });
  if (!parsed.success) throw new ApiError("学生反馈计划参数无效", 400, "invalid_request", false);
  const input = parsed.data;
  const requestFingerprint = createHash("sha256").update(json(input)).digest("hex");
  return db.$transaction(async (tx) => {
    const candidates = await tx.feedbackPlan.findMany({ where: { semesterId: input.semesterId, structureVersion: 2, archivedAt: null }, select: { id: true, inputSnapshot: true } });
    const existing = candidates.find((plan) => parseJson<{ draftRequestKey?: string }>(plan.inputSnapshot, {}).draftRequestKey === input.requestKey);
    if (existing) {
      if (parseJson<{ draftRequestFingerprint?: string }>(existing.inputSnapshot, {}).draftRequestFingerprint !== requestFingerprint) throw new ApiError("本次创建请求已使用，请重新确认计划范围", 409, "conflict", false);
      return (await getFeedbackPlan(existing.id, tx))!;
    }
    const revision = input.sharedLessonRevisionId ? await tx.groupLessonRevision.findUnique({ where: { id: input.sharedLessonRevisionId }, include: { groupLesson: { include: { group: true } } } }) : null;
    if (input.sharedLessonRevisionId && (!revision || revision.groupLesson.group.semesterId !== input.semesterId || revision.groupLessonId !== input.groupLessonId)) {
      throw new ApiError("共同课材料与本轮范围不一致", 409, "conflict", false);
    }
    const sharedMaterial = revision ? LessonFeedbackMaterialSchema.parse(parseJson(revision.materialSnapshot, null)) : null;
    const preferences = normalizeFeedbackGenerationPreferences(input.type, input.generationPreferences);
    const frozen = [];
    for (const scope of input.plans) {
      const session = await resolveSession(tx, scope.rangeEndSessionId ?? scope.sessionId);
      if (!session) throw new ApiError("学生反馈必须绑定真实课次", 400, "invalid_request", false);
      if (input.groupLessonId) {
        const link = await tx.groupLessonSession.findUnique({ where: { sessionId: session.id } });
        if (link?.groupLessonId !== input.groupLessonId) throw new ApiError("课次不属于所选共同课", 409, "conflict", false);
      }
      const run = scope.intakeRunId ? await tx.feedbackIntakeRun.findUnique({ where: { id: scope.intakeRunId } }) : null;
      if (scope.intakeRunId && (!run || run.status !== "applied" || run.sessionCode !== session.code)) throw new ApiError("课堂材料尚未确认或课次不一致", 409, "conflict", false);
      const assessment = FeedbackPlanAssessmentEvidenceSchema.safeParse(parseJson<{ assessmentEvidence?: unknown }>(run?.appliedSummary, {}).assessmentEvidence);
      const prepared = await prepareFeedbackPlanCreation({
        ...scope, type: input.type, semesterId: input.semesterId,
        outputRequirement: scope.outputRequirement ?? input.outputRequirement,
        generationApproach: input.generationApproach,
        generationPreferences: { ...preferences, ...scope.generationPreferences },
        intakeRunIds: run ? [run.id] : undefined,
        assessmentEvidence: assessment.success ? assessment.data : scope.assessmentEvidence,
        lessonMaterial: sharedMaterial ? { ...sharedMaterial, sessionCode: session.code } : scope.lessonMaterial,
      }, tx);
      const result = await buildFeedbackPlanFrozenInput(prepared.input, prepared.rangeStartSessionId, prepared.rangeEndSessionId, tx);
      const snapshot = FeedbackPlanInputSnapshotV2Schema.parse(result.inputSnapshot);
      snapshot.factSnapshot.items = snapshot.factSnapshot.items.map((fact) => ({ ...fact, context: fact.context ? {
        ...fact.context, groupLessonId: input.groupLessonId ?? null,
        ...(scope.outputRequirement && scope.outputRequirement !== input.outputRequirement ? { outputRequirement: scope.outputRequirement } : {}),
        ...(scope.generationPreferences && JSON.stringify(scope.generationPreferences) !== JSON.stringify(preferences) ? { generationPreferences: prepared.input.generationPreferences } : {}),
      } : undefined }));
      frozen.push(snapshot);
    }
    const selectedIds = frozen.flatMap((snapshot) => snapshot.selectedStudentIds);
    if (!selectedIds.length || selectedIds.length > 200 || new Set(selectedIds).size !== selectedIds.length) throw new ApiError("每份计划需要 1–200 名不重复学生", 400, "invalid_request", false);
    const facts = frozen.flatMap((snapshot) => snapshot.factSnapshot.items);
    const snapshot = FeedbackPlanInputSnapshotV2Schema.parse({
      version: 2, semesterId: input.semesterId, draftRequestKey: input.requestKey, draftRequestFingerprint: requestFingerprint,
      lessonMaterial: defaultLessonMaterial(), generationPreferences: preferences,
      selectedStudentIds: selectedIds, studentOverrides: frozen.flatMap((entry) => entry.studentOverrides),
      factSnapshot: { capturedAt: new Date().toISOString(), items: facts },
      intakeSources: frozen.flatMap((entry) => entry.intakeSources),
    });
    const fingerprint = createHash("sha256").update(json(snapshot)).digest("hex");
    const plan = await tx.feedbackPlan.create({ data: {
      structureVersion: 2, semesterId: input.semesterId, classId: null,
      type: input.type, displayName: input.displayName ?? "初版计划", outputRequirement: input.outputRequirement,
      generationApproach: input.generationApproach, inputFingerprint: fingerprint, inputSnapshot: json(snapshot),
      items: { create: selectedIds.map((studentId) => {
        const fact = facts.find((entry) => entry.studentId === studentId)!;
        const override = snapshot.studentOverrides.find((entry) => entry.studentId === studentId);
        return { studentId, classId: fact.context!.class.id, sessionId: fact.context!.session?.id,
          contextSnapshot: json(fact.context), evidenceSnapshot: json(fact.evidence),
          generationConfigSnapshot: override ? json(override.generationConfig) : "{}" };
      }) },
    } });
    return (await getFeedbackPlan(plan.id, tx))!;
  });
}

export function hasStudentScopes(raw: unknown): raw is StudentPlanCreateInput {
  return Boolean(raw && typeof raw === "object" && "scopes" in raw);
}

/** Copy a historical batch directly into one student plan, without copying results. */
export async function copyHistoricalFeedbackBatch(input: { batchId: string; displayName?: string; generationApproach?: "restricted" | "free"; patch?: Omit<FeedbackPlanDraftPatch, "expectedPlanRevision"> }, db: PrismaClient = prisma) {
  const { storedFeedbackPlanDraft } = await import("./query");
  const { feedbackPlanSnapshotV2 } = await import("./evidence");
  return db.$transaction(async (tx) => {
    const batch = await tx.feedbackPlanBatch.findUnique({ where: { id: input.batchId }, include: { plans: { select: { id: true } } } });
    if (!batch) throw new ApiError("历史反馈批次不存在", 404, "not_found", false);
    const snapshots = [];
    for (const child of batch.plans) {
      const source = (await storedFeedbackPlanDraft(child.id, tx))!;
      const snapshot = feedbackPlanSnapshotV2(source);
      const klass = source.classId ? await tx.class.findUnique({ where: { id: source.classId }, select: { id: true, code: true, name: true } }) : null;
      const session = await resolveSession(tx, source.rangeEndSessionId ?? source.sessionId ?? undefined);
      if (!klass) throw new ApiError("历史计划缺少班级归属，无法复制", 409, "conflict", false);
      snapshot.factSnapshot.items = snapshot.factSnapshot.items.map((fact) => ({ ...fact, context: {
        version: 1 as const, class: klass,
        session: session ? { id: session.id, code: session.code, date: session.date, semesterNumber: session.semesterNumber } : null,
        rangeStartSessionId: source.rangeStartSessionId, rangeEndSessionId: source.rangeEndSessionId,
        lessonMaterial: snapshot.lessonMaterial, outputRequirement: source.outputRequirement,
        generationPreferences: snapshot.generationPreferences, ...fact.context,
        sourcePlanId: source.id, sourceItemId: source.items.find((item) => item.studentId === fact.studentId)?.id,
      } }));
      if (source.items.some((item) => !snapshot.factSnapshot.items.some((fact) => fact.studentId === item.studentId))) throw new ApiError("历史计划冻结事实不完整，无法复制", 409, "conflict", false);
      snapshot.studentOverrides = source.items.flatMap((item) => {
        const generationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
        return item.studentId && generationConfig ? [{ studentId: item.studentId, generationConfig }] : [];
      });
      snapshot.selectedStudentIds = source.items.flatMap((item) => item.studentId ? [item.studentId] : []);
      snapshots.push(snapshot);
    }
    const selectedStudentIds = snapshots.flatMap((snapshot) => snapshot.selectedStudentIds);
    if (!selectedStudentIds.length || new Set(selectedStudentIds).size !== selectedStudentIds.length) throw new ApiError("历史批次包含重复学生或没有学生", 409, "conflict", false);
    const snapshot = FeedbackPlanInputSnapshotV2Schema.parse({
      version: 2, semesterId: batch.semesterId, lessonMaterial: defaultLessonMaterial(),
      generationPreferences: snapshots[0]?.generationPreferences,
      selectedStudentIds, studentOverrides: snapshots.flatMap((entry) => entry.studentOverrides),
      factSnapshot: { capturedAt: snapshots[0]?.factSnapshot.capturedAt, items: snapshots.flatMap((entry) => entry.factSnapshot.items) },
      intakeSources: snapshots.flatMap((entry) => entry.intakeSources),
    });
    const plan = await tx.feedbackPlan.create({ data: {
      structureVersion: 2, semesterId: batch.semesterId, type: batch.type,
      displayName: input.displayName ?? `${batch.displayName ?? "历史计划"} 修订版`,
      outputRequirement: batch.outputRequirement, generationApproach: input.generationApproach ?? "restricted",
      inputSnapshot: json(snapshot), inputFingerprint: createHash("sha256").update(json(snapshot)).digest("hex"),
      items: { create: selectedStudentIds.map((studentId) => {
        const fact = snapshot.factSnapshot.items.find((entry) => entry.studentId === studentId)!;
        const override = snapshot.studentOverrides.find((entry) => entry.studentId === studentId);
        return { studentId, classId: fact.context!.class.id, sessionId: fact.context!.session?.id,
          contextSnapshot: json(fact.context), evidenceSnapshot: json(fact.evidence), generationConfigSnapshot: json(override?.generationConfig ?? {}) };
      }) },
    } });
    if (input.patch) return updateFeedbackPlanDraft(plan.id, { ...input.patch, expectedPlanRevision: plan.planRevision }, tx);
    return (await getFeedbackPlan(plan.id, tx))!;
  });
}
