import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
const generationMocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/services/feedback-generation-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/feedback-generation-service")>(),
  generateFeedbackPlanComposition: generationMocks.generate,
}));
vi.mock("@/services/restricted-feedback-generation-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/restricted-feedback-generation-service")>(),
  generateRestrictedFeedback: async (input: { studentName: string; planType: string }) => {
    const generated = await generationMocks.generate(input);
    return {
      strategy: { version: 1, mainFocus: "测试反馈", closureType: generated.composition.closureType, points: [], contextOnly: [], omit: [], communicationIntent: "测试", needParentAction: false, parentAction: null, unresolved: [] },
      writerInput: { version: 1, studentName: input.studentName, recipient: "parent", plan: { type: input.planType, style: "gentle", length: "standard", closureType: generated.composition.closureType, communicationIntent: "测试" }, disclosures: [], parentAction: null, stableRules: ["测试边界"] },
      writerOutput: { version: 1, modules: [], coverage: [], parentAction: null, draftFeedback: generated.composition.draftFeedback },
      composition: generated.composition,
      planner: { model: "test-feedback-model", attempts: 1, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 }, reusedCheckpoint: false },
      writer: { model: "test-feedback-model", attempts: 1, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 } },
    };
  },
}));
import { buildFeedbackPlanBatchExportWorkbook } from "@/services/feedback-export-service";
import {
  cloneFeedbackPlanBatchDraft,
  archiveFeedbackPlanBatch,
  continueFeedbackPlanBatch,
  createFeedbackPlanBatch,
  getFeedbackPlanBatch,
  pauseFeedbackPlanBatch,
  renameFeedbackPlanBatch,
  retryFeedbackPlanBatch,
  retryFeedbackPlanBatchWithFree,
  saveFeedbackPlanBatchAs,
  startFeedbackPlanBatch,
  unarchiveFeedbackPlanBatch,
  updateFeedbackPlanBatchDraft,
} from "@/services/feedback-plan-batch-service";
import {
  continueFeedbackPlanGeneration,
  createFeedbackPlan,
  pauseFeedbackPlanGeneration,
  retryFeedbackPlanGeneration,
} from "@/services/feedback-plan-service";
import { confirmGroupLesson, createClassGroup, createGroupLesson, setSessionGroupProgress } from "@/services/group-lesson-service";

const marker = "VITEST-FEEDBACK-BATCH";
let semesterId = "";
let classIds: string[] = [];
let sessionIds: string[] = [];
let studentIds: string[] = [];
let scopeStudentIds: string[] = [];
let revisionId = "";
let lessonId = "";

beforeAll(async () => {
  const semester = await prisma.semester.create({ data: { name: marker, startDate: "2098-01-01", endDate: "2098-06-30" } });
  semesterId = semester.id;
  const classes = await Promise.all([1, 2].map((number) => prisma.class.create({ data: { semesterId, code: `${marker}-${number}`, name: `合成${number}班` } })));
  classIds = classes.map((item) => item.id);
  const sessions = await Promise.all(classes.map((item, index) => prisma.classSession.create({ data: { semesterId, classId: item.id, code: `2098010${index + 1}01`, date: `2098-01-0${index + 1}`, semesterNumber: index + 1 } })));
  sessionIds = sessions.map((item) => item.id);
  const students = await Promise.all(classes.map((item, index) => prisma.student.create({
    data: { name: `合成学生${index + 1}`, studentId: `${marker}-S${index + 1}`, gender: index ? "女" : "男", enrollments: { create: { semesterId, classId: item.id } } },
  })));
  studentIds = students.map((item) => item.id);
  await Promise.all(students.map((student, index) => prisma.event.create({ data: { studentId: student.id, sessionId: sessions[index]!.id, type: "课堂表现", description: `合成学生${index + 1}完成了课堂订正`, rawText: "固定合成测试" } })));
  const scopeStudents = await Promise.all(classes.map((item, index) => prisma.student.create({
    data: { name: `范围学生${index + 1}`, studentId: `${marker}-SCOPE-${index + 1}`, gender: index ? "女" : "男", enrollments: { create: { semesterId, classId: item.id } } },
  })));
  scopeStudentIds = scopeStudents.map((item) => item.id);
  await Promise.all(scopeStudents.map((student, index) => prisma.event.create({ data: { studentId: student.id, sessionId: sessions[index]!.id, type: "课堂表现", description: `范围学生${index + 1}完成了课堂订正`, rawText: "固定范围测试" } })));
  const group = await createClassGroup(semesterId, { name: `${marker}-GROUP`, classIds, leadClassId: classIds[0] });
  const lesson = await createGroupLesson(group.id, { title: "合成共同课", sequence: 1, material: parseLessonFeedbackMaterial("课程标题：合成共同课\n课堂内容：守恒关系", "出门测：守恒关系") });
  lessonId = lesson.id;
  await Promise.all(sessionIds.map((sessionId) => setSessionGroupProgress({ sessionId, groupLessonId: lesson.id })));
  revisionId = (await confirmGroupLesson(lesson.id)).id;
});

afterAll(async () => {
  await prisma.feedbackPlan.deleteMany({ where: { semesterId } });
  await prisma.feedbackPlanBatch.deleteMany({ where: { semesterId } });
  await prisma.classGroup.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { semesterId } });
  await prisma.student.deleteMany({ where: { id: { in: [...studentIds, ...scopeStudentIds] } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.semester.deleteMany({ where: { id: semesterId } });
});

describe("feedback plan batch service", () => {
  it("creates all child plans atomically, idempotently, and copies a confirmed shared lesson", async () => {
    const input = {
      requestKey: `${marker}-CREATE`,
      semesterId,
      type: "event_micro" as const,
      outputRequirement: "合成多班反馈",
      sharedLessonRevisionId: revisionId,
      sharedMaterialConfirmed: true,
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    };
    const [created, concurrent] = await Promise.all([
      createFeedbackPlanBatch(input),
      createFeedbackPlanBatch(input),
    ]);
    const repeated = await createFeedbackPlanBatch(input);
    expect(concurrent.id).toBe(created.id);
    expect(repeated.id).toBe(created.id);
    expect(created.plans).toHaveLength(2);
    expect(created.plans.map((plan) => plan.batchOrder)).toEqual([1, 2]);
    const snapshots = await prisma.feedbackPlan.findMany({ where: { batchId: created.id }, orderBy: { batchOrder: "asc" }, select: { inputSnapshot: true } });
    const revision = await prisma.groupLessonRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const confirmedMaterial = JSON.parse(revision.materialSnapshot);
    const confirmedStableMaterial = { ...confirmedMaterial };
    delete confirmedStableMaterial.sessionCode;
    expect(snapshots.map((plan) => {
      const stableMaterial = { ...JSON.parse(plan.inputSnapshot).lessonMaterial };
      delete stableMaterial.sessionCode;
      return stableMaterial;
    })).toEqual([confirmedStableMaterial, confirmedStableMaterial]);
    expect(snapshots.map((plan) => JSON.parse(plan.inputSnapshot).lessonMaterial.sessionCode)).toEqual(["2098010101", "2098010201"]);
  });

  it("allocates a readable default name and suffixes duplicate names in the same batch scope", async () => {
    const first = await createFeedbackPlanBatch({
      requestKey: `${marker}-NAME-1`,
      semesterId,
      type: "event_micro",
      outputRequirement: "命名测试一",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    const second = await createFeedbackPlanBatch({
      requestKey: `${marker}-NAME-2`,
      displayName: first.displayName ?? "初版计划",
      semesterId,
      type: "event_micro",
      outputRequirement: "命名测试二",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    expect(first.displayName).toMatch(/^初版计划(?: \d+)?$/u);
    expect(second.displayName).not.toBe(first.displayName);
    expect(second.displayName).toMatch(new RegExp(`^${first.displayName} \\d+$`, "u"));
    expect(first.plans.every((plan) => plan.displayName === null)).toBe(true);
    expect(second.plans.every((plan) => plan.displayName === null)).toBe(true);
    expect(first.status).toBe("draft");
  });

  it("allows an archived legacy batch to receive a display name without changing its history", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-ARCHIVED-RENAME`,
      semesterId,
      type: "event_micro",
      outputRequirement: "归档命名测试",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    await archiveFeedbackPlanBatch(batch.id);
    const archived = await prisma.feedbackPlanBatch.findUniqueOrThrow({ where: { id: batch.id } });
    const renamed = await renameFeedbackPlanBatch(batch.id, {
      action: "rename",
      displayName: "补记的历史计划名",
      expectedPlanRevision: archived.planRevision,
    });
    expect(renamed).toMatchObject({ displayName: "补记的历史计划名", status: "archived" });
    expect(renamed.archivedAt).not.toBeNull();
    await expect(prisma.feedbackPlan.count({ where: { batchId: batch.id, archivedAt: { not: null } } })).resolves.toBe(classIds.length);

    const restored = await unarchiveFeedbackPlanBatch(batch.id);
    expect(restored).toMatchObject({ displayName: "补记的历史计划名", status: "draft", archivedAt: null });
    await expect(prisma.feedbackPlan.count({ where: { batchId: batch.id, archivedAt: null } })).resolves.toBe(classIds.length);
  });

  it("inherits a group strategy while preserving class and student exceptions", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-STRATEGY-INHERITANCE`,
      semesterId,
      type: "event_micro",
      outputRequirement: "共同要求",
      generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
      plans: [{
        classId: classIds[0]!,
        sessionId: sessionIds[0]!,
        studentIds: [studentIds[0]!],
        outputRequirement: "一班要求",
        generationPreferences: {
          closureType: "teacher_resolved",
          moduleKeys: ["teacher_intervention"],
        },
        studentOverrides: [{
          studentId: studentIds[0]!,
          generationConfig: {
            version: 1,
            type: "event_micro",
            outputRequirement: "学生单独要求",
            generationPreferences: {
              closureType: "home_cooperation",
              moduleKeys: ["parent_action"],
            },
          },
        }],
      }, {
        classId: classIds[1]!,
        sessionId: sessionIds[1]!,
        studentIds: [studentIds[1]!],
      }],
    });
    const plans = await prisma.feedbackPlan.findMany({
      where: { batchId: batch.id },
      orderBy: { batchOrder: "asc" },
      select: { outputRequirement: true, inputSnapshot: true, items: { select: { generationConfigSnapshot: true } } },
    });

    expect(plans.map((plan) => plan.outputRequirement)).toEqual(["一班要求", "共同要求"]);
    expect(JSON.parse(plans[0]!.inputSnapshot).generationPreferences).toEqual({
      closureType: "teacher_resolved",
      moduleKeys: ["teacher_intervention"],
    });
    expect(plans.map((plan) => JSON.parse(plan.inputSnapshot).batchGenerationPreferences)).toEqual([
      { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
      { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
    ]);
    expect(JSON.parse(plans[0]!.items[0]!.generationConfigSnapshot)).toMatchObject({
      outputRequirement: "学生单独要求",
      generationPreferences: { closureType: "home_cooperation", moduleKeys: ["parent_action"] },
    });
    expect(plans[1]!.items[0]!.generationConfigSnapshot).toBe("{}");
  });

  it("saves a complete multi-class plan draft atomically and clears omitted exceptions", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-DRAFT-UPDATE`,
      displayName: "第一次多班计划",
      semesterId,
      type: "event_micro",
      outputRequirement: "原共同要求",
      plans: classIds.map((classId, index) => ({
        classId,
        sessionId: sessionIds[index],
        studentIds: [studentIds[index]!, scopeStudentIds[index]!],
        outputRequirement: index === 0 ? "原一班例外" : undefined,
      })),
    });
    await prisma.feedbackPlanBatch.update({ where: { id: batch.id }, data: { status: "ready" } });

    const updated = await updateFeedbackPlanBatchDraft(batch.id, {
      action: "plan_draft",
      expectedPlanRevision: batch.planRevision,
      displayName: "守恒关系课后反馈",
      outputRequirement: "更新后的共同要求",
      generationMode: "fast",
      generationPreferences: {
        closureType: "positive_recognition",
        moduleKeys: ["observed_moment"],
      },
      studentSelections: [
        { classId: classIds[0]!, studentIds: [scopeStudentIds[0]!] },
        { classId: classIds[1]!, studentIds: [studentIds[1]!] },
      ],
      classOverrides: [{
        classId: classIds[1]!,
        outputRequirement: "二班独立要求",
        generationPreferences: {
          closureType: "home_cooperation",
          moduleKeys: ["parent_action"],
        },
      }],
      studentOverrides: [{
        studentId: scopeStudentIds[0]!,
        generationConfig: {
          version: 1,
          type: "event_micro",
          outputRequirement: "一号学生独立要求",
          generationPreferences: {
            closureType: "teacher_resolved",
            moduleKeys: ["teacher_intervention"],
          },
        },
      }],
    });

    expect(updated).toMatchObject({
      displayName: "守恒关系课后反馈",
      outputRequirement: "更新后的共同要求",
      generationMode: "fast",
      status: "draft",
      planRevision: batch.planRevision + 1,
    });
    const plans = await prisma.feedbackPlan.findMany({
      where: { batchId: batch.id },
      orderBy: { batchOrder: "asc" },
      include: { items: true },
    });
    expect(plans.map((plan) => plan.outputRequirement)).toEqual(["更新后的共同要求", "二班独立要求"]);
    expect(plans.map((plan) => plan.generationMode)).toEqual(["fast", "fast"]);
    expect(plans.map((plan) => JSON.parse(plan.inputSnapshot).generationPreferences)).toEqual([
      { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
      { closureType: "home_cooperation", moduleKeys: ["parent_action"] },
    ]);
    expect(plans.map((plan) => plan.items.map((item) => item.studentId))).toEqual([[scopeStudentIds[0]], [studentIds[1]]]);
    expect(JSON.parse(plans[0]!.items[0]!.generationConfigSnapshot)).toMatchObject({ outputRequirement: "一号学生独立要求" });
    expect(plans[1]!.items[0]!.generationConfigSnapshot).toBe("{}");

    await expect(updateFeedbackPlanBatchDraft(batch.id, {
      action: "plan_draft",
      expectedPlanRevision: updated.planRevision,
      outputRequirement: "不应部分保存",
      generationMode: "standard",
      generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
      studentSelections: [
        { classId: classIds[0]!, studentIds: [scopeStudentIds[0]!] },
        { classId: classIds[1]!, studentIds: [studentIds[1]!] },
      ],
      classOverrides: [],
      studentOverrides: [{
        studentId: "missing-student",
        generationConfig: {
          version: 1,
          type: "event_micro",
          outputRequirement: "无效学生",
          generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
        },
      }],
    })).rejects.toMatchObject({ status: 400 });
    await expect(updateFeedbackPlanBatchDraft(batch.id, {
      action: "plan_draft",
      expectedPlanRevision: updated.planRevision,
      outputRequirement: "不应越过冻结事实",
      generationMode: "standard",
      generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
      studentSelections: [
        { classId: classIds[0]!, studentIds: ["missing-student"] },
        { classId: classIds[1]!, studentIds: [studentIds[1]!] },
      ],
      classOverrides: [],
      studentOverrides: [],
    })).rejects.toMatchObject({ status: 409 });
    await expect(prisma.feedbackPlanBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      outputRequirement: "更新后的共同要求",
      planRevision: updated.planRevision,
    });
  });

  it("blocks plan edits after generation starts while keeping rename available", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-DRAFT-LOCK`,
      displayName: "生成前名称",
      semesterId,
      type: "event_micro",
      outputRequirement: "生成锁定测试",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    await prisma.feedbackPlan.update({ where: { id: batch.plans[0]!.id }, data: { generationStartedAt: new Date() } });

    await expect(updateFeedbackPlanBatchDraft(batch.id, {
      action: "plan_draft",
      expectedPlanRevision: batch.planRevision,
      outputRequirement: "不能覆盖",
      generationMode: "standard",
      generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
      studentSelections: classIds.map((classId, index) => ({ classId, studentIds: [studentIds[index]!] })),
      classOverrides: [],
      studentOverrides: [],
    })).rejects.toMatchObject({ status: 409 });

    const renamed = await renameFeedbackPlanBatch(batch.id, {
      action: "rename",
      displayName: "生成后仍可改名",
      expectedPlanRevision: batch.planRevision,
    });
    expect(renamed.displayName).toBe("生成后仍可改名");
    expect(renamed.planRevision).toBe(batch.planRevision + 1);
  });

  it("refuses to start a historically inconsistent batch when a child already has generated output", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-HISTORICAL-TRACE-LOCK`,
      displayName: "历史生成痕迹保护",
      semesterId,
      type: "event_micro",
      outputRequirement: "不能覆盖历史正文",
      plans: classIds.map((classId, index) => ({
        classId,
        sessionId: sessionIds[index],
        studentIds: [studentIds[index]!],
      })),
    });
    const firstChild = await prisma.feedbackPlan.findUniqueOrThrow({
      where: { id: batch.plans[0]!.id },
      include: { items: true },
    });
    const finalText = "历史子计划已经生成的正文";
    await prisma.feedbackPlanItem.update({
      where: { id: firstChild.items[0]!.id },
      data: { status: "needs_review", finalText, finalTextHash: "historical-trace" },
    });

    await expect(startFeedbackPlanBatch(batch.id, prisma, batch.planRevision)).rejects.toMatchObject({ status: 409 });
    await expect(prisma.feedbackPlanBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({
      status: batch.status,
      planRevision: batch.planRevision,
    });
    await expect(prisma.feedbackPlanItem.findUniqueOrThrow({ where: { id: firstChild.items[0]!.id } })).resolves.toMatchObject({
      status: "needs_review",
      finalText,
    });
  });

  it("clones a generated batch into a clean draft without copying outputs", async () => {
    const source = await createFeedbackPlanBatch({
      requestKey: `${marker}-CLONE-SOURCE`,
      displayName: "氧化还原反馈工程",
      semesterId,
      type: "event_micro",
      outputRequirement: "克隆来源要求",
      generationMode: "fast",
      plans: classIds.map((classId, index) => ({
        classId,
        sessionId: sessionIds[index],
        studentIds: [studentIds[index]!],
        studentOverrides: index === 0 ? [{
          studentId: studentIds[index]!,
          generationConfig: {
            version: 1,
            type: "event_micro",
            outputRequirement: "保留的独立计划",
            generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment"] },
          },
        }] : undefined,
      })),
    });
    const sourceItems = await prisma.feedbackPlanItem.findMany({ where: { planId: { in: source.plans.map((plan) => plan.id) } } });
    const sourceEvidenceByPlanId = new Map(sourceItems.map((item) => [item.planId, item.evidenceSnapshot]));
    await Promise.all(studentIds.map((studentId, index) => prisma.event.create({
      data: { studentId, sessionId: sessionIds[index]!, type: "课堂表现", description: `后录入事实 ${index + 1}`, rawText: "合成测试" },
    })));
    await prisma.feedbackPlanItem.update({
      where: { id: sourceItems[0]!.id },
      data: {
        status: "approved",
        finalText: "来源批次已经生成的正文",
        finalTextHash: "source-text",
        compositionSnapshot: JSON.stringify({ source: true }),
        auditSnapshot: JSON.stringify({ source: true }),
        approvedAt: new Date(),
      },
    });
    await prisma.feedbackPlan.update({ where: { id: sourceItems[0]!.planId }, data: { status: "approved", approvedAt: new Date(), generationStartedAt: new Date() } });
    await prisma.feedbackPlanBatch.update({ where: { id: source.id }, data: { status: "completed" } });

    const clone = await cloneFeedbackPlanBatchDraft({ batchId: source.id, displayName: "氧化还原反馈工程 · 修订 2" });
    expect(clone).toMatchObject({
      displayName: "氧化还原反馈工程 · 修订 2",
      basedOnBatchId: source.id,
      status: "draft",
      outputRequirement: source.outputRequirement,
      generationMode: source.generationMode,
    });
    expect(clone.plans.map((plan) => plan.id)).not.toEqual(source.plans.map((plan) => plan.id));
    const clonedPlans = await prisma.feedbackPlan.findMany({
      where: { batchId: clone.id },
      orderBy: { batchOrder: "asc" },
      include: { items: true, exportRuns: true },
    });
    expect(clonedPlans.map((plan) => plan.basedOnPlanId)).toEqual(source.plans.map((plan) => plan.id));
    expect(clonedPlans.every((plan) => plan.status === "draft" && !plan.approvedAt && !plan.exportedAt && plan.exportRuns.length === 0)).toBe(true);
    expect(clonedPlans.flatMap((plan) => plan.items)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "evidence_ready", finalText: null, selectedGenerationId: null, approvedAt: null, exportedAt: null }),
    ]));
    expect(clonedPlans.flatMap((plan) => plan.items).every((item) => item.finalText === null
      && item.compositionSnapshot === "{}"
      && item.auditSnapshot === "{}"
      && item.selectedGenerationId === null)).toBe(true);
    expect(clonedPlans.every((plan) => plan.items[0]?.evidenceSnapshot === sourceEvidenceByPlanId.get(plan.basedOnPlanId!))).toBe(true);
    expect(clonedPlans.flatMap((plan) => plan.items).every((item) => !item.evidenceSnapshot.includes("后录入事实"))).toBe(true);
    expect(JSON.parse(clonedPlans[0]!.items[0]!.generationConfigSnapshot)).toMatchObject({ outputRequirement: "保留的独立计划" });

    const savedAs = await saveFeedbackPlanBatchAs({
      batchId: source.id,
      displayName: "氧化还原反馈工程 · 页面修订",
      patch: {
        action: "plan_draft",
        outputRequirement: "页面中的新统一要求",
        generationMode: "standard",
        generationPreferences: { closureType: "positive_recognition", length: "detailed", tone: "professional", moduleKeys: ["observed_moment"] },
        studentSelections: classIds.map((classId, index) => ({ classId, studentIds: [studentIds[index]!] })),
        classOverrides: [],
        studentOverrides: [],
        expectedPlanRevision: source.planRevision,
      },
    });
    expect(savedAs).toMatchObject({ displayName: "氧化还原反馈工程 · 页面修订", basedOnBatchId: source.id, status: "draft", outputRequirement: "页面中的新统一要求" });
    expect(savedAs.plans.every((plan) => plan.status === "draft" && plan.items.every((item) => item.status === "evidence_ready"))).toBe(true);
    await expect(getFeedbackPlanBatch(source.id)).resolves.toMatchObject({ displayName: "氧化还原反馈工程", status: "completed", outputRequirement: "克隆来源要求" });

    const unnamedClone = await cloneFeedbackPlanBatchDraft({ batchId: source.id });
    expect(unnamedClone.displayName).toBeNull();
    await expect(startFeedbackPlanBatch(unnamedClone.id)).rejects.toMatchObject({ status: 409 });
  });

  it("creates a selected-class revision from current facts and links it to the source batch", async () => {
    const source = await createFeedbackPlanBatch({
      requestKey: `${marker}-CURRENT-FACTS-SOURCE`,
      displayName: "当前事实来源批次",
      semesterId,
      type: "event_micro",
      outputRequirement: "来源批次要求",
      generationMode: "fast",
      generationPreferences: { closureType: "positive_recognition", length: "short", tone: "gentle", moduleKeys: ["observed_moment"] },
      plans: classIds.map((classId, index) => ({
        classId,
        sessionId: sessionIds[index],
        studentIds: [studentIds[index]!],
        generationPreferences: { closureType: "positive_recognition", length: "short", tone: "gentle", moduleKeys: ["observed_moment"] },
      })),
    });
    const sourceItem = await prisma.feedbackPlanItem.findFirstOrThrow({ where: { planId: source.plans[0]!.id } });
    const sourceEvidence = sourceItem.evidenceSnapshot;
    await prisma.event.create({
      data: { studentId: studentIds[0]!, sessionId: sessionIds[0]!, type: "课堂表现", description: "批次录入后新增的当前事实", rawText: "合成测试" },
    });

    const unnamedRevision = await createFeedbackPlanBatch({
      requestKey: `${marker}-CURRENT-FACTS-UNNAMED-REVISION`,
      basedOnBatchId: source.id,
      semesterId,
      type: "event_micro",
      outputRequirement: "来源批次要求",
      generationMode: "fast",
      plans: [{
        classId: classIds[0]!,
        sessionId: sessionIds[0]!,
        studentIds: [studentIds[0]!],
      }],
    });
    expect(unnamedRevision).toMatchObject({ displayName: null, basedOnBatchId: source.id, status: "draft" });
    await expect(startFeedbackPlanBatch(unnamedRevision.id)).rejects.toMatchObject({ status: 409 });

    const revision = await createFeedbackPlanBatch({
      requestKey: `${marker}-CURRENT-FACTS-REVISION`,
      displayName: "当前事实批次修正版",
      basedOnBatchId: source.id,
      semesterId,
      type: "event_micro",
      outputRequirement: "来源批次要求",
      generationMode: "fast",
      generationPreferences: { closureType: "positive_recognition", length: "short", tone: "gentle", moduleKeys: ["observed_moment"] },
      plans: [{
        classId: classIds[0]!,
        sessionId: sessionIds[0]!,
        studentIds: [studentIds[0]!],
        generationPreferences: { closureType: "positive_recognition", length: "short", tone: "gentle", moduleKeys: ["observed_moment"] },
      }],
    });
    expect(revision).toMatchObject({ displayName: "当前事实批次修正版", basedOnBatchId: source.id, status: "draft" });
    expect(revision.plans).toHaveLength(1);
    expect(revision.plans[0]).toMatchObject({ basedOnPlanId: source.plans[0]!.id });
    const revisionItem = await prisma.feedbackPlanItem.findFirstOrThrow({ where: { planId: revision.plans[0]!.id } });
    expect(revisionItem.evidenceSnapshot).toContain("批次录入后新增的当前事实");
    await expect(prisma.feedbackPlanItem.findUniqueOrThrow({ where: { id: sourceItem.id } })).resolves.toMatchObject({ evidenceSnapshot: sourceEvidence });
  });

  it("rolls back the whole batch when one class is invalid", async () => {
    const requestKey = `${marker}-ROLLBACK`;
    await expect(createFeedbackPlanBatch({
      requestKey,
      semesterId,
      type: "event_micro",
      outputRequirement: "合成原子回滚",
      plans: [
        { classId: classIds[0]!, sessionId: sessionIds[0]!, studentIds: [studentIds[0]!] },
        { classId: "missing-class", sessionId: sessionIds[1]!, studentIds: [studentIds[1]!] },
      ],
    })).rejects.toMatchObject({ status: 404 });
    await expect(prisma.feedbackPlanBatch.count({ where: { requestKey } })).resolves.toBe(0);
    await expect(prisma.feedbackPlan.count({ where: { outputRequirement: "合成原子回滚" } })).resolves.toBe(0);
  });

  it("creates a group-lesson batch from independently confirmed intake runs", async () => {
    const runs = await Promise.all(sessionIds.map((sessionId, index) => prisma.feedbackIntakeRun.create({
      data: {
        sessionCode: `2098010${index + 1}01`,
        sourceFingerprint: `${marker}-GROUP-RUN-${index}`,
        sourceManifest: "[]",
        status: "applied",
        appliedSummary: JSON.stringify({ applied: true, assessmentEvidence: {} }),
      },
    })));
    await expect(createFeedbackPlanBatch({
      requestKey: `${marker}-WRONG-LESSON`,
      semesterId,
      type: "event_micro",
      outputRequirement: "错误共同课",
      groupLessonId: "missing-group-lesson",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], intakeRunId: runs[index]!.id, studentIds: [studentIds[index]!] })),
    })).rejects.toMatchObject({ status: 409 });

    const input = {
      requestKey: `${marker}-GROUP-INTAKE`,
      semesterId,
      type: "event_micro" as const,
      outputRequirement: "班级组一站式反馈",
      generationMode: "fast" as const,
      groupLessonId: lessonId,
      sharedLessonRevisionId: revisionId,
      sharedMaterialConfirmed: true,
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], intakeRunId: runs[index]!.id, studentIds: [studentIds[index]!] })),
    };
    const created = await createFeedbackPlanBatch(input);
    const repeated = await createFeedbackPlanBatch(input);
    expect(repeated.id).toBe(created.id);
    expect(created.plans).toHaveLength(2);
    const linkedRuns = await prisma.feedbackIntakeRun.findMany({ where: { id: { in: runs.map((run) => run.id) } }, orderBy: { sourceFingerprint: "asc" } });
    expect(linkedRuns.every((run) => Boolean(run.planId))).toBe(true);
    expect(new Set(linkedRuns.map((run) => run.planId)).size).toBe(2);
  });

  it("uses historical real-session links after a class leaves the current group", async () => {
    const groupId = (await prisma.groupLesson.findUniqueOrThrow({ where: { id: lessonId }, select: { groupId: true } })).groupId;
    await prisma.classGroupMembership.delete({ where: { classId: classIds[1]! } });
    try {
      const runs = await Promise.all(sessionIds.map((_sessionId, index) => prisma.feedbackIntakeRun.create({
        data: {
          sessionCode: `2098010${index + 1}01`,
          sourceFingerprint: `${marker}-HISTORICAL-GROUP-RUN-${index}`,
          sourceManifest: "[]",
          status: "applied",
          appliedSummary: JSON.stringify({ applied: true, assessmentEvidence: {} }),
        },
      })));
      const batch = await createFeedbackPlanBatch({
        requestKey: `${marker}-HISTORICAL-GROUP-BATCH`,
        semesterId,
        type: "event_micro",
        outputRequirement: "按历史共同课真实课次生成",
        groupLessonId: lessonId,
        sharedLessonRevisionId: revisionId,
        sharedMaterialConfirmed: true,
        plans: classIds.map((classId, index) => ({
          classId,
          sessionId: sessionIds[index],
          intakeRunId: runs[index]!.id,
          studentIds: [studentIds[index]!],
        })),
      });
      expect(batch.plans).toHaveLength(2);
    } finally {
      await prisma.classGroupMembership.create({ data: { groupId, classId: classIds[1]! } });
    }
  });

  it("allows one confirmed intake run to seed another plan without stealing its legacy pointer", async () => {
    const outputRequirement = "班级组复用确认材料";
    const existingPlan = await createFeedbackPlan({
      semesterId,
      classId: classIds[0]!,
      sessionId: sessionIds[0]!,
      type: "event_micro",
      outputRequirement,
      studentIds: [studentIds[0]!],
    });
    const runs = await Promise.all(sessionIds.map((sessionId, index) => prisma.feedbackIntakeRun.create({
      data: {
        sessionCode: `2098010${index + 1}01`,
        sourceFingerprint: `${marker}-ADOPT-RUN-${index}`,
        sourceManifest: "[]",
        status: "applied",
        appliedSummary: JSON.stringify({ applied: true, assessmentEvidence: {} }),
        ...(index === 0 ? { planId: existingPlan.id } : {}),
      },
    })));

    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-REUSE-RUN-BATCH`,
      semesterId,
      type: "event_micro" as const,
      outputRequirement: "新的班级组计划",
      generationMode: "standard" as const,
      groupLessonId: lessonId,
      sharedLessonRevisionId: revisionId,
      sharedMaterialConfirmed: true,
      plans: classIds.map((classId, index) => ({
        classId,
        sessionId: sessionIds[index],
        intakeRunId: runs[index]!.id,
        studentIds: [studentIds[index]!],
      })),
    });

    expect(batch.plans).toHaveLength(2);
    expect(batch.plans[0]?.id).not.toBe(existingPlan.id);
    expect((await prisma.feedbackPlan.findUniqueOrThrow({ where: { id: existingPlan.id } })).batchId).toBeNull();
    expect((await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: runs[0]!.id } })).planId).toBe(existingPlan.id);
    const inputSnapshot = JSON.parse(batch.plans[0]!.inputSnapshot) as {
      version?: number;
      intakeSources?: Array<{ intakeRunId: string }>;
    };
    expect(inputSnapshot.version).toBe(2);
    expect(inputSnapshot.intakeSources?.map((source) => source.intakeRunId) ?? []).toContain(runs[0]!.id);
  });

  it("creates from a run whose legacy pointer still references an archived plan", async () => {
    const outputRequirement = "班级组替换已归档计划";
    const archivedPlan = await createFeedbackPlan({
      semesterId,
      classId: classIds[0]!,
      sessionId: sessionIds[0]!,
      type: "event_micro",
      outputRequirement,
      studentIds: [studentIds[0]!],
    });
    await prisma.feedbackPlan.update({
      where: { id: archivedPlan.id },
      data: { archivedAt: new Date(), status: "archived" },
    });
    const run = await prisma.feedbackIntakeRun.create({
      data: {
        sessionCode: "2098010101",
        sourceFingerprint: `${marker}-ARCHIVED-PLAN-RUN`,
        sourceManifest: "[]",
        status: "applied",
        appliedSummary: JSON.stringify({ applied: true, assessmentEvidence: {} }),
        planId: archivedPlan.id,
      },
    });

    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-ARCHIVED-PLAN-BATCH`,
      semesterId,
      type: "event_micro",
      outputRequirement,
      groupLessonId: lessonId,
      sharedLessonRevisionId: revisionId,
      sharedMaterialConfirmed: true,
      plans: [{
        classId: classIds[0]!,
        sessionId: sessionIds[0]!,
        intakeRunId: run.id,
        studentIds: [studentIds[0]!],
      }, {
        classId: classIds[1]!,
        sessionId: sessionIds[1]!,
        studentIds: [studentIds[1]!],
      }],
    });

    expect(batch.plans[0]?.id).not.toBe(archivedPlan.id);
    expect((await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: run.id } })).planId).toBe(archivedPlan.id);
    expect((await prisma.feedbackPlan.findUniqueOrThrow({ where: { id: archivedPlan.id } })).archivedAt).not.toBeNull();
  });

  it("stops after a failed class and resumes serially from that class", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-SCHEDULE`,
      semesterId,
      type: "event_micro",
      outputRequirement: "合成串行恢复",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    const callOrder: string[] = [];
    let shouldFail = true;
    generationMocks.generate.mockImplementation(async (input: { evidenceBundle: { studentId: string | null; teachingEvidence: Array<{ id: string; content: string }> } }) => {
      callOrder.push(input.evidenceBundle.studentId ?? "");
      if (shouldFail) { shouldFail = false; throw new Error("synthetic failure"); }
      const evidence = input.evidenceBundle.teachingEvidence[0] ?? { id: "fallback", content: "已确认课堂事实" };
      const composition = {
        version: 1 as const,
        closureType: "positive_recognition" as const,
        needParentAction: false,
        parentAction: null,
        modules: [{ key: "observed_moment", content: evidence.content, evidenceRefs: [evidence.id], status: "included" as const, reason: "合成测试" }],
        evidenceCoverage: [{ evidenceId: evidence.id, statement: evidence.content }],
        draftFeedback: evidence.content,
      };
      return { draftComposition: composition, composition };
    });
    await startFeedbackPlanBatch(batch.id);
    await vi.waitFor(async () => expect((await getFeedbackPlanBatch(batch.id))?.status).toBe("failed"), { timeout: 5000, interval: 50 });
    expect(callOrder).toEqual([studentIds[0]]);
    const stopped = await getFeedbackPlanBatch(batch.id);
    expect(stopped?.plans[1]?.progress.generated).toBe(0);

    await retryFeedbackPlanBatch(batch.id);
    await vi.waitFor(async () => expect((await getFeedbackPlanBatch(batch.id))?.status).toBe("completed"), { timeout: 5000, interval: 50 });
    expect(callOrder).toEqual([studentIds[0], studentIds[0], studentIds[1]]);
  });

  it("switches only failed and not-started batch items to free generation", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-FREE-FALLBACK`,
      semesterId,
      type: "event_micro",
      outputRequirement: "合成批次显式降级",
      generationApproach: "restricted",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    const failedPlan = batch.plans[0]!;
    const failedItem = failedPlan.items[0]!;
    await prisma.feedbackPlanItem.update({
      where: { id: failedItem.id },
      data: {
        status: "generation_failed",
        generationError: "受限 Writer 失败",
        generationExecutionSnapshot: JSON.stringify({
          version: 1,
          requestedApproach: "restricted",
          nextApproach: "restricted",
          attempts: [{
            attempt: 1,
            trigger: "initial",
            actualApproach: "restricted",
            status: "failed",
            startedAt: "2098-01-01T08:00:00.000Z",
            completedAt: "2098-01-01T08:00:01.000Z",
            error: { code: "llm_service_error", message: "受限 Writer 失败", retryable: true },
          }],
        }),
      },
    });
    await prisma.feedbackPlan.update({
      where: { id: failedPlan.id },
      data: { status: "generation_failed", generationStartedAt: new Date("2098-01-01T08:00:00.000Z") },
    });
    await prisma.feedbackPlanBatch.update({
      where: { id: batch.id },
      data: { status: "failed", currentPlanId: failedPlan.id, failedPlanId: failedPlan.id },
    });

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const actualModes: string[] = [];
    generationMocks.generate.mockImplementation(async (input: {
      generationMode?: string;
      evidenceBundle: { teachingEvidence: Array<{ id: string; content: string }> };
    }) => {
      actualModes.push(input.generationMode ?? "");
      if (actualModes.length === 1) await firstGate;
      const evidence = input.evidenceBundle.teachingEvidence[0] ?? { id: "fallback", content: "已确认课堂事实" };
      const composition = {
        version: 1 as const,
        closureType: "positive_recognition" as const,
        needParentAction: false,
        parentAction: null,
        modules: [
          { key: "observed_moment", content: evidence.content, evidenceRefs: [evidence.id], status: "included" as const, reason: "自由反馈测试" },
          { key: "teacher_interpretation", content: "方法逐步稳定", evidenceRefs: [evidence.id], status: "included" as const, reason: "自由反馈测试" },
        ],
        evidenceCoverage: [{ evidenceId: evidence.id, statement: evidence.content }],
        draftFeedback: `${evidence.content}，方法逐步稳定。`,
      };
      return { draftComposition: composition, composition };
    });

    await retryFeedbackPlanBatchWithFree(batch.id);
    await vi.waitFor(async () => {
      const current = await prisma.feedbackPlanItem.findUniqueOrThrow({ where: { id: failedItem.id } });
      expect(current.status).toBe("generating");
    });
    const preparedItems = await prisma.feedbackPlanItem.findMany({
      where: { plan: { batchId: batch.id } },
      orderBy: { plan: { batchOrder: "asc" } },
    });
    expect(preparedItems).toHaveLength(2);
    expect(preparedItems.map((item) => JSON.parse(item.generationExecutionSnapshot).nextApproach)).toEqual(["free", "free"]);
    expect(preparedItems[1]!.status).toBe("evidence_ready");
    releaseFirst!();
    await vi.waitFor(async () => expect((await getFeedbackPlanBatch(batch.id))?.status).toBe("completed"), { timeout: 5000, interval: 50 });
    expect(actualModes).toEqual(["fast", "fast"]);
    await expect(prisma.feedbackPlanBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({ generationApproach: "restricted" });
  });

  it("keeps pause, continue, and retry under the batch coordinator", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-CHILD-CONTROL`,
      semesterId,
      type: "event_micro",
      outputRequirement: "合成子计划控制边界",
      plans: classIds.map((classId, index) => ({
        classId,
        sessionId: sessionIds[index],
        studentIds: [studentIds[index]!],
      })),
    });
    const child = batch.plans[0]!;
    const item = child.items[0]!;

    await prisma.feedbackPlan.update({ where: { id: child.id }, data: { status: "queued" } });
    await expect(pauseFeedbackPlanGeneration(child.id)).rejects.toThrow("班级组子计划由批次统一控制");

    await prisma.feedbackPlan.update({ where: { id: child.id }, data: { status: "paused", generationStartedAt: new Date() } });
    await prisma.feedbackPlanItem.update({ where: { id: item.id }, data: { status: "queued" } });
    await expect(continueFeedbackPlanGeneration(child.id)).rejects.toThrow("班级组子计划由批次统一控制");

    await prisma.feedbackPlan.update({ where: { id: child.id }, data: { status: "generation_failed" } });
    await prisma.feedbackPlanItem.update({ where: { id: item.id }, data: { status: "generation_failed" } });
    await expect(retryFeedbackPlanGeneration({ planId: child.id })).rejects.toThrow("班级组子计划由批次统一控制");
    await expect(prisma.feedbackPlanBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({ status: "draft" });
  });

  it("refuses to archive a batch while a child plan is still active", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-ACTIVE-ARCHIVE`,
      semesterId,
      type: "event_micro",
      outputRequirement: "合成归档停机边界",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    await prisma.feedbackPlanBatch.update({ where: { id: batch.id }, data: { status: "paused" } });
    await prisma.feedbackPlan.update({ where: { id: batch.plans[0]!.id }, data: { status: "generating" } });
    await prisma.feedbackPlanItem.update({ where: { id: batch.plans[0]!.items[0]!.id }, data: { status: "generating" } });

    await expect(archiveFeedbackPlanBatch(batch.id)).rejects.toThrow("仍有班级正在生成");
    await expect(prisma.feedbackPlanBatch.findUniqueOrThrow({ where: { id: batch.id } })).resolves.toMatchObject({ archivedAt: null });
  });

  it("lets the running item finish before pausing and continues with the next class", async () => {
    const batch = await createFeedbackPlanBatch({
      requestKey: `${marker}-PAUSE`,
      semesterId,
      type: "event_micro",
      outputRequirement: "合成暂停恢复",
      plans: classIds.map((classId, index) => ({ classId, sessionId: sessionIds[index], studentIds: [studentIds[index]!] })),
    });
    const callOrder: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    generationMocks.generate.mockImplementation(async (input: { evidenceBundle: { studentId: string | null; teachingEvidence: Array<{ id: string; content: string }> } }) => {
      callOrder.push(input.evidenceBundle.studentId ?? "");
      if (callOrder.length === 1) await firstGate;
      const evidence = input.evidenceBundle.teachingEvidence[0] ?? { id: "fallback", content: "已确认课堂事实" };
      const composition = {
        version: 1 as const,
        closureType: "positive_recognition" as const,
        needParentAction: false,
        parentAction: null,
        modules: [{ key: "observed_moment", content: evidence.content, evidenceRefs: [evidence.id], status: "included" as const, reason: "合成测试" }],
        evidenceCoverage: [{ evidenceId: evidence.id, statement: evidence.content }],
        draftFeedback: evidence.content,
      };
      return { draftComposition: composition, composition };
    });
    await startFeedbackPlanBatch(batch.id);
    await vi.waitFor(async () => expect((await getFeedbackPlanBatch(batch.id))?.plans[0]?.progress.running).toBe(1), { timeout: 5000, interval: 50 });
    await pauseFeedbackPlanBatch(batch.id);
    releaseFirst?.();
    await vi.waitFor(async () => expect((await getFeedbackPlanBatch(batch.id))?.status).toBe("paused"), { timeout: 5000, interval: 50 });
    expect(callOrder).toEqual([studentIds[0]]);

    await continueFeedbackPlanBatch(batch.id);
    await vi.waitFor(async () => expect((await getFeedbackPlanBatch(batch.id))?.status).toBe("completed"), { timeout: 5000, interval: 50 });
    expect(callOrder).toEqual([studentIds[0], studentIds[1]]);
  });

  it("exports approved student items across classes once, including a prior single-plan export", async () => {
    const batch = await prisma.feedbackPlanBatch.findUniqueOrThrow({ where: { requestKey: `${marker}-CREATE` }, include: { plans: { orderBy: { batchOrder: "asc" }, include: { items: true } } } });
    for (const [index, plan] of batch.plans.entries()) {
      const item = plan.items[0]!;
      const finalText = `合成${index + 1}班最终反馈`;
      await prisma.feedbackPlanItem.update({ where: { id: item.id }, data: { status: index === 0 ? "exported" : "approved", finalText, finalTextHash: createHash("sha256").update(finalText).digest("hex"), approvedAt: new Date(), ...(index === 0 ? { exportedAt: new Date() } : {}) } });
    }
    const firstPlan = batch.plans[0]!;
    const firstItem = firstPlan.items[0]!;
    const secondPlan = batch.plans[1]!;
    const secondItem = secondPlan.items[0]!;
    await prisma.feedbackExportRun.create({ data: { planId: firstPlan.id, mode: "approved_only", itemManifest: JSON.stringify([{ itemId: firstItem.id, finalTextHash: "single" }]), manifestHash: "single-plan-export" } });
    expect((await getFeedbackPlanBatch(batch.id))?.progress.exported).toBe(0);

    const missingAttachment = await prisma.feedbackAttachment.create({
      data: {
        planId: secondPlan.id,
        planItemId: secondItem.id,
        displayName: "missing.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: "0".repeat(64),
        relativeLocator: `feedback-attachments/${secondPlan.id}/missing.pdf`,
        status: "missing",
      },
    });
    await expect(buildFeedbackPlanBatchExportWorkbook(prisma, batch.id, "approved_only")).rejects.toMatchObject({ code: "conflict" });
    await expect(prisma.feedbackPlanBatchExportRun.count({ where: { batchId: batch.id } })).resolves.toBe(0);
    await prisma.feedbackAttachment.delete({ where: { id: missingAttachment.id } });

    const buffer = await buildFeedbackPlanBatchExportWorkbook(prisma, batch.id, "approved_only");
    const workbook = XLSX.read(buffer, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["课后反馈"], { defval: "" });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.班级编号)).toEqual([`${marker}-1`, `${marker}-2`]);
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining(["班级编号", "班级名称", "最终反馈"]));
    for (const sheetName of ["课后反馈", "教师内部研判", "教师待办", "附件清单"]) {
      const header = XLSX.utils.sheet_to_json<Array<string>>(workbook.Sheets[sheetName], { header: 1, defval: "" })[0];
      expect(header).toEqual(expect.arrayContaining(["班级编号", "班级名称"]));
    }
    await expect(prisma.feedbackPlanBatchExportRun.count({ where: { batchId: batch.id } })).resolves.toBe(1);
    await expect(prisma.feedbackExportRun.count({ where: { batchExportRunId: { not: null }, planId: { in: batch.plans.map((plan) => plan.id) } } })).resolves.toBe(2);
    await expect(buildFeedbackPlanBatchExportWorkbook(prisma, batch.id, "complete")).rejects.toMatchObject({ code: "repeat_export" });
    await expect(buildFeedbackPlanBatchExportWorkbook(prisma, batch.id, "complete", { allowRepeat: true })).resolves.toBeInstanceOf(Uint8Array);
    const refreshed = await getFeedbackPlanBatch(batch.id);
    expect(refreshed?.progress.exported).toBe(2);
  });
});
