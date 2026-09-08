import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { invalidateFeedbackPlans } from "@/services/feedback-plan-invalidation-service";

const marker = "TEST-PLAN-INVALIDATION";

afterEach(async () => {
  await prisma.feedbackPlan.deleteMany({ where: { semester: { name: marker } } });
  await prisma.classSession.deleteMany({ where: { semester: { name: marker } } });
  await prisma.class.deleteMany({ where: { semester: { name: marker } } });
  await prisma.semester.deleteMany({ where: { name: marker } });
  await prisma.student.deleteMany({ where: { studentId: { startsWith: marker } } });
});

async function createLegacyDraft() {
  const semester = await prisma.semester.create({
    data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" },
  });
  const classroom = await prisma.class.create({
    data: { semesterId: semester.id, code: marker, name: "合成测试班" },
  });
  const session = await prisma.classSession.create({
    data: { semesterId: semester.id, classId: classroom.id, code: marker, date: "2099-01-01", semesterNumber: 1 },
  });
  const students = await Promise.all(["张三", "李四"].map((name, index) => prisma.student.create({
    data: { studentId: `${marker}-${index}`, name, gender: "男" },
  })));
  // Historical drafts can predate versioned input snapshots.
  const plan = await prisma.feedbackPlan.create({
    data: {
      semesterId: semester.id, classId: classroom.id, sessionId: session.id,
      type: "event_micro", outputRequirement: "合成测试", inputFingerprint: "test-input",
      status: "ready", items: { create: [...students.map((student) => ({ studentId: student.id })), {}] },
    },
    include: { items: true },
  });
  return { plan, session, students };
}

describe("feedback plan invalidation service", () => {
  it("invalidates the selected student and class item without changing another student's draft", async () => {
    const { plan, session, students } = await createLegacyDraft();
    await expect(invalidateFeedbackPlans({ sessionId: session.id, studentIds: [students[0].id] })).resolves.toBe(2);
    const updated = await prisma.feedbackPlan.findUniqueOrThrow({ where: { id: plan.id }, include: { items: true } });
    expect(updated.status).toBe("stale");
    expect(updated.items.find((item) => item.studentId === students[0].id)?.status).toBe("stale");
    expect(updated.items.find((item) => item.studentId === null)?.status).toBe("stale");
    expect(updated.items.find((item) => item.studentId === students[1].id)?.status).toBe("evidence_ready");
    await expect(invalidateFeedbackPlans({ sessionId: session.id, studentIds: [students[0].id] })).resolves.toBe(0);
  });

  it("keeps plan and item invalidation inside the caller's transaction", async () => {
    const { plan, session } = await createLegacyDraft();
    await expect(prisma.$transaction(async (tx) => {
      expect(await invalidateFeedbackPlans({ sessionId: session.id }, tx)).toBe(3);
      expect((await tx.feedbackPlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("stale");
      throw new Error("test rollback");
    })).rejects.toThrow("test rollback");
    const restored = await prisma.feedbackPlan.findUniqueOrThrow({ where: { id: plan.id }, include: { items: true } });
    expect(restored.status).toBe("ready");
    expect(restored.items.every((item) => item.status === "evidence_ready")).toBe(true);
  });
});
