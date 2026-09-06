import { afterAll, describe, expect, it } from "vitest";
import {
  createFeedbackGenerationExecutionSnapshot,
  feedbackGenerationApproachForDerivedPlan,
  feedbackGenerationApproachLabel,
  normalizeStoredFeedbackGenerationApproach,
  parseFeedbackGenerationExecutionSnapshot,
  serializeFeedbackGenerationExecutionSnapshot,
} from "@/lib/feedback-generation-approach";
import { FeedbackPlanCreateSchema, defaultFeedbackGenerationPreferences } from "@/lib/feedback-plan";
import { FeedbackPlanBatchActionSchema, FeedbackPlanBatchCreateSchema } from "@/lib/feedback-plan-batch";
import { prisma } from "@/lib/prisma";
import {
  cloneFeedbackPlanBatchDraft,
  continueFeedbackPlanBatch,
  createFeedbackPlanBatch,
  getFeedbackPlanBatch,
  retryFeedbackPlanBatch,
  retryFeedbackPlanBatchWithFree,
  saveFeedbackPlanBatchAs,
  startFeedbackPlanBatch,
} from "@/services/feedback-plan-batch-service";
import {
  cloneFeedbackPlanDraft,
  continueFeedbackPlanGeneration,
  createFeedbackPlan,
  generateFeedbackPlanItems,
  getFeedbackPlan,
  listFeedbackPlans,
  retryFeedbackPlanGeneration,
  retryFeedbackPlanGenerationWithFree,
  saveFeedbackPlanAs,
  startFeedbackPlanGeneration,
  toFeedbackPlanDetail,
  updateFeedbackPlanDraft,
} from "@/services/feedback-plan-service";

const marker = "TEST-GENERATION-APPROACH";

afterAll(async () => {
  await prisma.feedbackPlan.deleteMany({ where: { semester: { name: marker } } });
  await prisma.feedbackPlanBatch.deleteMany({ where: { semester: { name: marker } } });
  await prisma.event.deleteMany({ where: { student: { studentId: marker } } });
  await prisma.classSession.deleteMany({ where: { code: marker } });
  await prisma.student.deleteMany({ where: { studentId: marker } });
  await prisma.class.deleteMany({ where: { code: marker } });
  await prisma.semester.deleteMany({ where: { name: marker } });
});

describe("feedback generation approach", () => {
  it("keeps legacy internal while exposing only restricted and free for new plans", () => {
    const parsed = FeedbackPlanCreateSchema.parse({
      type: "event_micro",
      outputRequirement: "合成反馈要求",
      semesterId: "semester-test",
      classId: "class-test",
      generationMode: "fast",
    });
    expect(parsed.generationApproach).toBe("restricted");
    expect(parsed).not.toHaveProperty("generationMode");
    expect(() => FeedbackPlanCreateSchema.parse({
      type: "event_micro",
      outputRequirement: "合成反馈要求",
      semesterId: "semester-test",
      classId: "class-test",
      generationApproach: "legacy",
    })).toThrow();
    expect(() => FeedbackPlanBatchCreateSchema.parse({
      requestKey: "legacy-batch-request",
      semesterId: "semester-test",
      type: "event_micro",
      outputRequirement: "合成反馈要求",
      generationApproach: "legacy",
      plans: [{ classId: "class-test" }],
    })).toThrow();
    expect(normalizeStoredFeedbackGenerationApproach(undefined)).toBe("legacy");
    expect(feedbackGenerationApproachLabel("legacy")).toBe("旧生成方式");
    expect(feedbackGenerationApproachForDerivedPlan("legacy")).toBe("restricted");
    expect(feedbackGenerationApproachForDerivedPlan("restricted", "free")).toBe("free");
  });

  it("keeps historical execution attempts readable while round-tripping new stage and error kind metadata", () => {
    const snapshot = createFeedbackGenerationExecutionSnapshot("restricted");
    snapshot.attempts.push({
      attempt: 1,
      trigger: "initial",
      actualApproach: "restricted",
      status: "failed",
      startedAt: "2099-01-01T08:00:00.000Z",
      completedAt: "2099-01-01T08:00:01.000Z",
      error: { code: "writer_failed", message: "合成失败信息", retryable: true },
    });
    snapshot.nextApproach = "free";
    snapshot.explicitFallback = {
      from: "restricted",
      to: "free",
      confirmedAt: "2099-01-01T08:01:00.000Z",
    };

    expect(parseFeedbackGenerationExecutionSnapshot("{}")).toBeNull();
    const historical = parseFeedbackGenerationExecutionSnapshot(JSON.stringify(snapshot));
    expect(historical).toEqual(snapshot);
    expect(historical?.attempts[0]).not.toHaveProperty("stage");
    expect(historical?.attempts[0]?.error).not.toHaveProperty("kind");

    historical!.attempts.push({
      attempt: 2,
      trigger: "retry",
      actualApproach: "restricted",
      stage: "writer",
      status: "failed",
      startedAt: "2099-01-01T08:02:00.000Z",
      completedAt: "2099-01-01T08:02:01.000Z",
      error: {
        code: "writer_timeout",
        message: "合成超时",
        retryable: true,
        kind: "timeout",
      },
    });
    expect(parseFeedbackGenerationExecutionSnapshot(serializeFeedbackGenerationExecutionSnapshot(historical!)))
      .toEqual(historical);
  });

  it("accepts force stop as a batch generation action", () => {
    expect(FeedbackPlanBatchActionSchema.parse({ action: "force_stop" })).toEqual({ action: "force_stop" });
  });

  it("persists the approach through create, save, save-as and batch child creation", async () => {
    const semester = await prisma.semester.create({
      data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" },
    });
    const classRecord = await prisma.class.create({
      data: { semesterId: semester.id, code: marker, name: "生成方式测试班" },
    });
    const student = await prisma.student.create({
      data: {
        name: "张三",
        studentId: marker,
        gender: "男",
        enrollments: { create: { semesterId: semester.id, classId: classRecord.id } },
      },
    });
    const session = await prisma.classSession.create({
      data: {
        semesterId: semester.id,
        classId: classRecord.id,
        code: marker,
        date: "2099-01-01",
        semesterNumber: 1,
      },
    });
    await prisma.event.create({
      data: {
        studentId: student.id,
        sessionId: session.id,
        type: "课堂表现",
        description: "张三完成了合成课堂任务",
        rawText: "固定合成测试",
      },
    });
    const baseInput = {
      type: "event_micro" as const,
      outputRequirement: "合成反馈要求",
      semesterId: semester.id,
      classId: classRecord.id,
      sessionId: session.id,
      studentIds: [student.id],
    };

    const restricted = await createFeedbackPlan({ ...baseInput, generationApproach: "restricted" });
    const free = await createFeedbackPlan({ ...baseInput, generationApproach: "free" });
    expect(restricted).toMatchObject({ generationApproach: "restricted", generationMode: "standard" });
    expect(free).toMatchObject({ generationApproach: "free", generationMode: "standard" });
    expect(restricted.inputFingerprint).not.toBe(free.inputFingerprint);
    expect(restricted.items[0]?.generationExecutionSnapshot).toBe("{}");

    const saved = await updateFeedbackPlanDraft(restricted.id, {
      generationApproach: "free",
      expectedPlanRevision: restricted.planRevision,
    });
    expect(saved.generationApproach).toBe("free");
    expect(saved.inputFingerprint).not.toBe(restricted.inputFingerprint);
    const unchanged = await updateFeedbackPlanDraft(saved.id, {
      outputRequirement: saved.outputRequirement,
      expectedPlanRevision: saved.planRevision,
    });
    expect(unchanged.inputFingerprint).toBe(saved.inputFingerprint);

    await prisma.feedbackPlan.update({ where: { id: saved.id }, data: { generationApproach: "legacy" } });
    const historical = await prisma.feedbackPlan.findUniqueOrThrow({
      where: { id: saved.id },
      include: { items: true },
    });
    expect(toFeedbackPlanDetail(historical)).toMatchObject({
      generationApproach: null,
      generationApproachLabel: "旧生成方式",
      legacyReadonly: true,
    });
    expect(await listFeedbackPlans({ semesterId: semester.id })).toContainEqual(expect.objectContaining({
      id: saved.id,
      generationApproach: null,
      legacyReadonly: true,
    }));
    const retired = { status: 409, code: "legacy_generation_retired" };
    await expect(startFeedbackPlanGeneration({ planId: saved.id })).rejects.toMatchObject(retired);
    await expect(continueFeedbackPlanGeneration(saved.id)).rejects.toMatchObject(retired);
    await expect(retryFeedbackPlanGeneration({ planId: saved.id })).rejects.toMatchObject(retired);
    await expect(retryFeedbackPlanGenerationWithFree({ planId: saved.id })).rejects.toMatchObject(retired);
    await expect(generateFeedbackPlanItems({ planId: saved.id })).rejects.toMatchObject(retired);

    const historicalGeneration = await prisma.generationRecord.create({
      data: {
        taskType: "feedback",
        stage: "plan-review",
        semesterId: semester.id,
        classId: classRecord.id,
        sessionId: session.id,
        studentId: student.id,
        sourceRefs: "[]",
        sourceFingerprint: `${marker}-legacy-generation`,
        promptVersion: "test-v1",
        modelName: "legacy-test-model",
        modelSettings: "{}",
        feedbackPlanItemId: saved.items[0]!.id,
        finalText: "旧方式已经生成的正文",
      },
    });
    await prisma.feedbackPlanItem.update({
      where: { id: saved.items[0]!.id },
      data: {
        status: "exported",
        finalText: "旧方式已经生成的正文",
        finalTextHash: "legacy-final-text",
        selectedGenerationId: historicalGeneration.id,
        approvedAt: new Date("2099-01-02T08:00:00.000Z"),
        exportedAt: new Date("2099-01-02T09:00:00.000Z"),
        generationExecutionSnapshot: JSON.stringify({ version: 1, attempts: [{ status: "succeeded" }] }),
        compositionSnapshot: JSON.stringify({ version: 1, draftFeedback: "旧方式已经生成的正文" }),
      },
    });
    await expect(cloneFeedbackPlanDraft({ planId: saved.id, displayName: "缺少方式的修订" }))
      .rejects.toThrow("必须选择受限反馈或自由反馈");
    const directlyCloned = await cloneFeedbackPlanDraft({
      planId: saved.id,
      displayName: "直接受限修订",
      generationApproach: "restricted",
    });
    const savedAs = await saveFeedbackPlanAs({
      planId: saved.id,
      displayName: "受限反馈修订",
      patch: {
        generationApproach: "restricted",
        expectedPlanRevision: saved.planRevision,
      },
    });
    expect(savedAs).toMatchObject({
      basedOnPlanId: saved.id,
      generationApproach: "restricted",
      displayName: "受限反馈修订",
    });
    expect(savedAs.items).toEqual([expect.objectContaining({
      status: "evidence_ready",
      finalText: null,
      selectedGenerationId: null,
      approvedAt: null,
      exportedAt: null,
      generationExecutionSnapshot: "{}",
      compositionSnapshot: "{}",
      auditSnapshot: "{}",
    })]);
    await expect(prisma.generationRecord.count({
      where: { feedbackPlanItemId: savedAs.items[0]!.id },
    })).resolves.toBe(0);
    expect(savedAs.inputFingerprint).toBe(directlyCloned.inputFingerprint);
    await expect(prisma.feedbackPlan.findUniqueOrThrow({ where: { id: saved.id } }))
      .resolves.toMatchObject({ generationApproach: "legacy" });

    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-BATCH`,
      semesterId: semester.id,
      type: "event_micro",
      outputRequirement: "批次合成反馈要求",
      generationApproach: "free",
      plans: [{ classId: classRecord.id, sessionId: session.id, studentIds: [student.id] }],
    });
    expect(batch).toMatchObject({
      generationApproach: "free",
      generationApproachLabel: "自由反馈",
    });
    expect(batch.plans[0]).toMatchObject({
      generationApproach: "free",
      generationApproachLabel: "自由反馈",
    });

    const executionSnapshot = JSON.stringify({
      version: 1,
      requestedApproach: "restricted",
      nextApproach: "restricted",
      attempts: [],
      restrictedCheckpoint: {
        strategy: { contextOnly: [{ reason: "不应离开服务端" }], omit: [{ reason: "内部排除理由" }] },
        writerInput: { disclosures: [{ content: "内部披露内容" }] },
      },
    });
    await prisma.feedbackPlanItem.update({
      where: { id: restricted.items[0]!.id },
      data: { generationExecutionSnapshot: executionSnapshot },
    });
    const publicPlan = toFeedbackPlanDetail((await getFeedbackPlan(restricted.id))!);
    expect(publicPlan?.items[0]).not.toHaveProperty("generationExecutionSnapshot");
    expect(publicPlan?.items[0]?.generationExecution).not.toHaveProperty("restrictedCheckpoint");

    await prisma.feedbackPlanItem.update({
      where: { id: batch.plans[0]!.items[0]!.id },
      data: { generationExecutionSnapshot: executionSnapshot },
    });
    const publicBatch = await getFeedbackPlanBatch(batch.id);
    expect(publicBatch?.plans[0]?.items[0]).not.toHaveProperty("generationExecutionSnapshot");
    expect(publicBatch?.plans[0]?.items[0]?.generationExecution).not.toHaveProperty("restrictedCheckpoint");

    await prisma.feedbackPlanBatch.update({ where: { id: batch.id }, data: { generationApproach: "legacy" } });
    await prisma.feedbackPlan.updateMany({ where: { batchId: batch.id }, data: { generationApproach: "legacy" } });
    expect(await getFeedbackPlanBatch(batch.id)).toMatchObject({
      generationApproach: null,
      legacyReadonly: true,
      plans: [expect.objectContaining({ generationApproach: null, legacyReadonly: true })],
    });
    await expect(startFeedbackPlanBatch(batch.id)).rejects.toMatchObject(retired);
    await expect(continueFeedbackPlanBatch(batch.id)).rejects.toMatchObject(retired);
    await expect(retryFeedbackPlanBatch(batch.id)).rejects.toMatchObject(retired);
    await expect(retryFeedbackPlanBatchWithFree(batch.id)).rejects.toMatchObject(retired);
    await expect(cloneFeedbackPlanBatchDraft({ batchId: batch.id, displayName: "缺少方式的批次修订" }))
      .rejects.toThrow("必须选择受限反馈或自由反馈");
    const savedBatch = await saveFeedbackPlanBatchAs({
      batchId: batch.id,
      displayName: "自由反馈批次修订",
      patch: {
        action: "plan_draft",
        expectedPlanRevision: batch.planRevision,
        outputRequirement: batch.outputRequirement,
        generationApproach: "free",
        generationPreferences: defaultFeedbackGenerationPreferences("event_micro"),
        studentSelections: [{ classId: classRecord.id, studentIds: [student.id] }],
        classOverrides: [],
        studentOverrides: [],
      },
    });
    expect(savedBatch.generationApproach).toBe("free");
    expect(savedBatch.plans.every((plan) => plan.generationApproach === "free")).toBe(true);
    await prisma.generationRecord.delete({ where: { id: historicalGeneration.id } });
  });
});
