import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

const backupMocks = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }));
vi.mock("@/services/database-backup-service", () => ({
  createDatabaseBackup: backupMocks.create,
  verifyDatabaseBackup: backupMocks.verify,
}));

import {
  assertClassAvailable,
  assertFeedbackBatchAvailable,
  moveScopeToRecycleBin,
  purgeExpiredRecycleBin,
  restoreScope,
} from "@/services/academic-scope-recycle-service";

const marker = "VITEST-RECYCLE-SCOPE";

afterEach(async () => {
  delete process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT;
  backupMocks.create.mockReset();
  backupMocks.verify.mockReset();
  const semesters = await prisma.semester.findMany({ where: { name: { startsWith: marker } }, select: { id: true } });
  const semesterIds = semesters.map((item) => item.id);
  if (semesterIds.length) {
    await prisma.feedbackPlan.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.feedbackPlanBatch.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.classSession.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.studentClassEnrollment.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.class.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.semester.deleteMany({ where: { id: { in: semesterIds } } });
  }
  await prisma.student.deleteMany({ where: { studentId: { startsWith: marker } } });
});

describe("academic scope recycle service", () => {
  it("makes a whole multi-class plan unavailable and restores it without changing archive state", async () => {
    const semester = await prisma.semester.create({ data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const [first, second] = await Promise.all([
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-A` } }),
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-B` } }),
    ]);
    const batch = await prisma.feedbackPlanBatch.create({ data: { requestKey: marker, semesterId: semester.id, type: "event_micro", outputRequirement: "测试", status: "running" } });
    await prisma.feedbackPlan.createMany({ data: [
      { type: "event_micro", outputRequirement: "测试", status: "generating", semesterId: semester.id, classId: first.id, inputFingerprint: `${marker}-A`, batchId: batch.id, batchOrder: 1 },
      { type: "event_micro", outputRequirement: "测试", status: "approved", semesterId: semester.id, classId: second.id, inputFingerprint: `${marker}-B`, batchId: batch.id, batchOrder: 2, archivedAt: new Date("2099-01-02") },
    ] });

    await moveScopeToRecycleBin("class", first.id);
    await expect(assertClassAvailable(first.id)).rejects.toMatchObject({ status: 409, code: "scope_in_recycle_bin" });
    await expect(assertFeedbackBatchAvailable(batch.id)).rejects.toMatchObject({ status: 409, code: "scope_in_recycle_bin" });
    await expect(prisma.feedbackPlanBatch.findUnique({ where: { id: batch.id } })).resolves.toMatchObject({ status: "pause_requested", archivedAt: null });
    const archivedBeforeRestore = await prisma.feedbackPlan.findFirst({ where: { batchId: batch.id, classId: second.id }, select: { archivedAt: true } });

    await restoreScope("class", first.id);
    await expect(assertFeedbackBatchAvailable(batch.id)).resolves.toMatchObject({ id: batch.id });
    await expect(prisma.feedbackPlan.findFirst({ where: { batchId: batch.id, classId: second.id }, select: { archivedAt: true } })).resolves.toEqual(archivedBeforeRestore);
  });

  it("restoring a semester does not restore a class deleted independently", async () => {
    const semester = await prisma.semester.create({ data: { name: `${marker}-PARENT`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const klass = await prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-PARENT` } });
    await moveScopeToRecycleBin("class", klass.id);
    await moveScopeToRecycleBin("semester", semester.id);
    await restoreScope("semester", semester.id);
    await expect(prisma.class.findUnique({ where: { id: klass.id }, select: { deletedAt: true } })).resolves.toEqual({ deletedAt: expect.any(Date) });
    await expect(assertClassAvailable(klass.id)).rejects.toMatchObject({ status: 409 });
  });

  it("keeps expired data when the purge backup fails", async () => {
    backupMocks.create.mockRejectedValue(new Error("backup failed"));
    const semester = await prisma.semester.create({ data: { name: `${marker}-EXPIRED`, startDate: "2099-01-01", endDate: "2099-12-31", deletedAt: new Date("2098-01-01") } });

    await expect(purgeExpiredRecycleBin({ now: new Date("2099-01-01") })).rejects.toThrow("backup failed");
    await expect(prisma.semester.findUnique({ where: { id: semester.id } })).resolves.not.toBeNull();
  });

  it("purges the entire affected batch while preserving the other class facts", async () => {
    process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT = "/tmp/student-track-recycle-test-attachments";
    backupMocks.create.mockResolvedValue({ backupPath: "/tmp/test-recycle-backup.db", manifest: { createdAt: "2099-01-01T00:00:00.000Z" } });
    backupMocks.verify.mockResolvedValue({});
    const semester = await prisma.semester.create({ data: { name: `${marker}-PURGE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const [removedClass, retainedClass] = await Promise.all([
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-PURGE-A`, deletedAt: new Date("2098-01-01") } }),
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-PURGE-B` } }),
    ]);
    const [removedSession, retainedSession] = await Promise.all([
      prisma.classSession.create({ data: { semesterId: semester.id, classId: removedClass.id, code: "2099010196", date: "2099-01-01", semesterNumber: 1 } }),
      prisma.classSession.create({ data: { semesterId: semester.id, classId: retainedClass.id, code: "2099010195", date: "2099-01-01", semesterNumber: 1 } }),
    ]);
    const student = await prisma.student.create({ data: { name: "保留班事实学生", studentId: `${marker}-PURGE-STUDENT`, gender: "男" } });
    const retainedEvent = await prisma.event.create({ data: { sessionId: retainedSession.id, studentId: student.id, type: "课堂表现", description: "其他班事实保留", rawText: "合成测试" } });
    const batch = await prisma.feedbackPlanBatch.create({ data: { requestKey: `${marker}-PURGE`, semesterId: semester.id, type: "event_micro", outputRequirement: "测试", status: "completed" } });
    await prisma.feedbackPlan.createMany({ data: [
      { type: "event_micro", outputRequirement: "测试", status: "needs_review", semesterId: semester.id, classId: removedClass.id, sessionId: removedSession.id, inputFingerprint: `${marker}-PURGE-A`, batchId: batch.id, batchOrder: 1 },
      { type: "event_micro", outputRequirement: "测试", status: "approved", semesterId: semester.id, classId: retainedClass.id, sessionId: retainedSession.id, inputFingerprint: `${marker}-PURGE-B`, batchId: batch.id, batchOrder: 2 },
    ] });

    await expect(purgeExpiredRecycleBin({ now: new Date("2099-01-01") })).resolves.toMatchObject({ purgedClasses: 1, backup: { verified: true } });
    await expect(prisma.class.findUnique({ where: { id: removedClass.id } })).resolves.toBeNull();
    await expect(prisma.feedbackPlanBatch.findUnique({ where: { id: batch.id } })).resolves.toBeNull();
    await expect(prisma.feedbackPlan.count({ where: { batchId: batch.id } })).resolves.toBe(0);
    await expect(prisma.class.findUnique({ where: { id: retainedClass.id } })).resolves.not.toBeNull();
    await expect(prisma.classSession.findUnique({ where: { id: retainedSession.id } })).resolves.not.toBeNull();
    await expect(prisma.event.findUnique({ where: { id: retainedEvent.id } })).resolves.not.toBeNull();
  });
});
