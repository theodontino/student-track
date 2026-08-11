import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
const generationMocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/llm")>(),
  createLLMClient: () => ({ chat: { completions: { create: vi.fn() } } }),
  getLLMModel: () => "test-feedback-model",
}));
vi.mock("@/services/feedback-generation-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/feedback-generation-service")>(),
  generateFeedbackPlanComposition: generationMocks.generate,
}));
import { addFeedbackAttachment, approveFeedbackPlanItems, archiveFeedbackPlan, continueFeedbackPlanGeneration, createFeedbackPlan, createPreferenceCandidate, createTeacherTask, deleteFeedbackPlan, generateFeedbackPlanItems, getFeedbackPlan, invalidateFeedbackPlans, listFeedbackPlans, listTeacherTasks, patchFeedbackPlanItem, pauseFeedbackPlanGeneration, removeFeedbackAttachment, resolvePreferenceCandidate, retainStaleFeedbackPlanItems, startFeedbackPlanGeneration, toFeedbackPlanDetail, unarchiveFeedbackPlan } from "@/services/feedback-plan-service";
import { buildFeedbackPlanExportWorkbook, buildWeComDraftPackage } from "@/services/feedback-export-service";

const suffix = "PLAN-SERVICE";
const classCode = `TEST-${suffix}`;
const semesterName = `TEST-${suffix}`;
const studentNumber = `TEST-${suffix}`;
const sessionCode = `TEST-${suffix}`;
const rangeSessionCodes = [`TEST-${suffix}-1`, `TEST-${suffix}-2`, `TEST-${suffix}-3`, `TEST-${suffix}-4`];
const attachmentRoots: string[] = [];

afterEach(async () => {
  generationMocks.generate.mockReset();
  delete process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT;
  await Promise.all(attachmentRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  await prisma.feedbackPlan.deleteMany({ where: { outputRequirement: "测试事件反馈" } });
  await prisma.feedbackPlan.deleteMany({ where: { outputRequirement: "测试阶段范围" } });
  await prisma.feedbackPlan.deleteMany({ where: { outputRequirement: "测试队列生成" } });
  await prisma.classSession.deleteMany({ where: { code: sessionCode } });
  await prisma.classSession.deleteMany({ where: { code: `${sessionCode}-WCG` } });
  await prisma.classSession.deleteMany({ where: { code: `${sessionCode}-QUEUE` } });
  await prisma.classSession.deleteMany({ where: { code: { in: rangeSessionCodes } } });
  await prisma.student.deleteMany({ where: { studentId: `${studentNumber}-RANGE` } });
  await prisma.student.deleteMany({ where: { studentId: studentNumber } });
  await prisma.student.deleteMany({ where: { studentId: `${studentNumber}-OVERRIDE` } });
  await prisma.student.deleteMany({ where: { studentId: `${studentNumber}-WCG` } });
  await prisma.student.deleteMany({ where: { studentId: { startsWith: `${studentNumber}-QUEUE-` } } });
  await prisma.class.deleteMany({ where: { code: `${classCode}-RANGE` } });
  await prisma.class.deleteMany({ where: { code: classCode } });
  await prisma.class.deleteMany({ where: { code: `${classCode}-WCG` } });
  await prisma.class.deleteMany({ where: { code: `${classCode}-QUEUE` } });
  await prisma.semester.deleteMany({ where: { name: `${semesterName}-RANGE` } });
  await prisma.semester.deleteMany({ where: { name: semesterName } });
  await prisma.semester.deleteMany({ where: { name: `${semesterName}-WCG` } });
  await prisma.semester.deleteMany({ where: { name: `${semesterName}-QUEUE` } });
});

describe("feedback plan service", () => {
  it("keeps pending teacher tasks ahead of a bounded history tail", async () => {
    const pending = [{ id: "pending-task", status: "pending" }];
    const history = [{ id: "completed-task", status: "completed" }];
    const findMany = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(history);
    const db = { teacherTask: { findMany } } as unknown as PrismaClient;

    await expect(listTeacherTasks({ semesterId: "semester-test" }, db)).resolves.toEqual([...pending, ...history]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where: { plan: { semesterId: "semester-test" }, status: "pending" } });
    expect(findMany.mock.calls[1]![0]).toMatchObject({ where: { plan: { semesterId: "semester-test" }, status: { not: "pending" } }, take: 200 });
  });

  it("puts a partial teacher observation event into the feedback evidence basket", async () => {
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: classCode, name: "教师观察证据测试班" } });
    const student = await prisma.student.create({ data: { name: "测试学生", studentId: studentNumber, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({
      data: {
        studentId: student.id,
        sessionId: session.id,
        type: "教师处理",
        description: "观察问题：后半节开始漏看题目条件；证据：老师当场提醒",
        rawText: "合成测试",
      },
    });

    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const evidence = JSON.parse(plan.items[0]!.evidenceSnapshot) as {
      teachingEvidence: Array<{ kind: string; content: string; sourceRefs: Array<{ type: string }> }>;
      executionConstraints: { teacherInterventionPresent: boolean };
    };
    expect(evidence.executionConstraints.teacherInterventionPresent).toBe(true);
    expect(evidence.teachingEvidence).toContainEqual(expect.objectContaining({
      kind: "teacher_judgment",
      content: "观察问题：后半节开始漏看题目条件；证据：老师当场提醒",
      sourceRefs: [expect.objectContaining({ type: "teacher-intervention" })],
    }));
  });

  it("stores and applies a student-specific generation plan while keeping the batch evidence shared", async () => {
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: classCode, name: "独立计划测试班" } });
    const students = await Promise.all([
      prisma.student.create({ data: { name: "公共配置学生", studentId: studentNumber, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } }),
      prisma.student.create({ data: { name: "独立配置学生", studentId: `${studentNumber}-OVERRIDE`, gender: "女", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } }),
    ]);
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await Promise.all(students.map((student) => prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: `${student.name}的已确认课堂事实`, rawText: "合成测试" } })));

    const plan = await createFeedbackPlan({
      type: "event_micro",
      outputRequirement: "测试事件反馈",
      semesterId: semester.id,
      classId: classRecord.id,
      sessionId: session.id,
      rangeEndSessionId: session.id,
      studentIds: students.map((student) => student.id),
      studentOverrides: [{
        studentId: students[1]!.id,
        generationConfig: {
          version: 1,
          type: "stage_trend",
          outputRequirement: "只写这位学生的阶段变化",
          generationPreferences: { closureType: "positive_recognition", moduleKeys: [] },
        },
      }],
    });
    const publicItem = plan.items.find((item) => item.studentId === students[0]!.id)!;
    const independentItem = plan.items.find((item) => item.studentId === students[1]!.id)!;
    expect(JSON.parse(publicItem.generationConfigSnapshot)).toEqual({});
    expect(JSON.parse(independentItem.generationConfigSnapshot)).toMatchObject({ type: "stage_trend", outputRequirement: "只写这位学生的阶段变化", generationPreferences: { moduleKeys: [] } });

    const rawView = await getFeedbackPlan(plan.id);
    const view = rawView ? toFeedbackPlanDetail(rawView) : null;
    const independentViewItem = view?.items.find((item) => item.id === independentItem.id) as { generationConfig?: unknown } | undefined;
    const publicViewItem = view?.items.find((item) => item.id === publicItem.id) as { generationConfig?: unknown } | undefined;
    expect(independentViewItem?.generationConfig).toMatchObject({ type: "stage_trend", outputRequirement: "只写这位学生的阶段变化" });
    expect(publicViewItem?.generationConfig).toBeNull();

    const calls: Array<{ planType: string; outputRequirement: string; moduleKeys: string[]; evidencePlanType: string }> = [];
    generationMocks.generate.mockImplementation(async (input: { planType: string; outputRequirement: string; generationPreferences?: { moduleKeys: string[] }; evidenceBundle: { planType: string; teachingEvidence: Array<{ id: string; content: string }> } }) => {
      calls.push({ planType: input.planType, outputRequirement: input.outputRequirement, moduleKeys: input.generationPreferences?.moduleKeys ?? [], evidencePlanType: input.evidenceBundle.planType });
      const first = input.evidenceBundle.teachingEvidence[0] ?? { id: "fallback", content: "课堂事实" };
      const modules = input.planType === "stage_trend"
        ? [{ key: "recent_trend", content: first.content, evidenceRefs: [first.id], status: "included" as const, reason: "独立计划" }]
        : [
          { key: "observed_moment", content: first.content, evidenceRefs: [first.id], status: "included" as const, reason: "公共计划" },
          { key: "teacher_interpretation", content: "本次表现比较稳定", evidenceRefs: [first.id], status: "included" as const, reason: "公共计划" },
        ];
      const composition = {
        version: 1 as const,
        closureType: "positive_recognition" as const,
        needParentAction: false,
        parentAction: null,
        modules,
        evidenceCoverage: [{ evidenceId: first.id, statement: first.content }],
        draftFeedback: first.content,
      };
      return { draftComposition: composition, composition };
    });
    await generateFeedbackPlanItems({ planId: plan.id });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ planType: "event_micro", outputRequirement: "测试事件反馈", moduleKeys: ["observed_moment", "teacher_interpretation"], evidencePlanType: "event_micro" }),
      expect.objectContaining({ planType: "stage_trend", outputRequirement: "只写这位学生的阶段变化", moduleKeys: [], evidencePlanType: "stage_trend" }),
    ]));

    const generation = await prisma.generationRecord.findFirst({ where: { feedbackPlanItemId: independentItem.id }, orderBy: { createdAt: "desc" } });
    expect(generation).not.toBeNull();
    expect(JSON.parse(generation?.inputSnapshot ?? "{}")).toMatchObject({ generationConfig: { type: "stage_trend", outputRequirement: "只写这位学生的阶段变化", generationPreferences: { moduleKeys: [] } } });
  });

  it("can set, clear, and protect a student-specific plan configuration", async () => {
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: classCode, name: "独立计划修改测试班" } });
    const student = await prisma.student.create({ data: { name: "配置修改学生", studentId: studentNumber, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "配置修改的已确认事实", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const item = plan.items[0]!;

    const configured = await patchFeedbackPlanItem(item.id, {
      expectedItemRevision: item.itemRevision,
      generationConfig: {
        version: 1,
        type: "course_end",
        outputRequirement: "只保留结课阶段中的关键断点",
        generationPreferences: { closureType: "positive_recognition", moduleKeys: ["remaining_gap"] },
      },
    });
    expect(configured).toMatchObject({ status: "evidence_ready", finalText: null, reviewMode: "model" });
    expect(JSON.parse(configured.generationConfigSnapshot)).toMatchObject({ type: "course_end" });

    const restored = await patchFeedbackPlanItem(configured.id, { expectedItemRevision: configured.itemRevision, generationConfig: null });
    expect(restored).toMatchObject({ status: "evidence_ready", finalText: null, reviewMode: "model", generationConfigSnapshot: "{}" });

    await prisma.feedbackPlanItem.update({ where: { id: item.id }, data: { status: "generating" } });
    await expect(patchFeedbackPlanItem(item.id, { generationConfig: configured.generationConfigSnapshot ? JSON.parse(configured.generationConfigSnapshot) : null })).rejects.toThrow("反馈正在生成");
  });

  it("stores versioned course material and history evidence, filters by student/date, and archives drafts", async () => {
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: classCode, name: "FeedbackPlan 历史测试班" } });
    const student = await prisma.student.create({ data: { name: "历史测试学生", studentId: studentNumber, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.sessionMetric.create({ data: { studentId: student.id, sessionId: session.id, date: session.date, scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 2, operator: "teacher" } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "历史测试课堂事实", rawText: "合成测试" } });
    const lessonMaterial = {
      version: 1 as const,
      sessionCode: session.code,
      groupFeedbackRaw: "群反馈《氧化还原》",
      assessmentBriefRaw: "统一测评说明",
      lessonTitle: "氧化还原",
      classroomContent: ["电子转移"],
      classroomFocus: ["判断依据"],
      classroomExplanation: [],
      homework: ["完成订正"],
      assessmentFocus: ["氧化数"],
      correctionAdvice: ["标出依据"],
      otherNotes: [],
    };
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id], lessonMaterial });
    const inputSnapshot = JSON.parse(plan.inputSnapshot) as { version: number; sessionCode?: string; lessonMaterial: typeof lessonMaterial };
    const evidence = JSON.parse(plan.items[0]!.evidenceSnapshot) as { version: number; teachingBackground: string[]; historySnapshot: { current: { sessionId: string; scoreD: number | null } | null; recent: unknown[] } };
    expect(inputSnapshot).toMatchObject({ version: 1, semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, sessionCode: session.code, sourceFingerprint: expect.any(String), lessonMaterial: { lessonTitle: "氧化还原" } });
    expect(evidence).toMatchObject({ version: 2, teachingBackground: expect.arrayContaining(["课程标题：氧化还原"]), historySnapshot: { current: { sessionId: session.id, scoreD: 2 } } });

    const publicPlan = await createFeedbackPlan({ type: "class_update", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, lessonMaterial });
    const studentPlans = await listFeedbackPlans({ semesterId: semester.id, classId: classRecord.id, studentId: student.id, date: session.date });
    expect(studentPlans.map((item) => item.id)).toContain(plan.id);
    expect(studentPlans.map((item) => item.id)).not.toContain(publicPlan.id);

    await archiveFeedbackPlan(plan.id);
    expect((await listFeedbackPlans({ semesterId: semester.id, archived: false })).map((item) => item.id)).not.toContain(plan.id);
    expect((await listFeedbackPlans({ semesterId: semester.id, archived: true })).map((item) => item.id)).toContain(plan.id);
    await expect(patchFeedbackPlanItem(plan.items[0]!.id, { finalText: "归档后不应写入" })).rejects.toThrow("已归档反馈计划为只读");
    await expect(approveFeedbackPlanItems({ planId: plan.id, itemIds: [plan.items[0]!.id], expectedHashes: {} })).rejects.toThrow("已归档反馈计划为只读");
    await expect(startFeedbackPlanGeneration({ planId: plan.id })).rejects.toThrow("已归档反馈计划不能继续生成");
    await expect(addFeedbackAttachment({ planId: plan.id, planItemId: plan.items[0]!.id, fileName: "archived.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("blocked") })).rejects.toThrow("已归档反馈计划为只读");
    await unarchiveFeedbackPlan(plan.id);
    await deleteFeedbackPlan(plan.id);
    const auditRecord = await prisma.generationRecord.create({
      data: {
        taskType: "feedback",
        stage: "plan-review",
        sourceRefs: "[]",
        sourceFingerprint: "synthetic-delete-guard",
        promptVersion: "test-v1",
        modelName: "test-model",
        modelSettings: "{}",
        feedbackPlanItemId: publicPlan.items[0]!.id,
      },
    });
    await expect(deleteFeedbackPlan(publicPlan.id)).rejects.toThrow("只能归档，不能删除");
    await prisma.generationRecord.delete({ where: { id: auditRecord.id } });
    await deleteFeedbackPlan(publicPlan.id);
    expect(await getFeedbackPlan(plan.id)).toBeNull();
  });

  it("keeps generated text when a communication preference is confirmed and can recover legacy stale text without a model call", async () => {
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: classCode, name: "偏好确认测试班" } });
    const student = await prisma.student.create({ data: { name: "测试学生", studentId: studentNumber, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "课堂能独立完成练习", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const item = await patchFeedbackPlanItem(plan.items[0]!.id, {
      composition: { version: 1, closureType: "positive_recognition", needParentAction: false, parentAction: null, modules: [
        { key: "observed_moment", content: "课堂能独立完成练习", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
        { key: "teacher_interpretation", content: "本节内容已经基本消化", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
      ], evidenceCoverage: [{ evidenceId: "current-event-0", statement: "课堂能独立完成练习" }], draftFeedback: "课堂能独立完成练习，本节内容已经基本消化。" },
      finalText: "课堂能独立完成练习，本节内容已经基本消化。",
    });
    const candidate = await createPreferenceCandidate({
      studentId: student.id,
      sourceType: "teacher",
      preference: { version: 1, length: "detailed", deliveryChannel: "text", phoneContact: "accepted", evidence: "unknown", terminology: "unknown", familyParticipation: "unknown", frequency: "every_session" },
      evidence: { source: "teacher_manual" },
    });

    await resolvePreferenceCandidate(candidate.id, "confirmed");
    let refreshed = await getFeedbackPlan(plan.id);
    expect(refreshed!.items[0]).toMatchObject({ status: "needs_review", finalText: item.finalText });

    await prisma.feedbackPlanItem.update({ where: { id: item.id }, data: { status: "stale" } });
    await prisma.feedbackPlan.update({ where: { id: plan.id }, data: { status: "stale" } });
    await retainStaleFeedbackPlanItems({ planId: plan.id, itemIds: [item.id] });
    refreshed = await getFeedbackPlan(plan.id);
    expect(refreshed!.items[0]).toMatchObject({ status: "needs_review", reviewMode: "teacher_edited", finalText: item.finalText });
    expect(refreshed!.status).toBe("in_review");
    expect(generationMocks.generate).not.toHaveBeenCalled();
  });

  it("keeps teacher-edited final text through approval and plan export", async () => {
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: classCode, name: "计划测试班" } });
    const student = await prisma.student.create({ data: { name: "测试学生", studentId: studentNumber, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.sessionMetric.create({ data: { studentId: student.id, sessionId: session.id, date: session.date, scoreA: 4, scoreB: 4, scoreC: 3, scoreD: 5, operator: "teacher" } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "第二道同类题能够独立完成", rawText: "测试课堂记录" } });

    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    expect(plan.items[0]?.student).toMatchObject({ id: student.id, name: "测试学生" });
    const item = plan.items[0]!;
    const patched = await patchFeedbackPlanItem(item.id, {
      composition: {
        version: 1,
        closureType: "informational",
        needParentAction: false,
        parentAction: null,
        modules: [
          { key: "observed_moment", content: "第二道同类题能够独立完成", evidenceRefs: ["current-event-0"], status: "included", reason: "课堂片段" },
          { key: "teacher_interpretation", content: "学习测验4分，课堂状态4分，方法正在稳定", evidenceRefs: ["current-event-0", "current-score-a", "current-score-b"], status: "included", reason: "教师判断" },
        ],
        evidenceCoverage: [
          { evidenceId: "current-event-0", statement: "第二道同类题能够独立完成" },
          { evidenceId: "current-score-a", statement: "学习测验4分" },
          { evidenceId: "current-score-b", statement: "课堂状态4分" },
        ],
        draftFeedback: "教师修改后的事件反馈：第二道同类题能够独立完成，学习测验4分，课堂状态4分。",
      },
      finalText: "教师修改后的事件反馈：第二道同类题能够独立完成，学习测验4分，课堂状态4分。",
      reviewMode: "teacher_edited",
    });
    expect(patched.status).toBe("needs_review");
    await approveFeedbackPlanItems({ planId: plan.id, itemIds: [item.id], expectedHashes: { [item.id]: patched.finalTextHash! } });
    await expect(patchFeedbackPlanItem(item.id, { finalText: "不应覆盖已批准文本", expectedItemRevision: patched.itemRevision })).rejects.toThrow("已批准或已导出的反馈不可原位修改");
    await expect(deleteFeedbackPlan(plan.id)).rejects.toThrow("只能归档，不能删除");
    await expect(generateFeedbackPlanItems({ planId: plan.id })).rejects.toThrow("已批准、已导出或教师已修改的反馈不能被批量覆盖");
    expect((await getFeedbackPlan(plan.id))!.items[0]!.status).toBe("approved");
    const workbook = await buildFeedbackPlanExportWorkbook(prisma, plan.id, "complete");
    const parsed = XLSX.read(workbook, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(parsed.Sheets["课后反馈"]!, { defval: "" });
    expect(rows[0]).toMatchObject({ 姓名: "测试学生", 最终反馈: "教师修改后的事件反馈：第二道同类题能够独立完成，学习测验4分，课堂状态4分。" });
    await expect(buildFeedbackPlanExportWorkbook(prisma, plan.id, "complete")).rejects.toThrow("已经按相同文本导出过");
    await buildFeedbackPlanExportWorkbook(prisma, plan.id, "complete", { allowRepeat: true });
    const exportRuns = await prisma.feedbackExportRun.findMany({ where: { planId: plan.id }, orderBy: { createdAt: "asc" } });
    expect(exportRuns.map((run) => run.isRepeat)).toEqual([false, true]);
    expect(JSON.parse(exportRuns[0]!.itemManifest)[0]).toEqual({ itemId: item.id, finalTextHash: patched.finalTextHash });
  });

  it("exports a stable no-send WCG package from teacher-approved personal feedback", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-WCG`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-WCG`, name: "企微草稿测试班" } });
    const student = await prisma.student.create({ data: { name: "张三", studentId: `${studentNumber}-WCG`, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-WCG`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "合成课堂证据", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const item = plan.items[0]!;
    const patched = await patchFeedbackPlanItem(item.id, {
      composition: { version: 1, closureType: "positive_recognition", needParentAction: false, parentAction: null, modules: [
        { key: "observed_moment", content: "合成课堂证据", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
        { key: "teacher_interpretation", content: "方法逐步稳定", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
      ], evidenceCoverage: [{ evidenceId: "current-event-0", statement: "合成课堂证据" }], draftFeedback: "模型草稿不应导出" },
      finalText: "  教师最终确认文本。  ",
      reviewMode: "teacher_edited",
    });
    await approveFeedbackPlanItems({ planId: plan.id, itemIds: [item.id], expectedHashes: { [item.id]: patched.finalTextHash! } });

    const first = await buildWeComDraftPackage(prisma, plan.id);
    const second = await buildWeComDraftPackage(prisma, plan.id);
    expect(first.packageId).toBe(second.packageId);
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(first.items).toEqual([expect.objectContaining({
      itemId: item.id,
      studentRef: { id: student.id, businessId: `${studentNumber}-WCG`, displayName: "张三" },
      text: "教师最终确认文本。",
    })]);
    expect(first).not.toHaveProperty("messageSent");
  });

  it("uses the selected stage range and assigns follow-up tasks to the next class session", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-RANGE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-RANGE`, name: "阶段范围测试班" } });
    const student = await prisma.student.create({ data: { name: "阶段测试学生", studentId: `${studentNumber}-RANGE`, gender: "女", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const sessions = [];
    for (const [index, code] of rangeSessionCodes.entries()) {
      sessions.push(await prisma.classSession.create({
        data: { code, semesterId: semester.id, semesterNumber: index + 1, date: `2099-01-0${index + 1}`, classId: classRecord.id },
      }));
    }
    for (const [index, session] of sessions.entries()) {
      await prisma.sessionMetric.create({ data: { studentId: student.id, sessionId: session.id, date: session.date, scoreA: index + 1, scoreB: 3, scoreC: 3, scoreD: 3, operator: "teacher" } });
    }
    const firstEvent = await prisma.event.create({ data: { studentId: student.id, sessionId: sessions[0]!.id, type: "课堂表现", description: "阶段起点需要提示", rawText: "阶段测试" } });
    await prisma.communication.create({ data: { studentId: student.id, sessionId: sessions[0]!.id, target: "母亲", summary: "家长希望了解阶段学习进步" } });
    await prisma.communication.create({ data: { studentId: student.id, sessionId: sessions[3]!.id, target: "母亲", summary: "范围外沟通不应进入本次学习反馈" } });

    const plan = await createFeedbackPlan({
      type: "stage_trend",
      outputRequirement: "测试阶段范围",
      semesterId: semester.id,
      classId: classRecord.id,
      sessionId: sessions[2]!.id,
      rangeStartSessionId: sessions[0]!.id,
      rangeEndSessionId: sessions[2]!.id,
      studentIds: [student.id],
    });
    expect(plan.rangeStartSessionId).toBe(sessions[0]!.id);
    expect(plan.rangeEndSessionId).toBe(sessions[2]!.id);
    const evidence = JSON.parse(plan.items[0]!.evidenceSnapshot) as { teachingEvidence: Array<{ sourceRefs: Array<{ id: string }> }>; communicationContext: Array<{ content: string }>; historySnapshot: { current: { sessionId: string }; previous: { sessionId: string } | null; recent: Array<{ sessionId: string }> ; semesterAverage: { A: number | null } } };
    expect(evidence.teachingEvidence.some((entry) => entry.sourceRefs.some((ref) => ref.id === firstEvent.id))).toBe(true);
    expect(evidence.communicationContext.map((entry) => entry.content).join(" ")).toContain("阶段学习进步");
    expect(evidence.communicationContext.map((entry) => entry.content).join(" ")).not.toContain("范围外沟通");
    expect(evidence.historySnapshot.current.sessionId).toBe(sessions[2]!.id);
    expect(evidence.historySnapshot.previous?.sessionId).not.toBe(sessions[2]!.id);
    expect(new Set([evidence.historySnapshot.current, ...evidence.historySnapshot.recent].map((metric) => metric.sessionId)).size).toBe(evidence.historySnapshot.recent.length + 1);
    expect(evidence.historySnapshot.semesterAverage.A).toBe(2);

    await prisma.feedbackPlan.update({ where: { id: plan.id }, data: { sessionId: sessions[0]!.id } });
    expect((await listFeedbackPlans({ sessionId: sessions[2]!.id })).map((item) => item.id)).toContain(plan.id);
    expect((await listFeedbackPlans({ date: sessions[2]!.date })).map((item) => item.id)).toContain(plan.id);
    expect((await listFeedbackPlans({ sessionId: sessions[0]!.id })).map((item) => item.id)).not.toContain(plan.id);
    expect((await listFeedbackPlans({ date: sessions[0]!.date })).map((item) => item.id)).not.toContain(plan.id);

    await prisma.feedbackPlanItem.update({ where: { id: plan.items[0]!.id }, data: { status: "needs_review" } });
    const task = await createTeacherTask({ planItemId: plan.items[0]!.id, action: "下次课复查阶段问题", dueType: "session" });
    expect(task.dueSessionId).toBe(sessions[3]!.id);
  });

  it("rebases stale evidence before generation and preserves the current student identity", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-STALE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-STALE`, name: "失效证据测试班" } });
    const student = await prisma.student.create({ data: { name: "失效测试学生", studentId: `${studentNumber}-STALE`, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-STALE`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.sessionMetric.create({ data: { studentId: student.id, sessionId: session.id, date: session.date, scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 5, operator: "teacher" } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "第一道题需要提醒", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const oldFingerprint = JSON.parse(plan.items[0]!.evidenceSnapshot).sourceFingerprint as string;
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "第三道同类题已经独立完成", rawText: "合成测试" } });
    await invalidateFeedbackPlans({ sessionId: session.id, studentIds: [student.id] });
    generationMocks.generate.mockImplementation(async ({ evidenceBundle }: { evidenceBundle: { teachingEvidence: Array<{ id: string; content: string }> } }) => {
      const [first, ...remaining] = evidenceBundle.teachingEvidence;
      const modules = [
        { key: "observed_moment", content: first!.content, evidenceRefs: [first!.id], status: "included" as const, reason: "合成测试" },
        { key: "teacher_interpretation", content: remaining.map((entry) => entry.content).join("；"), evidenceRefs: remaining.map((entry) => entry.id), status: "included" as const, reason: "合成测试" },
      ];
      const composition = {
        version: 1 as const,
        closureType: "positive_recognition" as const,
        needParentAction: false,
        parentAction: null,
        modules,
        evidenceCoverage: evidenceBundle.teachingEvidence.map((entry) => ({ evidenceId: entry.id, statement: entry.content })),
        draftFeedback: evidenceBundle.teachingEvidence.map((entry) => entry.content).join("；"),
      };
      return { draftComposition: composition, composition };
    });

    await generateFeedbackPlanItems({ planId: plan.id });
    const refreshed = await getFeedbackPlan(plan.id);
    const evidence = JSON.parse(refreshed!.items[0]!.evidenceSnapshot) as { sourceFingerprint: string; teachingEvidence: Array<{ content: string }> };
    expect(evidence.sourceFingerprint).not.toBe(oldFingerprint);
    expect(evidence.teachingEvidence.map((entry) => entry.content).join(" ")).toContain("第三道同类题已经独立完成");
    expect(refreshed!.items[0]).toMatchObject({ status: "needs_review", student: { id: student.id, name: "失效测试学生" } });
  });

  it("persists PDF and classroom-practice evidence and reuses it on regeneration", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-ASSESSMENT`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-ASSESSMENT`, name: "测评证据测试班" } });
    const student = await prisma.student.create({ data: { name: "测评测试学生", studentId: `${studentNumber}-ASSESSMENT`, gender: "女", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-ASSESSMENT`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "课堂练习时能写出判断依据", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const baseEvidence = {
      sessionCode: session.code,
      studentId: student.id,
      reportDate: session.date,
      totalQuestions: 2,
      cohortAverageRate: 75,
      knowledgePoints: [{ name: "离子判断", questionCount: 2, correctRate: 50, cohortAverageRate: 75 }],
      wrongItems: [{ questionNumber: "2", studentAnswer: "A", correctAnswer: "B", knowledgePoints: ["离子判断"] }],
      similarPracticeCount: 1,
    };
    const assessmentEvidence = {
      [student.id]: [
        { ...baseEvidence, sourceType: "assessment_pdf" as const, reportTitle: "出门测", correctRate: 50 },
        { ...baseEvidence, sourceType: "classroom_practice" as const, reportTitle: "课堂练习", correctRate: 50 },
      ],
    };
    generationMocks.generate.mockImplementation(async ({ evidenceBundle }: { evidenceBundle: { teachingEvidence: Array<{ id: string; content: string }>; assessmentEvidence: Array<{ id: string; content: string; sourceRefs: Array<{ type: string }> }> } }) => {
      expect(evidenceBundle.assessmentEvidence.map((entry) => entry.sourceRefs[0]?.type)).toEqual(["assessment-pdf", "classroom-practice"]);
      const allEvidence = evidenceBundle.teachingEvidence.concat(evidenceBundle.assessmentEvidence);
      const composition = {
        version: 1 as const,
        closureType: "positive_recognition" as const,
        needParentAction: false,
        parentAction: null,
        modules: [
          { key: "observed_moment", content: "课堂练习时能写出判断依据", evidenceRefs: [evidenceBundle.teachingEvidence[0]!.id], status: "included" as const, reason: "课堂证据" },
          { key: "teacher_interpretation", content: "本次离子判断仍需订正", evidenceRefs: evidenceBundle.assessmentEvidence.map((entry) => entry.id), status: "included" as const, reason: "测评证据" },
        ],
        evidenceCoverage: allEvidence.map((entry) => ({ evidenceId: entry.id, statement: entry.content })),
        draftFeedback: allEvidence.map((entry) => entry.content).join("；"),
      };
      return { draftComposition: composition, composition };
    });

    await startFeedbackPlanGeneration({ planId: plan.id, assessmentEvidence });
    await vi.waitFor(async () => expect((await getFeedbackPlan(plan.id))?.status).toBe("in_review"));
    let refreshed = await getFeedbackPlan(plan.id);
    expect(JSON.parse(refreshed!.items[0]!.evidenceSnapshot).assessmentEvidence).toHaveLength(2);

    await generateFeedbackPlanItems({ planId: plan.id });
    refreshed = await getFeedbackPlan(plan.id);
    expect(JSON.parse(refreshed!.items[0]!.evidenceSnapshot).assessmentEvidence).toHaveLength(2);
    expect(generationMocks.generate).toHaveBeenCalledTimes(2);
  });

  it("limits generation to two active items and continues only queued items after pause", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-QUEUE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-QUEUE`, name: "队列并发测试班" } });
    const students = await Promise.all([1, 2, 3].map((index) => prisma.student.create({
      data: { name: `队列学生${index}`, studentId: `${studentNumber}-QUEUE-${index}`, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } },
    })));
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-QUEUE`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await Promise.all(students.map((student) => prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: `${student.name}课堂事实`, rawText: "合成测试" } })));
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试队列生成", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: students.map((student) => student.id) });
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const compositionFor = (evidenceBundle: { teachingEvidence: Array<{ id: string; content: string }> }) => {
      const first = evidenceBundle.teachingEvidence[0] ?? { id: "fallback-evidence", content: "课堂事实" };
      const composition = {
        version: 1 as const,
        closureType: "positive_recognition" as const,
        needParentAction: false,
        parentAction: null,
        modules: [
          { key: "observed_moment", content: first.content, evidenceRefs: [first.id], status: "included" as const, reason: "队列测试" },
          { key: "teacher_interpretation", content: "表现稳定", evidenceRefs: [first.id], status: "included" as const, reason: "队列测试" },
        ],
        evidenceCoverage: [{ evidenceId: first.id, statement: first.content }],
        draftFeedback: `${first.content}，表现稳定。`,
      };
      return { draftComposition: composition, composition };
    };
    generationMocks.generate.mockImplementation(async ({ evidenceBundle }: { evidenceBundle: { teachingEvidence: Array<{ id: string; content: string }> } }) => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return compositionFor(evidenceBundle);
    });

    await startFeedbackPlanGeneration({ planId: plan.id, generationMode: "fast" });
    await vi.waitFor(() => expect(started).toBe(2));
    expect(maximumActive).toBe(2);
    await expect(pauseFeedbackPlanGeneration(plan.id)).resolves.toMatchObject({ status: "pause_requested" });
    while (releases.length) releases.shift()!();
    await vi.waitFor(async () => expect((await getFeedbackPlan(plan.id))?.status).toBe("paused"));
    const paused = await getFeedbackPlan(plan.id);
    expect(paused?.generationMode).toBe("fast");
    expect(paused?.generationStartedAt).toBeInstanceOf(Date);
    expect(paused?.generationRunStartedAt).toBeNull();
    expect(paused?.generationElapsedMs).toBeGreaterThanOrEqual(0);
    expect(paused?.items.filter((item) => item.status === "queued")).toHaveLength(1);
    expect(paused?.items.filter((item) => item.status === "needs_review")).toHaveLength(2);
    expect(paused?.items.filter((item) => item.status === "needs_review").every((item) => typeof item.generationDurationMs === "number")).toBe(true);

    generationMocks.generate.mockImplementation(async ({ evidenceBundle }: { evidenceBundle: { teachingEvidence: Array<{ id: string; content: string }> } }) => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const result = compositionFor(evidenceBundle);
      active -= 1;
      return result;
    });
    await prisma.feedbackPlan.update({ where: { id: plan.id }, data: { generationStartedAt: null } });
    await continueFeedbackPlanGeneration(plan.id);
    await vi.waitFor(async () => expect((await getFeedbackPlan(plan.id))?.status).toBe("in_review"));
    const continued = await getFeedbackPlan(plan.id);
    expect(started).toBe(3);
    expect(maximumActive).toBe(2);
    expect(continued?.items.every((item) => item.status === "needs_review")).toBe(true);
    expect(continued?.generationCompletedAt).toBeInstanceOf(Date);
    expect(continued?.generationStartedAt).toBeInstanceOf(Date);
    expect(continued?.generationRunStartedAt).toBeNull();
    expect(continued?.items.every((item) => item.generationCompletedAt instanceof Date)).toBe(true);
    expect(generationMocks.generate).toHaveBeenCalledWith(expect.objectContaining({ generationMode: "fast" }));
  });

  it("keeps the previous reviewable text when regeneration fails", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-FAIL`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-FAIL`, name: "生成失败测试班" } });
    const student = await prisma.student.create({ data: { name: "生成失败学生", studentId: `${studentNumber}-FAIL`, gender: "女", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-FAIL`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "已确认课堂表现", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const patched = await patchFeedbackPlanItem(plan.items[0]!.id, {
      composition: { version: 1, closureType: "positive_recognition", needParentAction: false, parentAction: null, modules: [
        { key: "observed_moment", content: "已确认课堂表现", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
        { key: "teacher_interpretation", content: "表现较稳定", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
      ], evidenceCoverage: [{ evidenceId: "current-event-0", statement: "已确认课堂表现" }], draftFeedback: "已确认课堂表现；原有待审核文本。" },
      finalText: "已确认课堂表现；原有待审核文本。",
      reviewMode: "teacher_edited",
    });
    await prisma.feedbackPlanItem.update({ where: { id: plan.items[0]!.id }, data: { reviewMode: "model" } });
    generationMocks.generate.mockRejectedValueOnce(new Error("合成模型失败"));

    const progress: Array<{ status?: string; error?: string }> = [];
    await expect(generateFeedbackPlanItems({ planId: plan.id, onProgress: (event) => { progress.push(event); } })).resolves.toEqual([]);
    const restored = await getFeedbackPlan(plan.id);
    expect(restored!.items[0]).toMatchObject({ status: "generation_failed", finalText: "已确认课堂表现；原有待审核文本。", finalTextHash: patched.finalTextHash, generationError: "本条反馈生成失败，可单独重试" });
    expect(progress).toContainEqual(expect.objectContaining({ status: "error", error: "本条反馈生成失败，可单独重试" }));
  });

  it("allows an inactive student to be explicitly included with historical evidence", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-INACTIVE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-INACTIVE`, name: "停读学生测试班" } });
    const student = await prisma.student.create({ data: { name: "停读测试学生", studentId: `${studentNumber}-INACTIVE`, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id, rosterStatus: "INACTIVE" } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-INACTIVE`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    const event = await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "历史范围内的已确认记录", rawText: "合成测试" } });

    const plan = await createFeedbackPlan({ type: "course_end", outputRequirement: "测试阶段范围", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeStartSessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const evidence = JSON.parse(plan.items[0]!.evidenceSnapshot) as { sourceRefs: Array<{ id: string }> };
    expect(plan.items[0]?.student).toMatchObject({ id: student.id });
    expect(evidence.sourceRefs.some((ref) => ref.id === event.id)).toBe(true);
  });

  it("removes a managed attachment without leaving a database row or private file", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-ATTACHMENT`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-ATTACHMENT`, name: "附件测试班" } });
    const student = await prisma.student.create({ data: { name: "附件测试学生", studentId: `${studentNumber}-ATTACHMENT`, gender: "女", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-ATTACHMENT`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "附件测试记录", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", outputRequirement: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "student-track-feedback-attachment-test-"));
    attachmentRoots.push(root);
    process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT = root;
    const attachment = await addFeedbackAttachment({ planId: plan.id, planItemId: plan.items[0]!.id, fileName: "test-note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("synthetic attachment") });
    const storedPath = path.join(root, plan.id, path.basename(attachment.relativeLocator));
    await expect(fs.stat(storedPath)).resolves.toMatchObject({ size: 20 });

    await removeFeedbackAttachment({ planId: plan.id, attachmentId: attachment.id });
    await expect(fs.stat(storedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await prisma.feedbackAttachment.findUnique({ where: { id: attachment.id } })).toBeNull();
  });
});
