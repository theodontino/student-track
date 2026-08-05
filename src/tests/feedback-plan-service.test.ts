import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { addFeedbackAttachment, approveFeedbackPlanItems, createFeedbackPlan, createPreferenceCandidate, createTeacherTask, generateFeedbackPlanItems, getFeedbackPlan, invalidateFeedbackPlans, patchFeedbackPlanItem, removeFeedbackAttachment, resolvePreferenceCandidate, retainStaleFeedbackPlanItems } from "@/services/feedback-plan-service";
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
  await prisma.feedbackPlan.deleteMany({ where: { purpose: "测试事件反馈" } });
  await prisma.feedbackPlan.deleteMany({ where: { purpose: "测试阶段范围" } });
  await prisma.classSession.deleteMany({ where: { code: sessionCode } });
  await prisma.classSession.deleteMany({ where: { code: `${sessionCode}-WCG` } });
  await prisma.classSession.deleteMany({ where: { code: { in: rangeSessionCodes } } });
  await prisma.student.deleteMany({ where: { studentId: `${studentNumber}-RANGE` } });
  await prisma.student.deleteMany({ where: { studentId: studentNumber } });
  await prisma.student.deleteMany({ where: { studentId: `${studentNumber}-WCG` } });
  await prisma.class.deleteMany({ where: { code: `${classCode}-RANGE` } });
  await prisma.class.deleteMany({ where: { code: classCode } });
  await prisma.class.deleteMany({ where: { code: `${classCode}-WCG` } });
  await prisma.semester.deleteMany({ where: { name: `${semesterName}-RANGE` } });
  await prisma.semester.deleteMany({ where: { name: semesterName } });
  await prisma.semester.deleteMany({ where: { name: `${semesterName}-WCG` } });
});

describe("feedback plan service", () => {
  it("keeps generated text when a communication preference is confirmed and can recover legacy stale text without a model call", async () => {
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: classCode, name: "偏好确认测试班" } });
    const student = await prisma.student.create({ data: { name: "测试学生", studentId: studentNumber, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "课堂能独立完成练习", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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

    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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
      purpose: "测试阶段范围",
      semesterId: semester.id,
      classId: classRecord.id,
      sessionId: sessions[2]!.id,
      rangeStartSessionId: sessions[0]!.id,
      rangeEndSessionId: sessions[2]!.id,
      studentIds: [student.id],
    });
    expect(plan.rangeStartSessionId).toBe(sessions[0]!.id);
    expect(plan.rangeEndSessionId).toBe(sessions[2]!.id);
    const evidence = JSON.parse(plan.items[0]!.evidenceSnapshot) as { teachingEvidence: Array<{ sourceRefs: Array<{ id: string }> }>; communicationContext: Array<{ content: string }> };
    expect(evidence.teachingEvidence.some((entry) => entry.sourceRefs.some((ref) => ref.id === firstEvent.id))).toBe(true);
    expect(evidence.communicationContext.map((entry) => entry.content).join(" ")).toContain("阶段学习进步");
    expect(evidence.communicationContext.map((entry) => entry.content).join(" ")).not.toContain("范围外沟通");

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
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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

    await generateFeedbackPlanItems({ planId: plan.id, assessmentEvidence });
    let refreshed = await getFeedbackPlan(plan.id);
    expect(JSON.parse(refreshed!.items[0]!.evidenceSnapshot).assessmentEvidence).toHaveLength(2);

    await generateFeedbackPlanItems({ planId: plan.id });
    refreshed = await getFeedbackPlan(plan.id);
    expect(JSON.parse(refreshed!.items[0]!.evidenceSnapshot).assessmentEvidence).toHaveLength(2);
    expect(generationMocks.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous reviewable text when regeneration fails", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-FAIL`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-FAIL`, name: "生成失败测试班" } });
    const student = await prisma.student.create({ data: { name: "生成失败学生", studentId: `${studentNumber}-FAIL`, gender: "女", enrollments: { create: { semesterId: semester.id, classId: classRecord.id } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-FAIL`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "已确认课堂表现", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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
    expect(restored!.items[0]).toMatchObject({ status: "needs_review", finalText: "已确认课堂表现；原有待审核文本。", finalTextHash: patched.finalTextHash });
    expect(progress).toContainEqual(expect.objectContaining({ status: "error", error: "本条反馈生成失败，已保留原版本，可单独重试" }));
  });

  it("allows an inactive student to be explicitly included with historical evidence", async () => {
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-INACTIVE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const classRecord = await prisma.class.create({ data: { semesterId: semester.id, code: `${classCode}-INACTIVE`, name: "停读学生测试班" } });
    const student = await prisma.student.create({ data: { name: "停读测试学生", studentId: `${studentNumber}-INACTIVE`, gender: "男", enrollments: { create: { semesterId: semester.id, classId: classRecord.id, rosterStatus: "INACTIVE" } } } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-INACTIVE`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    const event = await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "历史范围内的已确认记录", rawText: "合成测试" } });

    const plan = await createFeedbackPlan({ type: "course_end", purpose: "测试阶段范围", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeStartSessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
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
