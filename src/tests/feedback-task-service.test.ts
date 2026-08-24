import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("@/services/feedback-plan-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/feedback-plan-service")>(),
  startFeedbackPlanGeneration: vi.fn(async () => undefined),
}));

import { createFeedbackTask } from "@/services/feedback-task-service";
import { archiveFeedbackPlan } from "@/services/feedback-plan-service";

const createdRunIds: string[] = [];
const createdPlanIds: string[] = [];

afterEach(async () => {
  await prisma.feedbackIntakeRun.deleteMany({ where: { id: { in: createdRunIds.splice(0) } } });
  await prisma.feedbackPlan.deleteMany({ where: { id: { in: createdPlanIds.splice(0) } } });
});

async function createConfirmedRun() {
  const session = await prisma.classSession.findUniqueOrThrow({
    where: { code: "2026070801" },
    select: { code: true, classId: true, semesterId: true },
  });
  const student = await prisma.student.findFirstOrThrow({
    where: {
      studentId: "E2E-001",
      enrollments: { some: { semesterId: session.semesterId, classId: session.classId!, rosterStatus: "ACTIVE" } },
    },
    select: { id: true },
  });
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

    await archiveFeedbackPlan(first.planId!, prisma);
    const rebuilt = await createFeedbackTask(input, prisma);
    expect(rebuilt.taskType).toBe("plan");
    expect(rebuilt.planId).not.toBe(first.planId);
    createdPlanIds.push(rebuilt.planId!);
    await expect(prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: run.id } })).resolves.toMatchObject({ planId: rebuilt.planId });
  });
});
