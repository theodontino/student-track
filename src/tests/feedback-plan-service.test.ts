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
import { addFeedbackAttachment, approveFeedbackPlanItems, createFeedbackPlan, createTeacherTask, generateFeedbackPlanItems, getFeedbackPlan, invalidateFeedbackPlans, patchFeedbackPlanItem, removeFeedbackAttachment } from "@/services/feedback-plan-service";
import { buildFeedbackPlanExportWorkbook } from "@/services/feedback-export-service";

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
  await prisma.classSession.deleteMany({ where: { code: { in: rangeSessionCodes } } });
  await prisma.student.deleteMany({ where: { studentId: `${studentNumber}-RANGE` } });
  await prisma.student.deleteMany({ where: { studentId: studentNumber } });
  await prisma.semester.deleteMany({ where: { name: `${semesterName}-RANGE` } });
  await prisma.semester.deleteMany({ where: { name: semesterName } });
  await prisma.class.deleteMany({ where: { code: `${classCode}-RANGE` } });
  await prisma.class.deleteMany({ where: { code: classCode } });
});

describe("feedback plan service", () => {
  it("keeps teacher-edited final text through approval and plan export", async () => {
    const classRecord = await prisma.class.create({ data: { code: classCode, name: "计划测试班" } });
    const semester = await prisma.semester.create({ data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const student = await prisma.student.create({ data: { name: "测试学生", studentId: studentNumber, gender: "男", classId: classRecord.id } });
    const session = await prisma.classSession.create({ data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.sessionMetric.create({ data: { studentId: student.id, sessionId: session.id, date: session.date, scoreA: 4, scoreB: 4, scoreC: 3, scoreD: 5, operator: "teacher" } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "第二道同类题能够独立完成", rawText: "测试课堂记录" } });

    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    expect(plan.items[0]?.student).toMatchObject({ id: student.id, name: "测试学生" });
    const item = plan.items[0]!;
    const patched = await patchFeedbackPlanItem(item.id, {
      composition: {
        version: 1,
        closureType: "positive_recognition",
        needParentAction: false,
        parentAction: null,
        modules: [
          { key: "observed_moment", content: "第二道同类题能够独立完成", evidenceRefs: ["current-event-0"], status: "included", reason: "课堂片段" },
          { key: "teacher_interpretation", content: "方法正在稳定", evidenceRefs: ["current-event-0"], status: "included", reason: "教师判断" },
        ],
        draftFeedback: "教师修改后的事件反馈。",
      },
      finalText: "教师修改后的事件反馈。",
      reviewMode: "teacher_edited",
    });
    expect(patched.status).toBe("needs_review");
    await approveFeedbackPlanItems({ planId: plan.id, itemIds: [item.id], expectedHashes: { [item.id]: patched.finalTextHash! } });
    await expect(generateFeedbackPlanItems({ planId: plan.id })).rejects.toThrow("已批准、已导出或教师已修改的反馈不能被批量覆盖");
    expect((await getFeedbackPlan(plan.id))!.items[0]!.status).toBe("approved");
    const workbook = await buildFeedbackPlanExportWorkbook(prisma, plan.id, "complete");
    const parsed = XLSX.read(workbook, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(parsed.Sheets["课后反馈"]!, { defval: "" });
    expect(rows[0]).toMatchObject({ 姓名: "测试学生", 最终反馈: "教师修改后的事件反馈。" });
    await expect(buildFeedbackPlanExportWorkbook(prisma, plan.id, "complete")).rejects.toThrow("已经按相同文本导出过");
    await buildFeedbackPlanExportWorkbook(prisma, plan.id, "complete", { allowRepeat: true });
    const exportRuns = await prisma.feedbackExportRun.findMany({ where: { planId: plan.id }, orderBy: { createdAt: "asc" } });
    expect(exportRuns.map((run) => run.isRepeat)).toEqual([false, true]);
    expect(JSON.parse(exportRuns[0]!.itemManifest)[0]).toEqual({ itemId: item.id, finalTextHash: patched.finalTextHash });
  });

  it("uses the selected stage range and assigns follow-up tasks to the next class session", async () => {
    const classRecord = await prisma.class.create({ data: { code: `${classCode}-RANGE`, name: "阶段范围测试班" } });
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-RANGE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const student = await prisma.student.create({ data: { name: "阶段测试学生", studentId: `${studentNumber}-RANGE`, gender: "女", classId: classRecord.id } });
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
    const classRecord = await prisma.class.create({ data: { code: `${classCode}-STALE`, name: "失效证据测试班" } });
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-STALE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const student = await prisma.student.create({ data: { name: "失效测试学生", studentId: `${studentNumber}-STALE`, gender: "男", classId: classRecord.id } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-STALE`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.sessionMetric.create({ data: { studentId: student.id, sessionId: session.id, date: session.date, scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 5, operator: "teacher" } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "第一道题需要提醒", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const oldFingerprint = JSON.parse(plan.items[0]!.evidenceSnapshot).sourceFingerprint as string;
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "第三道同类题已经独立完成", rawText: "合成测试" } });
    await invalidateFeedbackPlans({ sessionId: session.id, studentIds: [student.id] });
    generationMocks.generate.mockImplementation(async ({ evidenceBundle }: { evidenceBundle: { teachingEvidence: Array<{ id: string; content: string }> } }) => {
      const modules = evidenceBundle.teachingEvidence.slice(0, 2).map((entry, index) => ({
        key: index === 0 ? "observed_moment" : "teacher_interpretation",
        content: entry.content,
        evidenceRefs: [entry.id],
        status: "included" as const,
        reason: "合成测试",
      }));
      const composition = { version: 1 as const, closureType: "positive_recognition" as const, needParentAction: false, parentAction: null, modules, draftFeedback: "根据最新证据生成的反馈。" };
      return { draftComposition: composition, composition };
    });

    await generateFeedbackPlanItems({ planId: plan.id });
    const refreshed = await getFeedbackPlan(plan.id);
    const evidence = JSON.parse(refreshed!.items[0]!.evidenceSnapshot) as { sourceFingerprint: string; teachingEvidence: Array<{ content: string }> };
    expect(evidence.sourceFingerprint).not.toBe(oldFingerprint);
    expect(evidence.teachingEvidence.map((entry) => entry.content).join(" ")).toContain("第三道同类题已经独立完成");
    expect(refreshed!.items[0]).toMatchObject({ status: "needs_review", student: { id: student.id, name: "失效测试学生" } });
  });

  it("keeps the previous reviewable text when regeneration fails", async () => {
    const classRecord = await prisma.class.create({ data: { code: `${classCode}-FAIL`, name: "生成失败测试班" } });
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-FAIL`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const student = await prisma.student.create({ data: { name: "生成失败学生", studentId: `${studentNumber}-FAIL`, gender: "女", classId: classRecord.id } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-FAIL`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "已确认课堂表现", rawText: "合成测试" } });
    const plan = await createFeedbackPlan({ type: "event_micro", purpose: "测试事件反馈", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const patched = await patchFeedbackPlanItem(plan.items[0]!.id, {
      composition: { version: 1, closureType: "positive_recognition", needParentAction: false, parentAction: null, modules: [
        { key: "observed_moment", content: "已确认课堂表现", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
        { key: "teacher_interpretation", content: "表现较稳定", evidenceRefs: ["current-event-0"], status: "included", reason: "合成测试" },
      ], draftFeedback: "原有待审核文本。" },
      finalText: "原有待审核文本。",
      reviewMode: "teacher_edited",
    });
    await prisma.feedbackPlanItem.update({ where: { id: plan.items[0]!.id }, data: { reviewMode: "model" } });
    generationMocks.generate.mockRejectedValueOnce(new Error("合成模型失败"));

    const progress: Array<{ status?: string; error?: string }> = [];
    await expect(generateFeedbackPlanItems({ planId: plan.id, onProgress: (event) => { progress.push(event); } })).resolves.toEqual([]);
    const restored = await getFeedbackPlan(plan.id);
    expect(restored!.items[0]).toMatchObject({ status: "needs_review", finalText: "原有待审核文本。", finalTextHash: patched.finalTextHash });
    expect(progress).toContainEqual(expect.objectContaining({ status: "error", error: "本条反馈生成失败，已保留原版本，可单独重试" }));
  });

  it("allows an inactive student to be explicitly included with historical evidence", async () => {
    const classRecord = await prisma.class.create({ data: { code: `${classCode}-INACTIVE`, name: "停读学生测试班" } });
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-INACTIVE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const student = await prisma.student.create({ data: { name: "停读测试学生", studentId: `${studentNumber}-INACTIVE`, gender: "男", classId: classRecord.id, rosterStatus: "INACTIVE" } });
    const session = await prisma.classSession.create({ data: { code: `${sessionCode}-INACTIVE`, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01", classId: classRecord.id } });
    const event = await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: "历史范围内的已确认记录", rawText: "合成测试" } });

    const plan = await createFeedbackPlan({ type: "course_end", purpose: "测试阶段范围", semesterId: semester.id, classId: classRecord.id, sessionId: session.id, rangeStartSessionId: session.id, rangeEndSessionId: session.id, studentIds: [student.id] });
    const evidence = JSON.parse(plan.items[0]!.evidenceSnapshot) as { sourceRefs: Array<{ id: string }> };
    expect(plan.items[0]?.student).toMatchObject({ id: student.id, rosterStatus: "INACTIVE" });
    expect(evidence.sourceRefs.some((ref) => ref.id === event.id)).toBe(true);
  });

  it("removes a managed attachment without leaving a database row or private file", async () => {
    const classRecord = await prisma.class.create({ data: { code: `${classCode}-ATTACHMENT`, name: "附件测试班" } });
    const semester = await prisma.semester.create({ data: { name: `${semesterName}-ATTACHMENT`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const student = await prisma.student.create({ data: { name: "附件测试学生", studentId: `${studentNumber}-ATTACHMENT`, gender: "女", classId: classRecord.id } });
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
