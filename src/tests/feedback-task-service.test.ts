import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("@/services/feedback-plan-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/feedback-plan-service")>(),
  startFeedbackPlanGeneration: vi.fn(async () => undefined),
}));

import { createFeedbackTask } from "@/services/feedback-task-service";
import { archiveFeedbackPlan } from "@/services/feedback-plan-service";
import { getFeedbackIntakeRun } from "@/services/feedback-intake-service";

const createdRunIds: string[] = [];
const createdPlanIds: string[] = [];
const marker = `feedback-task-${Date.now()}`;
let semesterId = "";
let classId = "";
let sessionCode = "";
let studentId = "";

beforeAll(async () => {
  const semester = await prisma.semester.create({
    data: { name: marker, startDate: "2097-01-01", endDate: "2097-12-31" },
  });
  semesterId = semester.id;
  const classRecord = await prisma.class.create({
    data: { semesterId, code: `${marker}-CLASS`, name: "反馈任务合成班" },
  });
  classId = classRecord.id;
  const student = await prisma.student.create({
    data: {
      name: "反馈任务合成学生",
      studentId: `${marker}-STUDENT`,
      gender: "女",
      enrollments: { create: { semesterId, classId } },
    },
  });
  studentId = student.id;
  const session = await prisma.classSession.create({
    data: { semesterId, classId, code: "2097010101", date: "2097-01-01", semesterNumber: 1 },
  });
  sessionCode = session.code;
});

afterAll(async () => {
  await prisma.feedbackIntakeRun.deleteMany({ where: { sessionCode } });
  await prisma.feedbackPlan.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { semesterId } });
  await prisma.studentClassEnrollment.deleteMany({ where: { semesterId } });
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.class.deleteMany({ where: { semesterId } });
  await prisma.semester.deleteMany({ where: { id: semesterId } });
});

afterEach(async () => {
  await prisma.feedbackIntakeRun.deleteMany({ where: { id: { in: createdRunIds.splice(0) } } });
  await prisma.feedbackPlan.deleteMany({ where: { id: { in: createdPlanIds.splice(0) } } });
});

async function createConfirmedRun() {
  const session = await prisma.classSession.findUniqueOrThrow({
    where: { code: sessionCode },
    select: { code: true, classId: true, semesterId: true },
  });
  const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId }, select: { id: true } });
  const run = await prisma.feedbackIntakeRun.create({
    data: {
      sessionCode: session.code,
      sourceFingerprint: `TASK-${crypto.randomUUID()}`,
      sourceManifest: "[]",
      status: "applied",
      issues: "[]",
      appliedSummary: JSON.stringify({
        applied: true,
        assessmentEvidence: {},
        scopeConfirmation: {
          classId: session.classId,
          sessionCode: session.code,
          studentIds: [student.id],
          confirmedAt: new Date().toISOString(),
        },
      }),
    },
  });
  createdRunIds.push(run.id);
  return run;
}

describe("feedback task service", () => {
  it("returns the same active task for repeated clicks and allows rebuild after archive", async () => {
    const run = await createConfirmedRun();
    const input = {
      mode: "single" as const,
      runIds: [run.id],
      type: "event_micro" as const,
      generationMode: "fast" as const,
      outputRequirement: "固定合成任务",
      materialSelection: { mode: "none" as const },
    };

    const first = await createFeedbackTask(input, prisma);
    expect(first.taskType).toBe("plan");
    expect(first.planId).toBeTruthy();
    createdPlanIds.push(first.planId!);

    const repeated = await createFeedbackTask(input, prisma);
    expect(repeated).toMatchObject({ taskType: "plan", planId: first.planId, generationStatus: "existing" });
    await expect(getFeedbackIntakeRun(run.id, prisma)).resolves.toMatchObject({ planId: first.planId });

    await archiveFeedbackPlan(first.planId!, prisma);
    await expect(getFeedbackIntakeRun(run.id, prisma)).resolves.toMatchObject({ planId: null });
    const rebuilt = await createFeedbackTask(input, prisma);
    expect(rebuilt.taskType).toBe("plan");
    expect(rebuilt.planId).not.toBe(first.planId);
    createdPlanIds.push(rebuilt.planId!);
    await expect(prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: run.id } })).resolves.toMatchObject({ planId: rebuilt.planId });
  });
});
