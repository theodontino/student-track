import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import {
  feedbackGenerationApproachForDerivedPlan,
  feedbackGenerationApproachForNewPlan,
  normalizeStoredFeedbackGenerationApproach
} from "@/lib/feedback-generation-approach";
import {
  FeedbackPlanCloneDraftSchema,
  FeedbackPlanCreateSchema,
  FeedbackPlanDraftPatchSchema,
  FeedbackPlanInputSnapshotSchema,
  FeedbackPlanInputSnapshotV2Schema,
  FeedbackPlanRenameSchema,
  normalizeFeedbackGenerationPreferences,
  type FeedbackGenerationPreferences,
  type FeedbackPlanCloneDraftInput,
  type FeedbackPlanCreateInput,
  type FeedbackPlanDraftPatch,
  type FeedbackPlanRenameInput
} from "@/lib/feedback-plan";
import { prisma } from "@/lib/prisma";
import {
  assertClassAvailable,
  assertFeedbackPlanAvailable,
  assertSemesterAvailable,
} from "@/services/academic-scope-recycle-service";
import { withFeedbackPlanDirectoryRemoval } from "@/services/feedback-attachment-storage";
import { assertPlanScope, buildFeedbackPlanFrozenInput, defaultLessonMaterial, feedbackPlanSnapshotV2, findContextForPlan, resolveSession } from "@/services/feedback-plan/evidence";
import { assertLegacyFeedbackGenerationAvailable, FeedbackPlanDb, feedbackPlanDraftFingerprint, feedbackPlanHasGenerationTrace, json, normalizedStudentOverrides, parseGenerationConfigSnapshot, parseJson, StoredFeedbackPlanDraft } from "@/services/feedback-plan/model";
import { getFeedbackPlan, storedFeedbackPlanDraft } from "@/services/feedback-plan/query";

type FeedbackPlanNameScope = {
  semesterId: string;
  classId: string;
  sessionId?: string | null;
  rangeStartSessionId?: string | null;
  rangeEndSessionId?: string | null;
};

async function allocateFeedbackPlanDisplayName(
  db: FeedbackPlanDb,
  scope: FeedbackPlanNameScope,
  requestedName: string,
  excludePlanId?: string,
) {
  const baseName = requestedName.trim();
  const plans = await db.feedbackPlan.findMany({
    where: {
      semesterId: scope.semesterId,
      classId: scope.classId,
      sessionId: scope.sessionId ?? null,
      rangeStartSessionId: scope.rangeStartSessionId ?? null,
      rangeEndSessionId: scope.rangeEndSessionId ?? null,
      ...(excludePlanId ? { id: { not: excludePlanId } } : {}),
      displayName: { not: null },
    },
    select: { displayName: true },
  });
  const names = new Set(plans.flatMap((plan) => plan.displayName ? [plan.displayName] : []));
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName} ${suffix}`)) suffix += 1;
  return `${baseName} ${suffix}`;
}

export async function createFeedbackPlan(
  rawInput: FeedbackPlanCreateInput,
  db: FeedbackPlanDb = prisma,
  options: { withinTransaction?: boolean } = {},
): Promise<NonNullable<Awaited<ReturnType<typeof getFeedbackPlan>>>> {
  const parsedInput = FeedbackPlanCreateSchema.parse(rawInput);
  await assertSemesterAvailable(parsedInput.semesterId, db);
  await assertClassAvailable(parsedInput.classId, db);
  if (parsedInput.requestKey && !options.withinTransaction && "$transaction" in db) {
    return (db as PrismaClient).$transaction((tx) => createFeedbackPlan(parsedInput, tx, { withinTransaction: true }));
  }
  let generationPreferences: FeedbackGenerationPreferences;
  try {
    generationPreferences = normalizeFeedbackGenerationPreferences(parsedInput.type, parsedInput.generationPreferences);
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "生成结构设置无效", 400, "invalid_request", false);
  }
  await assertPlanScope(db, parsedInput);
  const lessonMaterial = parsedInput.lessonMaterial ?? defaultLessonMaterial();
  const input = {
    ...parsedInput,
    generationPreferences,
    generationApproach: feedbackGenerationApproachForNewPlan(parsedInput.generationApproach),
    lessonMaterial,
    sessionId: (await resolveSession(db, parsedInput.sessionId))?.id ?? parsedInput.sessionId,
    rangeStartSessionId: (await resolveSession(db, parsedInput.rangeStartSessionId))?.id ?? parsedInput.rangeStartSessionId,
    rangeEndSessionId: (await resolveSession(db, parsedInput.rangeEndSessionId))?.id ?? parsedInput.rangeEndSessionId,
  } satisfies FeedbackPlanCreateInput;
  if (input.basedOnPlanId) {
    const source = await db.feedbackPlan.findUnique({
      where: { id: input.basedOnPlanId },
      select: { id: true, batchId: true, semesterId: true, classId: true, type: true },
    });
    if (!source) throw new ApiError("来源反馈计划不存在", 404, "not_found", false);
    if (source.batchId) throw new ApiError("班级组计划必须从班级组整体建立当前事实修订", 409, "conflict", false);
    if (source.semesterId !== input.semesterId || source.classId !== input.classId || source.type !== input.type) {
      throw new ApiError("来源反馈计划与当前学期、班级或反馈类型不一致", 409, "conflict", false);
    }
  }
  await findContextForPlan(db, input);
  let rangeStartSessionId = input.rangeStartSessionId;
  const rangeEndSessionId = input.rangeEndSessionId ?? ((input.type === "stage_trend" || input.type === "course_end") ? input.sessionId : undefined);
  const anchorId = rangeEndSessionId ?? input.sessionId;
  const anchorSession = anchorId
    ? await db.classSession.findUnique({ where: { id: anchorId }, select: { id: true, date: true, semesterNumber: true } })
    : null;
  if (input.type === "stage_trend" && !rangeStartSessionId) {
    const previous = await db.feedbackPlan.findFirst({
      where: { classId: input.classId, semesterId: input.semesterId, type: "stage_trend", status: { in: ["approved", "partially_exported", "exported"] } },
      orderBy: { updatedAt: "desc" },
      select: { rangeEndSessionId: true },
    });
    if (previous?.rangeEndSessionId) {
      const previousEnd = await db.classSession.findUnique({ where: { id: previous.rangeEndSessionId }, select: { date: true, semesterNumber: true } });
      const next = await db.classSession.findFirst({
        where: {
          classId: input.classId,
          semesterId: input.semesterId,
          ...(previousEnd ? { OR: [{ date: { gt: previousEnd.date } }, { date: previousEnd.date, semesterNumber: { gt: previousEnd.semesterNumber } }] } : {}),
          ...(anchorSession ? { AND: [{ OR: [{ date: { lt: anchorSession.date } }, { date: anchorSession.date, semesterNumber: { lte: anchorSession.semesterNumber } }] }] } : {}),
        },
        orderBy: [{ date: "asc" }, { semesterNumber: "asc" }],
        select: { id: true },
      });
      if (!next) throw new ApiError("上一份阶段反馈之后没有新的课次，请调整阶段范围", 409, "conflict", false);
      rangeStartSessionId = next.id;
    } else {
      const sessions = await db.classSession.findMany({
        where: {
          classId: input.classId,
          semesterId: input.semesterId,
          ...(anchorSession ? { OR: [{ date: { lt: anchorSession.date } }, { date: anchorSession.date, semesterNumber: { lte: anchorSession.semesterNumber } }] } : {}),
        },
        orderBy: [{ date: "desc" }, { semesterNumber: "desc" }],
        take: 4,
        select: { id: true },
      });
      rangeStartSessionId = sessions.at(-1)?.id;
    }
  }
  if (input.type === "course_end" && !rangeStartSessionId) {
    rangeStartSessionId = (await db.classSession.findFirst({
      where: { classId: input.classId, semesterId: input.semesterId },
      orderBy: [{ date: "asc" }, { semesterNumber: "asc" }],
      select: { id: true },
    }))?.id;
  }

  if (input.requestKey) {
    const candidates = await db.feedbackPlan.findMany({
      where: { semesterId: input.semesterId, archivedAt: null },
      select: {
        id: true,
        classId: true,
        sessionId: true,
        rangeStartSessionId: true,
        rangeEndSessionId: true,
        basedOnPlanId: true,
        inputSnapshot: true,
      },
    });
    const existing = candidates.find((candidate) => {
      const snapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(candidate.inputSnapshot, null));
      return snapshot.success && snapshot.data.version === 2 && snapshot.data.draftRequestKey === input.requestKey;
    });
    if (existing) {
      const sameScope = existing.classId === input.classId
        && existing.sessionId === (input.sessionId ?? null)
        && existing.rangeStartSessionId === (rangeStartSessionId ?? null)
        && existing.rangeEndSessionId === (rangeEndSessionId ?? null)
        && existing.basedOnPlanId === (input.basedOnPlanId ?? null);
      if (!sameScope) throw new ApiError("反馈计划请求标识已用于另一个班级或课次", 409, "conflict", false);
      const detail = await getFeedbackPlan(existing.id, db);
      if (!detail) throw new Error("反馈计划幂等恢复后无法读取");
      return detail;
    }
  }

  const { inputSnapshot, inputFingerprint, selectedIds, studentOverridesById, frozenFactsByStudent } =
    await buildFeedbackPlanFrozenInput(input, rangeStartSessionId, rangeEndSessionId, db);

  const createInDb = async (tx: FeedbackPlanDb) => {
    const displayName = parsedInput.displayName === null
      || (input.basedOnPlanId !== undefined && parsedInput.displayName === undefined)
      ? null
      : await allocateFeedbackPlanDisplayName(tx, {
        semesterId: input.semesterId,
        classId: input.classId,
        sessionId: input.sessionId,
        rangeStartSessionId,
        rangeEndSessionId,
      }, parsedInput.displayName ?? "初版计划");
    const plan = await tx.feedbackPlan.create({
      data: {
        displayName,
        basedOnPlanId: input.basedOnPlanId,
        type: input.type,
        outputRequirement: input.outputRequirement,
        semesterId: input.semesterId,
        classId: input.classId,
        sessionId: input.sessionId,
        rangeStartSessionId,
        rangeEndSessionId,
        inputFingerprint,
        inputSnapshot: json(inputSnapshot),
        generationApproach: input.generationApproach,
        items: {
          create: selectedIds.map((studentId) => {
            const bundle = frozenFactsByStudent.get(studentId);
            if (!bundle) throw new ApiError("反馈计划冻结事实缺少所选学生", 409, "conflict", false);
            return {
              studentId,
              evidenceSnapshot: json(bundle),
              generationConfigSnapshot: studentId && studentOverridesById.has(studentId)
                ? json({ ...studentOverridesById.get(studentId), version: 1 })
                : "{}",
            };
          }),
        },
      },
      include: { items: true },
    });
    return plan;
  };
  // Batch/intake callers explicitly mark their existing transaction. Standalone
  // creation owns this final write transaction itself.
  const created = options.withinTransaction
    ? await createInDb(db)
    : "$transaction" in db
      ? await (db as PrismaClient).$transaction((tx) => createInDb(tx))
    : await createInDb(db);
  const detail = await getFeedbackPlan(created.id, db);
  if (!detail) throw new Error("反馈计划创建后无法读取");
  return detail;
}

function assertMutableFeedbackPlanDraft(
  plan: StoredFeedbackPlanDraft,
  expectedPlanRevision: number,
  allowBatchDraftUpdate: boolean,
) {
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (plan.batchId && !allowBatchDraftUpdate) {
    throw new ApiError("班级组子计划不能单独修改，请从班级组规划统一保存", 409, "conflict", false);
  }
  if (plan.batch && (plan.batch.archivedAt || !["draft", "ready"].includes(plan.batch.status))) {
    throw new ApiError("班级组已经启动生成，计划内容已冻结；请建立修正计划", 409, "conflict", false);
  }
  if (feedbackPlanHasGenerationTrace(plan)) {
    throw new ApiError("已经启动生成的计划内容已冻结，请建立修正计划", 409, "conflict", false);
  }
  if (expectedPlanRevision !== plan.planRevision) {
    throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
  }
}

export async function updateFeedbackPlanDraft(
  id: string,
  rawPatch: FeedbackPlanDraftPatch,
  db: FeedbackPlanDb = prisma,
  options: { allowBatchDraftUpdate?: boolean } = {},
) {
  const patch = FeedbackPlanDraftPatchSchema.parse(rawPatch);
  const execute = async (tx: FeedbackPlanDb) => {
    const plan = await storedFeedbackPlanDraft(id, tx);
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    assertLegacyFeedbackGenerationAvailable(plan.generationApproach);
    assertMutableFeedbackPlanDraft(plan, patch.expectedPlanRevision, options.allowBatchDraftUpdate === true);
    const snapshot = feedbackPlanSnapshotV2(plan);
    const nextType = patch.type ?? plan.type as FeedbackPlanCreateInput["type"];
    const sourceWasClassPlan = snapshot.factSnapshot.items.some((item) => item.studentId === null);
    const targetIsClassPlan = nextType === "class_update";
    if (sourceWasClassPlan !== targetIsClassPlan) {
      throw new ApiError("班级公共反馈与学生反馈不能在同一草稿内互相转换，请新建计划", 409, "conflict", false);
    }
    let generationPreferences: FeedbackGenerationPreferences;
    try {
      generationPreferences = normalizeFeedbackGenerationPreferences(nextType, patch.generationPreferences ?? snapshot.generationPreferences);
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : "生成结构设置无效", 400, "invalid_request", false);
    }
    const factByStudent = new Map(snapshot.factSnapshot.items.map((item) => [item.studentId, item.evidence]));
    const currentStudentIds = plan.items.flatMap((item) => item.studentId ? [item.studentId] : []);
    const selectedIds: Array<string | null> = targetIsClassPlan
      ? [null]
      : [...new Set(patch.studentIds ?? currentStudentIds)];
    const unknownStudent = selectedIds.find((studentId) => !factByStudent.has(studentId));
    if (unknownStudent !== undefined) {
      throw new ApiError("所选学生不在该计划冻结的事实范围内，请按当前事实新建计划", 409, "conflict", false);
    }
    if (!selectedIds.length) throw new ApiError("至少选择一名反馈对象", 400, "invalid_request", false);
    const currentOverrides = plan.items.flatMap((item) => {
      if (!item.studentId) return [];
      const generationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
      return generationConfig ? [{ studentId: item.studentId, generationConfig }] : [];
    });
    const selectedStudentIdSet = new Set(selectedIds.flatMap((studentId) => studentId ? [studentId] : []));
    const studentOverridesById = normalizedStudentOverrides({
      overrides: patch.studentOverrides ?? currentOverrides.filter((override) => selectedStudentIdSet.has(override.studentId)),
      selectedIds,
      contextStudentIds: new Set(snapshot.factSnapshot.items.flatMap((item) => item.studentId ? [item.studentId] : [])),
    });
    const nextDisplayName = patch.displayName
      ? await allocateFeedbackPlanDisplayName(tx, plan, patch.displayName, plan.id)
      : plan.displayName;
    const nextOutputRequirement = patch.outputRequirement ?? plan.outputRequirement;
    const nextGenerationApproach = patch.generationApproach
      ?? normalizeStoredFeedbackGenerationApproach(plan.generationApproach);
    const nextFingerprint = feedbackPlanDraftFingerprint({
      snapshot,
      type: nextType,
      outputRequirement: nextOutputRequirement,
      generationApproach: nextGenerationApproach,
      generationPreferences,
      selectedStudentIds: selectedIds,
      studentOverrides: studentOverridesById,
    });
    const nextSnapshot = FeedbackPlanInputSnapshotV2Schema.parse({
      ...snapshot,
      generationPreferences,
      selectedStudentIds: selectedIds.flatMap((studentId) => studentId ? [studentId] : []),
      studentOverrides: [...studentOverridesById.entries()].map(([studentId, generationConfig]) => ({ studentId, generationConfig })),
    });
    const planData = {
      displayName: nextDisplayName,
      type: nextType,
      outputRequirement: nextOutputRequirement,
      generationApproach: nextGenerationApproach,
      inputFingerprint: nextFingerprint,
      inputSnapshot: json(nextSnapshot),
      status: "draft",
      planRevision: { increment: 1 },
    };
    const saved = await tx.feedbackPlan.updateMany({
      where: {
        id: plan.id,
        planRevision: patch.expectedPlanRevision,
        generationStartedAt: null,
        archivedAt: null,
      },
      data: planData,
    });
    if (!saved.count) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
    const selectedKeys = new Set(selectedIds.map((studentId) => studentId ?? "__class__"));
    const existingByKey = new Map(plan.items.map((item) => [item.studentId ?? "__class__", item]));
    await tx.feedbackPlanItem.deleteMany({
      where: {
        planId: plan.id,
        id: { in: plan.items.filter((item) => !selectedKeys.has(item.studentId ?? "__class__")).map((item) => item.id) },
      },
    });
    for (const studentId of selectedIds) {
      const generationConfigSnapshot = studentId && studentOverridesById.has(studentId)
        ? json(studentOverridesById.get(studentId))
        : "{}";
      const existing = existingByKey.get(studentId ?? "__class__");
      if (existing) {
        if (existing.generationConfigSnapshot !== generationConfigSnapshot) {
          await tx.feedbackPlanItem.update({
            where: { id: existing.id },
            data: { generationConfigSnapshot, itemRevision: { increment: 1 } },
          });
        }
      } else {
        await tx.feedbackPlanItem.create({
          data: {
            planId: plan.id,
            studentId,
            evidenceSnapshot: json(factByStudent.get(studentId)),
            generationConfigSnapshot,
          },
        });
      }
    }
    return plan.id;
  };
  const planId = "$transaction" in db
    ? await (db as PrismaClient).$transaction((tx) => execute(tx))
    : await execute(db);
  const updated = await getFeedbackPlan(planId, db);
  if (!updated) throw new Error("反馈计划草稿保存后无法读取");
  return updated;
}

export async function renameFeedbackPlan(
  id: string,
  rawInput: FeedbackPlanRenameInput,
  db: FeedbackPlanDb = prisma,
) {
  const input = FeedbackPlanRenameSchema.parse(rawInput);
  const plan = await storedFeedbackPlanDraft(id, db);
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组计划只保留批次名称，请从班级组计划重命名", 409, "conflict", false);
  if (input.expectedPlanRevision && input.expectedPlanRevision !== plan.planRevision) {
    throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
  }
  const displayName = await allocateFeedbackPlanDisplayName(db, plan, input.displayName, plan.id);
  if (input.expectedPlanRevision) {
    const renamed = await db.feedbackPlan.updateMany({
      where: { id, planRevision: input.expectedPlanRevision },
      data: { displayName, planRevision: { increment: 1 } },
    });
    if (!renamed.count) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
  } else {
    await db.feedbackPlan.update({ where: { id }, data: { displayName, planRevision: { increment: 1 } } });
  }
  const updated = await getFeedbackPlan(id, db);
  if (!updated) throw new Error("反馈计划重命名后无法读取");
  return updated;
}

export async function cloneFeedbackPlanDraft(
  rawInput: FeedbackPlanCloneDraftInput & { planId: string },
  db: FeedbackPlanDb = prisma,
  options: { allowBatchClone?: boolean } = {},
) {
  const input = { planId: rawInput.planId, ...FeedbackPlanCloneDraftSchema.parse(rawInput) };
  const execute = async (tx: FeedbackPlanDb) => {
    const source = await storedFeedbackPlanDraft(input.planId, tx);
    if (!source) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    if (source.batchId && !options.allowBatchClone) {
      throw new ApiError("班级组子计划不能单独修正，请从班级组计划建立修正计划", 409, "conflict", false);
    }
    const snapshot = feedbackPlanSnapshotV2(source);
    if (source.generationApproach === "legacy" && input.generationApproach === undefined) {
      throw new ApiError("旧生成方式计划另存为时必须选择受限反馈或自由反馈", 409, "conflict", false);
    }
    const generationApproach = feedbackGenerationApproachForDerivedPlan(
      source.generationApproach,
      input.generationApproach,
    );
    const selectedStudentIds = source.items.flatMap((item) => item.studentId ? [item.studentId] : []);
    const studentOverrides = new Map(source.items.flatMap((item) => {
      if (!item.studentId) return [];
      const generationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
      return generationConfig ? [[item.studentId, generationConfig] as const] : [];
    }));
    const inputFingerprint = feedbackPlanDraftFingerprint({
      snapshot,
      type: source.type as FeedbackPlanCreateInput["type"],
      outputRequirement: source.outputRequirement,
      generationApproach,
      generationPreferences: normalizeFeedbackGenerationPreferences(source.type as FeedbackPlanCreateInput["type"], snapshot.generationPreferences),
      selectedStudentIds: source.type === "class_update" ? [null] : selectedStudentIds,
      studentOverrides,
    });
    const displayName = input.displayName
      ? await allocateFeedbackPlanDisplayName(tx, source, input.displayName)
      : null;
    const clone = await tx.feedbackPlan.create({
      data: {
        displayName,
        basedOnPlanId: source.id,
        type: source.type,
        outputRequirement: source.outputRequirement,
        status: "draft",
        semesterId: source.semesterId,
        classId: source.classId,
        sessionId: source.sessionId,
        rangeStartSessionId: source.rangeStartSessionId,
        rangeEndSessionId: source.rangeEndSessionId,
        inputFingerprint,
        inputSnapshot: json({
          ...snapshot,
          draftRequestKey: undefined,
          selectedStudentIds,
          studentOverrides: [...studentOverrides.entries()].map(([studentId, generationConfig]) => ({ studentId, generationConfig })),
        }),
        generationApproach,
        items: {
          create: source.items.map((item) => ({
            studentId: item.studentId,
            evidenceSnapshot: item.evidenceSnapshot,
            generationConfigSnapshot: item.generationConfigSnapshot,
          })),
        },
      },
    });
    return clone.id;
  };
  const cloneId = "$transaction" in db
    ? await (db as PrismaClient).$transaction((tx) => execute(tx))
    : await execute(db);
  const clone = await getFeedbackPlan(cloneId, db);
  if (!clone) throw new Error("修正计划创建后无法读取");
  return clone;
}

/** Creates a named draft from the current page fields without mutating the source plan. */
export async function saveFeedbackPlanAs(
  input: { planId: string; displayName: string; patch: FeedbackPlanDraftPatch },
  db: PrismaClient = prisma,
) {
  await assertFeedbackPlanAvailable(input.planId, db);
  return db.$transaction(async (tx) => {
    const clone = await cloneFeedbackPlanDraft({
      planId: input.planId,
      displayName: input.displayName,
      generationApproach: input.patch.generationApproach,
    }, tx);
    const { expectedPlanRevision: _sourceRevision, ...fields } = input.patch;
    void _sourceRevision;
    return updateFeedbackPlanDraft(clone.id, {
      ...fields,
      displayName: input.displayName,
      expectedPlanRevision: clone.planRevision,
    }, tx);
  });
}

export async function deleteFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({ where: { id }, select: { id: true, batchId: true, status: true, approvedAt: true, exportedAt: true, exportRuns: { select: { id: true }, take: 1 }, attachments: { select: { relativeLocator: true } }, items: { select: { status: true, finalText: true, selectedGenerationId: true, approvedAt: true, exportedAt: true, generations: { select: { id: true }, take: 1 }, attachments: { select: { id: true } } } } } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组子计划不能单独删除，请从班级组计划操作", 409, "conflict", false);
  const hasGenerationOrApproval = plan.approvedAt || plan.exportedAt || plan.exportRuns.length > 0 || plan.items.some((item) => (
    Boolean(item.selectedGenerationId)
    || Boolean(item.approvedAt)
    || Boolean(item.exportedAt)
    || item.generations.length > 0
    || Boolean(item.finalText?.trim())
    || ["generating", "queued", "generation_failed", "needs_review", "approved", "exported"].includes(item.status)
    || item.attachments.length > 0
  ));
  if (hasGenerationOrApproval) {
    throw new ApiError("已有生成、审核、导出或附件的反馈计划只能归档，不能删除", 409, "conflict", false);
  }
  return withFeedbackPlanDirectoryRemoval(id, plan.attachments, async () => {
    await db.$transaction(async (tx) => {
      await tx.feedbackPlan.delete({ where: { id } });
    });
    return { id, deleted: true };
  });
}

export async function archiveFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({ where: { id }, select: { id: true, batchId: true, status: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组子计划不能单独归档，请从班级组计划操作", 409, "conflict", false);
  if (["generating", "queued", "pause_requested"].includes(plan.status)) {
    throw new ApiError("生成中的反馈计划不能直接归档，请先暂停并等待进行中任务完成", 409, "conflict", false);
  }
  return db.feedbackPlan.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function unarchiveFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({ where: { id }, select: { id: true, batchId: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.batchId) throw new ApiError("班级组子计划不能单独取消归档，请从班级组计划操作", 409, "conflict", false);
  return db.feedbackPlan.update({ where: { id }, data: { archivedAt: null } });
}
