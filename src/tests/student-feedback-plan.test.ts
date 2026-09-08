vi.mock("@/services/database-backup-service", () => ({
  createDatabaseBackup: async () => ({ backupPath: "synthetic-backup", manifest: { createdAt: "2097-03-01" } }),
  verifyDatabaseBackup: async () => ({}),
}));
import { moveScopeToRecycleBin, purgeExpiredRecycleBin, assertFeedbackPlanAvailable } from "@/services/academic-scope-recycle-service";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createStudentFeedbackPlan, copyHistoricalFeedbackBatch } from "@/services/feedback-plan/student-plan";
import { updateFeedbackPlanDraft, cloneFeedbackPlanDraft } from "@/services/feedback-plan/lifecycle";
import { effectiveFeedbackPlanConfig, parseStudentContext } from "@/services/feedback-plan/model";

const marker = "VITEST-STUDENT-PLAN";
let semesterId = "";
const scopes: Array<{ classId: string; sessionId: string; studentIds: string[]; outputRequirement: string }> = [];
beforeAll(async () => {
  const semester = await prisma.semester.create({ data: { name: marker, startDate: "2097-01-01", endDate: "2097-06-30" } });
  semesterId = semester.id;
  for (let index = 1; index <= 3; index++) {
    const klass = await prisma.class.create({ data: { semesterId, code: `${marker}-${index}`, name: `合成班级${index}` } });
    const session = await prisma.classSession.create({ data: { semesterId, classId: klass.id, code: `2097010${index}01`, date: `2097-01-0${index}`, semesterNumber: 1 } });
    const studentIds = [];
    for (let offset = 1; offset <= (index === 1 ? 28 : 26); offset++) {
      const student = await prisma.student.create({ data: { name: `合成学生${index}-${offset}`, studentId: `${marker}-${index}-${offset}`, gender: "男", enrollments: { create: { semesterId, classId: klass.id } } } });
      await prisma.event.create({ data: { studentId: student.id, sessionId: session.id, type: "课堂表现", description: `学生${index}-${offset}完成订正`, rawText: "合成事实" } });
      studentIds.push(student.id);
    }
    scopes.push({ classId: klass.id, sessionId: session.id, studentIds, outputRequirement: `班级${index}要求` });
  }
});
afterAll(async () => {
  await prisma.feedbackPlan.deleteMany({ where: { semesterId } });
  await prisma.feedbackPlanBatch.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { semesterId } });
  await prisma.student.deleteMany({ where: { studentId: { startsWith: marker } } });
  await prisma.class.deleteMany({ where: { semesterId } });
  await prisma.semester.delete({ where: { id: semesterId } });
});
function input(key: string) { return { requestKey: `${marker}-${key}`, semesterId, type: "event_micro" as const, outputRequirement: "统一要求", scopes }; }

describe("student centered plan", () => {
  it("creates one 80-student plan across three classes with isolated facts and settings", async () => {
    const plan = await createStudentFeedbackPlan(input("CREATE"));
    expect(plan.classId).toBeNull();
    expect(plan.structureVersion).toBe(2);
    expect(plan.items).toHaveLength(80);
    expect(await prisma.feedbackPlan.count({ where: { semesterId } })).toBe(1);
    expect((await createStudentFeedbackPlan(input("CREATE"))).id).toBe(plan.id);
    for (const item of plan.items) {
      const scope = scopes.find((entry) => entry.studentIds.includes(item.studentId!))!;
      expect(parseStudentContext(item.contextSnapshot)?.class.id).toBe(scope.classId);
      expect(item.sessionId).toBe(scope.sessionId);
      expect(effectiveFeedbackPlanConfig(plan, item).outputRequirement).toBe(scope.outputRequirement);
      expect(item.evidenceSnapshot).not.toContain(scopes.find((entry) => entry !== scope)!.studentIds[0]);
    }
  });
  it("restores a deselected student from frozen facts with class and session context", async () => {
    const plan = await createStudentFeedbackPlan(input("SELECT"));
    const reduced = await updateFeedbackPlanDraft(plan.id, { expectedPlanRevision: plan.planRevision, studentIds: scopes[0].studentIds });
    const restored = await updateFeedbackPlanDraft(plan.id, { expectedPlanRevision: reduced.planRevision, studentIds: scopes.flatMap((scope) => scope.studentIds) });
    expect(restored.items).toHaveLength(80);
    expect(restored.items.every((item) => item.classId && item.sessionId && parseStudentContext(item.contextSnapshot))).toBe(true);
  });
  it("copies frozen inputs without student results", async () => {
    const plan = await createStudentFeedbackPlan(input("COPY"));
    await prisma.feedbackPlanItem.updateMany({ where: { planId: plan.id }, data: { status: "approved", finalText: "教师确认内容", approvedAt: new Date() } });
    const copied = await cloneFeedbackPlanDraft({ planId: plan.id });
    expect(copied.items).toHaveLength(80);
    expect(copied.items.every((item) => !item.finalText && !item.approvedAt)).toBe(true);
    expect(parseStudentContext(copied.items[0].contextSnapshot)?.sourcePlanId).toBe(plan.id);
  });
  it("copies a historical batch into one plan and keeps the original read-only", async () => {
    const batch = await prisma.feedbackPlanBatch.create({ data: { requestKey: `${marker}-HISTORY`, semesterId, type: "event_micro", outputRequirement: "历史共同要求" } });
    const { createFeedbackPlan } = await import("@/services/feedback-plan/lifecycle");
    for (const [index, scope] of scopes.entries()) {
      const child = await createFeedbackPlan({ semesterId, ...scope, type: "event_micro" });
      await prisma.feedbackPlan.update({ where: { id: child.id }, data: { structureVersion: 1, batchId: batch.id, batchOrder: index + 1 } });
      await expect(updateFeedbackPlanDraft(child.id, { expectedPlanRevision: child.planRevision, outputRequirement: "不应保存" })).rejects.toMatchObject({ status: 409 });
    }
    const before = await prisma.feedbackPlan.count({ where: { semesterId } });
    const copied = await copyHistoricalFeedbackBatch({ batchId: batch.id, displayName: "历史修订" });
    expect(await prisma.feedbackPlan.count({ where: { semesterId } })).toBe(before + 1);
    expect(copied.batchId).toBeNull();
    expect(copied.items).toHaveLength(80);
    expect(copied.items.every((item) => parseStudentContext(item.contextSnapshot)?.sourcePlanId)).toBe(true);
  });
  it("keeps the other class after permanent deletion and removes its frozen facts", async () => {
    const plan = await createStudentFeedbackPlan(input("PURGE"));
    await moveScopeToRecycleBin("class", scopes[0].classId);
    await expect(assertFeedbackPlanAvailable(plan.id)).rejects.toMatchObject({ code: "scope_in_recycle_bin" });
    await prisma.class.update({ where: { id: scopes[0].classId }, data: { deletedAt: new Date("2097-01-01") } });
    await purgeExpiredRecycleBin({ now: new Date("2097-03-01"), db: prisma });
    const remaining = await prisma.feedbackPlan.findUniqueOrThrow({ where: { id: plan.id }, include: { items: true } });
    expect(remaining.items).toHaveLength(52);
    expect(remaining.items.map((item) => item.studentId)).toEqual(expect.arrayContaining(scopes.slice(1).flatMap((scope) => scope.studentIds)));
    expect(remaining.inputSnapshot).not.toContain(scopes[0].studentIds[0]);
    expect(remaining.inputSnapshot).not.toContain(scopes[0].classId);
    await expect(assertFeedbackPlanAvailable(plan.id)).resolves.toBeTruthy();
  });
});
