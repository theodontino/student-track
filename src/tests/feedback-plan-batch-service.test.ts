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
import { buildFeedbackPlanBatchExportWorkbook } from "@/services/feedback-export-service";
import { continueFeedbackPlanBatch, createFeedbackPlanBatch, getFeedbackPlanBatch, pauseFeedbackPlanBatch, retryFeedbackPlanBatch, startFeedbackPlanBatch } from "@/services/feedback-plan-batch-service";
import { confirmGroupLesson, createClassGroup, createGroupLesson, setSessionGroupProgress } from "@/services/group-lesson-service";

const marker = "VITEST-FEEDBACK-BATCH";
let semesterId = "";
let classIds: string[] = [];
let sessionIds: string[] = [];
let studentIds: string[] = [];
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
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
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
    const created = await createFeedbackPlanBatch(input);
    const repeated = await createFeedbackPlanBatch(input);
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
